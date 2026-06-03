// Pure, deterministic helpers for turning a raw bibliography entry (the full
// "[12] A. Author et al., \"Title,\" Venue, year." string parsed by
// citation-extract-service) into the pieces a Semantic Scholar lookup needs:
//
//   - extractIdentifiers : an embedded DOI / arXiv id, for an exact ID lookup.
//   - extractTitle       : a best-guess title, for the title-match endpoint.
//   - cleanQuery         : a noise-reduced query, for the relevance-search
//                          fallback.
//
// No network, no LLM, no state — kept separate from scholar-lookup-service so
// they can be unit-tested in isolation (mirrors citation-extract-service's
// exported splitReferenceList).

// Drop a leading "[12]" / "12." reference marker and collapse whitespace.
function stripMarker(raw) {
  return String(raw || '')
    .replace(/^\s*\[?\d{1,4}\]?[.)]?\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Tokens that signal we have left the title and entered the venue / volume /
// pages portion of the reference.
const VENUE_CUE =
  /\b(in\s+proc|in\s+proceedings|proceedings|proc\.|journal|trans\.|transactions|conf\.|conference|symposium|workshop|ieee|acm|springer|elsevier|arxiv|preprint|vol\.?|no\.?|pp\.?|pages)\b/i;

// A DOI as it appears in text (without a trailing sentence period). DOIs cannot
// contain whitespace or these delimiters in practice.
const DOI_RE = /\b10\.\d{4,9}\/[^\s"<>,;)\]]+/;

// Pull an embedded DOI / arXiv id out of the raw reference.
function extractIdentifiers(raw) {
  const text = String(raw || '');

  let doi = null;
  const doiMatch = text.match(DOI_RE);
  if (doiMatch) doi = doiMatch[0].replace(/[.,;]+$/, '');

  let arxiv = null;
  const arxivNew = text.match(/arxiv:\s*(\d{4}\.\d{4,5})(v\d+)?/i);
  if (arxivNew) {
    arxiv = arxivNew[1] + (arxivNew[2] || '');
  } else {
    const arxivOld = text.match(/arxiv:\s*([a-z][a-z.\-]+\/\d{7})(v\d+)?/i);
    if (arxivOld) arxiv = arxivOld[1] + (arxivOld[2] || '');
  }

  return { doi, arxiv };
}

// Accept a candidate only if it reads like a title (not a stray initial / page
// number). Trims trailing punctuation/whitespace first.
function plausibleTitle(s) {
  if (!s) return null;
  const t = String(s).replace(/\s+/g, ' ').trim().replace(/[.,;:\s]+$/, '');
  if (t.length < 16 || t.length > 250) return null;
  return t;
}

// Take text up to the first venue cue, or the first real sentence break,
// whichever comes first. The sentence-break pattern requires a lowercase letter
// or digit before the period so it does not split on author initials ("A. B.").
function sliceToVenueOrPeriod(s) {
  let end = s.length;

  const venue = s.search(VENUE_CUE);
  if (venue > 0) end = Math.min(end, venue);

  const period = s.slice(0, end).search(/[a-z0-9)]\.\s+[A-Z]/);
  if (period > 0) end = Math.min(end, period + 1);

  return s.slice(0, end);
}

// Remove a leading author block so what remains starts at the title. Returns the
// original string unchanged when no author pattern is recognised (the caller
// treats "unchanged" as "couldn't isolate authors").
function stripLeadingAuthors(text) {
  // "et al." strongly marks the end of the author list.
  const etAl = text.match(/\bet\s+al\.?\s*[,.]?\s*/i);
  if (etAl && etAl.index < 120) return text.slice(etAl.index + etAl[0].length);

  // Comma-initials list: "Smith, J. A., Doe, B., and Roe, C. ...". Strip the
  // run of "Lastname, I. I." groups joined by commas / "and" / "&" / ";".
  const re =
    /^\s*(?:[A-Z][\p{L}'’\-]+(?:\s+[A-Z][\p{L}'’\-]+)*,\s*(?:[A-Z]\.[\s-]*)+(?:,\s*|\s*(?:and|&)\s*|;\s*)?)+/u;
  const m = text.match(re);
  if (m && m[0].length >= 4 && m[0].length < text.length) return text.slice(m[0].length);

  return text;
}

// Best-guess title from a raw reference, or null when no strategy is confident
// (the caller then falls back to an LLM parse and/or the cleaned-query search).
function extractTitle(raw) {
  const text = stripMarker(raw);
  if (!text) return null;

  // (a) Quoted span — IEEE/ACM put the title in quotes:
  //     A. Author, "Title of the work," Venue, year.
  const quoted = text.match(/["“«]([^"”»]{15,})["”»]/);
  if (quoted) {
    const t = plausibleTitle(quoted[1]);
    if (t) return t;
  }

  // (b) After a year token — APA/ACM/Springer: "... (2021). Title. Venue ...",
  //     "... 2021. Title. Venue ...", or "... (2019) Title. Venue ...". A
  //     parenthesised year may omit the trailing period; a bare year requires
  //     one (so a stray volume/year mid-citation doesn't trigger).
  const year = text.match(/(?:\((?:19|20)\d{2}[a-z]?\)\.?|(?:19|20)\d{2}[a-z]?\.)\s+/);
  if (year) {
    const t = plausibleTitle(sliceToVenueOrPeriod(text.slice(year.index + year[0].length)));
    if (t) return t;
  }

  // (c) "Authors. Title. Venue" — strip the author block, then take up to the
  //     first venue cue / sentence break. Only trusted when authors were
  //     actually recognised, to avoid handing an author-laden string to the
  //     title-match endpoint.
  const afterAuthors = stripLeadingAuthors(text);
  if (afterAuthors !== text) {
    const t = plausibleTitle(sliceToVenueOrPeriod(afterAuthors));
    if (t) return t;
  }

  return null;
}

// Noise-reduced query for the relevance-search fallback: drop identifiers,
// URLs, page ranges, volume/issue, and parenthesised years, which all dilute
// the relevance ranking.
function cleanQuery(raw) {
  let q = stripMarker(raw);
  q = q.replace(/https?:\/\/\S+/gi, ' ');
  q = q.replace(/\bdoi:\s*\S+/gi, ' ');
  q = q.replace(new RegExp(DOI_RE.source, 'g'), ' ');
  q = q.replace(/\bpp?\.\s*\d+\s*[-–—]\s*\d+/gi, ' ');
  q = q.replace(/\b(?:vol|no)\.?\s*\d+/gi, ' ');
  q = q.replace(/\(\s*(?:19|20)\d{2}[a-z]?\s*\)/g, ' ');
  q = q.replace(/(?:\s*,\s*){2,}/g, ', '); // collapse comma runs left by removals
  q = q.replace(/\s+/g, ' ').trim();
  return q.slice(0, 300);
}

module.exports = { stripMarker, extractIdentifiers, extractTitle, cleanQuery };
