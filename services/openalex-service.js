// Fallback metadata source for abstracts the Semantic Scholar Graph API can't
// return. S2 only serves abstracts it is licensed to redistribute, so for many
// closed-access publishers (Elsevier, Wiley, Science, ...) its API returns
// `abstract: null` even though the S2 website still shows the abstract. OpenAlex
// is free / no-key and exposes abstracts as an inverted index we reconstruct.
//
// Runs in the main process (via api-stub), so the global `fetch` reaches the
// network without CORS — same as scholar-lookup-service's S2 call.

const OPENALEX_WORKS = 'https://api.openalex.org/works';

// Rebuild plain abstract text from OpenAlex's `abstract_inverted_index`
// ({ word: [positions...] }). Pure; returns '' when absent/malformed. Exported
// for unit testing.
function invertedIndexToText(idx) {
  if (!idx || typeof idx !== 'object') return '';
  const words = [];
  for (const word of Object.keys(idx)) {
    const positions = idx[word];
    if (Array.isArray(positions)) for (const p of positions) words[p] = word;
  }
  return words.join(' ').replace(/\s+/g, ' ').trim();
}

// Fetch and reconstruct a work's abstract from OpenAlex by DOI. Returns the
// abstract string, or '' when there's no DOI, no record, or no abstract. Never
// throws — the abstract is a best-effort enrichment.
async function fetchAbstractByDoi(doi) {
  if (!doi) return '';
  try {
    // Encode the DOI but keep slashes literal, as OpenAlex expects in the path.
    const encId = encodeURIComponent(doi).replace(/%2F/gi, '/');
    const url = `${OPENALEX_WORKS}/doi:${encId}?select=abstract_inverted_index`;
    const resp = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!resp.ok) return '';
    const data = await resp.json();
    return invertedIndexToText(data?.abstract_inverted_index);
  } catch {
    return '';
  }
}

module.exports = { invertedIndexToText, fetchAbstractByDoi };
