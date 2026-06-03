// Heuristically split a paper's end-of-document reference list into per-number
// entries, so an in-text "[12]" can be mapped to the raw reference text (for
// metadata lookup) and to the page it appears on (for jump-to-reference). No
// LLM: deterministic, handles long bibliographies, and avoids the Anthropic
// 1024-token output cap.
//
// The stored document text (document-store) is space-joined per page with no
// intra-page newlines, so parsing keys off the "[N]" / "N." tokens themselves
// rather than line starts.

const { getDocumentStore } = require('./document-store');
const { getCitationsStore } = require('./citations-store');

const HEADING_RE = /\b(references|bibliography|works cited|literature cited)\b/gi;
const APPENDIX_RE = /\b(appendix|appendices|supplementary (?:material|information))\b/i;

// Concatenate pages in numeric order (newline-separated) and build a
// char-offset -> page map so an entry's position can be resolved to a page.
function buildFullText(pages) {
  const sorted = Object.keys(pages).sort((a, b) => Number(a) - Number(b));
  let full = '';
  const ranges = [];
  for (const k of sorted) {
    const t = pages[k] || '';
    const start = full.length;
    full += `${t}\n`;
    ranges.push({ page: Number(k), start, end: full.length });
  }
  return { full, ranges };
}

function pageForOffset(ranges, offset) {
  for (const r of ranges) if (offset >= r.start && offset < r.end) return r.page;
  return ranges.length ? ranges[ranges.length - 1].page : null;
}

// End offsets of every "References"/"Bibliography"/... heading match.
function headingEnds(full) {
  const ends = [];
  let m;
  HEADING_RE.lastIndex = 0;
  while ((m = HEADING_RE.exec(full)) !== null) ends.push(m.index + m[0].length);
  return ends;
}

// Slice from a heading to the end, trimming a clearly-following appendix.
function sectionFrom(full, end) {
  let section = full.slice(end);
  const ap = section.search(APPENDIX_RE);
  if (ap > 200) section = section.slice(0, ap);
  return section;
}

// Find every "[N]" or "N." marker (per the supplied regex, capture group 1 =
// number) with its character span within `text`.
function findNumberedMarkers(text, regex) {
  const markers = [];
  let m;
  regex.lastIndex = 0;
  while ((m = regex.exec(text)) !== null) {
    markers.push({ num: parseInt(m[1], 10), start: m.index, end: m.index + m[0].length });
  }
  return markers;
}

// Keep only the contiguous chain 1, 2, 3, ... K (skipping stray markers that
// break the increment, e.g. a "[2020]" year inside an entry), then slice the
// raw text between consecutive chain markers. Each entry carries `start` (the
// marker's offset within `text`) for page resolution.
function buildEntriesFromMarkers(text, markers) {
  const startIdx = markers.findIndex((mk) => mk.num === 1);
  if (startIdx === -1) return [];
  const seq = [markers[startIdx]];
  let expected = 2;
  for (let i = startIdx + 1; i < markers.length; i++) {
    if (markers[i].num === expected) {
      seq.push(markers[i]);
      expected++;
    }
  }
  if (seq.length < 3) return [];
  const entries = [];
  for (let i = 0; i < seq.length; i++) {
    const from = seq[i].end;
    const to = i + 1 < seq.length ? seq[i + 1].start : text.length;
    const raw = text.slice(from, to).replace(/\s+/g, ' ').trim();
    if (raw) entries.push({ number: seq[i].num, raw, start: seq[i].start });
  }
  return entries;
}

// Pure function (exported for unit testing): turn a reference-section string
// into [{ number, raw, start }]. Tries bracketed "[N]" style first, then a
// plain "N." numbered style. Returns [] when neither yields a contiguous run of
// >= 3 starting at 1.
function splitReferenceList(text) {
  if (!text || typeof text !== 'string') return [];

  const bracket = buildEntriesFromMarkers(text, findNumberedMarkers(text, /\[(\d{1,4})\]/g));
  if (bracket.length >= 3) return bracket;

  // "N." style: number, period, whitespace, then the start of an author/title
  // (uppercase letter or an opening quote/paren). The lookahead is zero-width
  // so the following char stays in the entry text.
  const dotted = buildEntriesFromMarkers(
    text,
    findNumberedMarkers(text, /(?:^|\s)(\d{1,3})\.\s+(?=[A-Z("'[])/g),
  );
  if (dotted.length >= 3) return dotted;

  return [];
}

// Pick the reference section + entries from a document. A paper can contain the
// word "References"/"Bibliography" inside a cited title or venue, so the LAST
// heading match isn't necessarily the real one. Try every candidate and keep
// the one that yields the most entries (the real list runs [1..K]); tie-break
// toward the later heading to avoid an in-body mention picking up body text.
function bestReferenceSection(full) {
  const ends = headingEnds(full);
  let best = { entries: [], end: -1 };
  for (const end of ends) {
    const entries = splitReferenceList(sectionFrom(full, end));
    if (
      entries.length > best.entries.length ||
      (entries.length === best.entries.length && entries.length > 0 && end > best.end)
    ) {
      best = { entries, end };
    }
  }
  return best;
}

// Extract + cache the numbered reference list for a PDF. Idempotent: returns
// the cached entries if already parsed. Returns a summary the renderer uses to
// (a) decide which in-text "[N]" to make clickable and (b) map a number to its
// page for jump-to-reference.
async function extractCitations({ pdfIdentifier }) {
  if (!pdfIdentifier) return { numbers: [], pages: {}, count: 0, status: 'no_pdf' };

  const store = getCitationsStore();
  const existing = await store.get(pdfIdentifier);
  if (existing && Array.isArray(existing.entries) && existing.entries.length > 0) {
    return summarize(existing.entries, 'ok');
  }

  const pages = await getDocumentStore().loadDocumentText(pdfIdentifier);
  if (!pages) return { numbers: [], pages: {}, count: 0, status: 'no_text' };

  const { full, ranges } = buildFullText(pages);
  if (headingEnds(full).length === 0) {
    return { numbers: [], pages: {}, count: 0, status: 'no_references_section' };
  }

  const best = bestReferenceSection(full);
  if (best.entries.length === 0) return { numbers: [], pages: {}, count: 0, status: 'no_entries' };

  const entries = best.entries.map((e) => ({
    number: e.number,
    raw: e.raw.slice(0, 800),
    page: pageForOffset(ranges, best.end + e.start),
  }));

  await store.saveEntries(pdfIdentifier, entries);
  return summarize(entries, 'ok');
}

function summarize(entries, status) {
  const pages = {};
  for (const e of entries) pages[e.number] = e.page ?? null;
  return { numbers: entries.map((e) => e.number), pages, count: entries.length, status };
}

module.exports = { extractCitations, splitReferenceList };
