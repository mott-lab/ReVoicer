// Look up a single numbered reference's metadata (title, authors, abstract,
// year, venue, DOI) from the Semantic Scholar Graph API and cache it per PDF.
//
// Runs in the main process (via api-stub), so the global `fetch` reaches the
// network without CORS — same as llm-service's Ollama call. Google Scholar has
// no API, so we use Semantic Scholar (which exposes abstracts) and include a
// plain scholar.google.com search URL as a manual-fallback link.
//
// Matching strategy (each step reuses the same FIELDS + normalizePaper, and
// stops at the first hit):
//   1. Identifier-direct  — if the reference embeds a DOI / arXiv id, look it up
//                           exactly via /paper/{DOI:…|ARXIV:…}.
//   2. Title-match        — feed an extracted title (heuristic, with an optional
//                           LLM fallback) to /paper/search/match, which is built
//                           for "given a citation, find the paper".
//   3. Relevance search   — the original /paper/search, but with a cleaned query.
//
// The full chain runs only when an API key is configured; without a key we make
// exactly one request (the single best strategy) to stay within the shared
// keyless rate budget and avoid 429s.

const { getCitationsStore } = require('./citations-store');
const { getSettingsStore } = require('./settings-store');
const { extractCitations } = require('./citation-extract-service');
const { stripMarker, extractIdentifiers, extractTitle, cleanQuery } = require('./reference-parse');
const { fetchAbstractByDoi } = require('./openalex-service');

const S2_BASE = 'https://api.semanticscholar.org/graph/v1';
const FIELDS = 'title,authors,year,venue,abstract,externalIds,url';

function googleScholarUrl(q) {
  return `https://scholar.google.com/scholar?q=${encodeURIComponent(q)}`;
}

function s2Headers(apiKey) {
  const headers = { Accept: 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  return headers;
}

// GET against the S2 graph API. Returns parsed JSON on 200, null on 404 (the
// API's "no match" signal), and throws (with err.status) otherwise so a 429
// rate limit surfaces to the caller.
async function s2Get(url, apiKey) {
  const resp = await fetch(url, { headers: s2Headers(apiKey) });
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const err = new Error(`Semantic Scholar error ${resp.status}: ${text.slice(0, 200)}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

// Direct lookup by typed external id. `prefix` is "DOI" / "ARXIV"; the id is
// URL-encoded except for slashes, which S2 expects literally in the DOI path.
async function lookupByExternalId(prefix, id, apiKey) {
  const encId = encodeURIComponent(id).replace(/%2F/gi, '/');
  const url = `${S2_BASE}/paper/${prefix}:${encId}?fields=${encodeURIComponent(FIELDS)}`;
  const paper = await s2Get(url, apiKey); // the paper object directly, or null
  return paper && paper.title ? paper : null;
}

// Title-match endpoint: the single best title match (carries `matchScore`).
async function matchByTitle(title, apiKey) {
  const url = `${S2_BASE}/paper/search/match?query=${encodeURIComponent(title)}&fields=${encodeURIComponent(FIELDS)}`;
  const data = await s2Get(url, apiKey); // 404 -> null (no title match)
  const arr = data && Array.isArray(data.data) ? data.data : [];
  return arr.length ? arr[0] : null;
}

// Relevance search (the original strategy), fed a cleaned query.
async function searchRelevance(query, apiKey) {
  if (!query) return null;
  const url = `${S2_BASE}/paper/search?limit=1&fields=${encodeURIComponent(FIELDS)}&query=${encodeURIComponent(query)}`;
  const data = await s2Get(url, apiKey);
  const arr = data && Array.isArray(data.data) ? data.data : [];
  return arr.length ? arr[0] : null;
}

// Map an S2 paper object (same shape from all three endpoints) to the stored
// result. Shape is a superset of the previous result, so content.js and the
// cache stay compatible; `match_strategy` / `match_score` are added for
// transparency.
function normalizePaper(paper, { number, raw, gsUrl, strategy }) {
  const doi = paper.externalIds?.DOI || null;
  return {
    status: 'ok',
    number: Number(number),
    raw,
    title: paper.title || '',
    authors: Array.isArray(paper.authors) ? paper.authors.map((a) => a.name).filter(Boolean) : [],
    year: paper.year || null,
    venue: paper.venue || '',
    abstract: paper.abstract || '',
    // 'semantic_scholar' when S2 supplied the abstract; otherwise left null for
    // ensureAbstract to fill ('openalex') or mark exhausted ('none').
    abstract_source: paper.abstract ? 'semantic_scholar' : null,
    doi,
    url: paper.url || (doi ? `https://doi.org/${doi}` : null),
    google_scholar_url: gsUrl,
    source: 'semantic_scholar',
    match_strategy: strategy,
    match_score: typeof paper.matchScore === 'number' ? paper.matchScore : null,
  };
}

// Fill a missing abstract from OpenAlex (S2's API withholds abstracts for many
// closed-access publishers). Attempt-once: `abstract_source` is always set
// afterwards ('openalex' on success, 'none' when no source has it) so a paper
// without an abstract isn't re-requested on every modal open. `refDoi` is the
// DOI parsed from the raw reference, used when S2's matched record lacks one.
async function ensureAbstract(result, refDoi) {
  if (!result || result.status !== 'ok') return result;
  if (result.abstract) {
    result.abstract_source = result.abstract_source || 'semantic_scholar';
    return result;
  }
  if (result.abstract_source) return result; // already attempted
  const doi = result.doi || refDoi || null;
  const abstract = doi ? await fetchAbstractByDoi(doi) : '';
  if (abstract) {
    result.abstract = abstract;
    result.abstract_source = 'openalex';
  } else {
    result.abstract_source = 'none';
  }
  return result;
}

// Ask the configured LLM to parse one reference into structured fields. Used
// only as a title fallback when the deterministic extractor can't isolate one.
// Returns { title, doi } (either may be null); never throws.
async function llmParseReference(reference) {
  try {
    const { chat, parseJsonResponse } = require('./llm-service');
    const system =
      'You extract bibliographic fields from a single academic reference string. '
      + 'Return ONLY strict minified JSON with keys: '
      + 'title (string), authors (array of strings), year (number or null), doi (string or null). '
      + 'No commentary.';
    const content = await chat({ system, user: reference, temperature: 0 });
    const parsed = parseJsonResponse(content);
    if (!parsed || typeof parsed !== 'object') return { title: null, doi: null };
    const title = typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : null;
    let doi = null;
    if (typeof parsed.doi === 'string') {
      const m = parsed.doi.match(/\b10\.\d{4,9}\/[^\s"<>,;)\]]+/);
      if (m) doi = m[0].replace(/[.,;]+$/, '');
    }
    return { title, doi };
  } catch {
    return { title: null, doi: null }; // LLM is optional; degrade gracefully
  }
}

async function lookupCitation({ pdfIdentifier, number }) {
  if (!pdfIdentifier || number == null) {
    return { status: 'error', message: 'pdf_identifier and number are required' };
  }
  const store = getCitationsStore();

  // Ensure the numbered reference list exists (the renderer normally extracts
  // it on PDF load; this is a defensive fallback).
  let record = await store.get(pdfIdentifier);
  if (!record || !Array.isArray(record.entries) || record.entries.length === 0) {
    await extractCitations({ pdfIdentifier });
    record = await store.get(pdfIdentifier);
  }

  const key = String(number);
  // Serve a cached result, but allow retry of a previously errored lookup.
  const cached = record?.lookups?.[key];
  if (cached && cached.status !== 'error') {
    // Backfill abstracts for entries cached before the OpenAlex fallback existed
    // (they lack `abstract_source`). Attempt-once, and only when a DOI is known.
    if (cached.status === 'ok' && !cached.abstract && !cached.abstract_source && cached.doi) {
      await ensureAbstract(cached, null);
      await store.saveLookup(pdfIdentifier, number, cached);
    }
    return cached;
  }

  const entry = record?.entries?.find((e) => String(e.number) === key);
  if (!entry) {
    const result = { status: 'not_found', number: Number(number), raw: '' };
    await store.saveLookup(pdfIdentifier, number, result);
    return result;
  }

  const raw = entry.raw || '';
  const cleaned = stripMarker(raw);
  const gsUrl = googleScholarUrl(cleaned || raw);

  if (!cleaned) {
    const result = { status: 'not_found', number: Number(number), raw, google_scholar_url: gsUrl };
    await store.saveLookup(pdfIdentifier, number, result);
    return result;
  }

  const settings = getSettingsStore().get();
  const apiKey = (settings.semantic_scholar_api_key || '').trim();
  const llmEnabled = settings.cleanup_enabled !== false;

  // Parse identifiers up front. A title is only needed when a title-based
  // strategy will actually run: always when there's no identifier, and also as
  // a fallback after an identifier miss when an API key allows the full chain.
  let { doi, arxiv } = extractIdentifiers(raw);
  const hasId = !!(doi || arxiv);
  const titleNeeded = !hasId || !!apiKey;

  let title = titleNeeded ? extractTitle(raw) : null;
  if (titleNeeded && !title && llmEnabled) {
    const parsed = await llmParseReference(cleaned);
    if (parsed.title) title = parsed.title;
    if (!doi && parsed.doi) doi = parsed.doi;
  }

  // Build the strategy chain; stop at the first hit. Keyless callers run only
  // the single best strategy to stay within the shared rate budget.
  const strategies = [];
  if (doi) strategies.push({ name: 'doi', run: () => lookupByExternalId('DOI', doi, apiKey) });
  else if (arxiv) strategies.push({ name: 'arxiv', run: () => lookupByExternalId('ARXIV', arxiv, apiKey) });
  if (title) strategies.push({ name: 'title_match', run: () => matchByTitle(title, apiKey) });
  strategies.push({ name: 'relevance', run: () => searchRelevance(cleanQuery(raw), apiKey) });

  const attempts = apiKey ? strategies : strategies.slice(0, 1);

  try {
    for (const strat of attempts) {
      const paper = await strat.run();
      if (paper) {
        const result = normalizePaper(paper, { number, raw, gsUrl, strategy: strat.name });
        // `doi` is the identifier parsed from the raw reference — used when the
        // matched S2 record itself carries no DOI.
        await ensureAbstract(result, doi);
        await store.saveLookup(pdfIdentifier, number, result);
        return result;
      }
    }
  } catch (err) {
    // Don't cache transient failures (network / rate limit) — let the user retry.
    const rateLimited = err.status === 429;
    const message = rateLimited
      ? 'Semantic Scholar rate limit reached. Add an API key in Settings, or wait a minute and retry.'
      : (err.message || String(err));
    return {
      status: 'error',
      number: Number(number),
      raw,
      google_scholar_url: gsUrl,
      rate_limited: rateLimited,
      message,
    };
  }

  const result = { status: 'not_found', number: Number(number), raw, google_scholar_url: gsUrl };
  await store.saveLookup(pdfIdentifier, number, result);
  return result;
}

module.exports = { lookupCitation };
