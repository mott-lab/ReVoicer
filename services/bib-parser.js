// Minimal, dependency-free BibTeX parser. Parses the common shapes a
// reference manager exports (e.g. Zotero Better BibTeX): @type{key, field =
// {braced} | "quoted" | bare, ...} with nested braces and # concatenation.
// @comment/@preamble/@string blocks are skipped. Malformed entries are
// skipped and counted rather than failing the whole file — parseBibtex never
// throws. No LaTeX accent decoding; only braces are stripped and a few
// trivial escapes unescaped.

const SKIP_TYPES = new Set(['comment', 'preamble', 'string']);

function isIdentChar(ch) {
  return /[A-Za-z0-9_\-:.]/.test(ch);
}

// Consume a balanced {...} or (...) group starting at text[i] (the opener).
// Returns the index just past the closer. Throws on EOF.
function skipBalanced(text, i) {
  const open = text[i];
  const close = open === '{' ? '}' : ')';
  let depth = 0;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error('unbalanced group');
}

function skipWs(text, i) {
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

// Parse one value part: {braced}, "quoted", or bare word/number. Returns
// { value, next }. Throws on EOF/unbalanced input.
function parseValuePart(text, i) {
  const ch = text[i];
  if (ch === '{') {
    let depth = 0;
    const start = i;
    for (; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) return { value: text.slice(start + 1, i), next: i + 1 };
      }
    }
    throw new Error('unbalanced braces in value');
  }
  if (ch === '"') {
    // Track brace depth so a brace-protected quote ({"}) doesn't end the string.
    let depth = 0;
    const start = i;
    i++;
    for (; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
      else if (text[i] === '"' && depth === 0) return { value: text.slice(start + 1, i), next: i + 1 };
    }
    throw new Error('unterminated quoted value');
  }
  // Bare number or macro name.
  const start = i;
  while (i < text.length && !/[\s,})#]/.test(text[i])) i++;
  if (i === start) throw new Error('empty value');
  return { value: text.slice(start, i), next: i };
}

// Parse a full field value including # concatenation.
function parseValue(text, i) {
  let value = '';
  for (;;) {
    i = skipWs(text, i);
    const part = parseValuePart(text, i);
    value += part.value;
    i = skipWs(text, part.next);
    if (text[i] !== '#') break;
    i++;
  }
  return { value, next: i };
}

// Strip braces, collapse whitespace, unescape trivial LaTeX escapes.
function cleanValue(v) {
  return v
    .replace(/[{}]/g, '')
    .replace(/\\([&%$#_])/g, '$1')
    .replace(/~/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Parse one @entry starting at the '@'. Returns { entry|null, next }.
// entry is null for skipped block types. Throws on malformed input.
function parseEntry(text, i) {
  i++; // past '@'
  const typeStart = i;
  while (i < text.length && /[A-Za-z]/.test(text[i])) i++;
  const type = text.slice(typeStart, i).toLowerCase();
  if (!type) throw new Error('missing entry type');
  i = skipWs(text, i);
  if (text[i] !== '{' && text[i] !== '(') throw new Error('missing entry opener');

  if (SKIP_TYPES.has(type)) {
    return { entry: null, next: skipBalanced(text, i) };
  }

  const close = text[i] === '{' ? '}' : ')';
  i = skipWs(text, i + 1);

  // Cite key: up to the first comma (or the closer for a keyless entry).
  const keyStart = i;
  while (i < text.length && text[i] !== ',' && text[i] !== close) i++;
  if (i >= text.length) throw new Error('unterminated entry');
  const key = text.slice(keyStart, i).trim();

  const fields = {};
  while (i < text.length) {
    // Skip commas/whitespace between fields.
    while (i < text.length && (text[i] === ',' || /\s/.test(text[i]))) i++;
    if (text[i] === close) return { entry: { type, key, fields }, next: i + 1 };
    const nameStart = i;
    while (i < text.length && isIdentChar(text[i])) i++;
    const name = text.slice(nameStart, i).toLowerCase();
    if (!name) throw new Error('missing field name');
    i = skipWs(text, i);
    if (text[i] !== '=') throw new Error(`missing = after field "${name}"`);
    const parsed = parseValue(text, i + 1);
    fields[name] = cleanValue(parsed.value);
    i = parsed.next;
  }
  throw new Error('unterminated entry');
}

// Parse a whole .bib file. Returns { entries, skipped } where skipped counts
// entries dropped for being malformed (skipped block types are not counted).
function parseBibtex(text) {
  const entries = [];
  let skipped = 0;
  let i = 0;
  while (i < text.length) {
    i = text.indexOf('@', i);
    if (i === -1) break;
    try {
      const { entry, next } = parseEntry(text, i);
      if (entry) entries.push(entry);
      i = next;
    } catch {
      skipped++;
      // Resync at the next entry start on its own line.
      const resync = text.indexOf('\n@', i);
      if (resync === -1) break;
      i = resync + 1;
    }
  }
  return { entries, skipped };
}

module.exports = { parseBibtex };
