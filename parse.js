// parse.js — a dependency-free Markdown renderer whose output matches
// marked 18.1.3 with default options (GFM on) byte for byte, written as a
// hand-rolled scanner: blocks are recognised line by line, inline markup
// is resolved in a single pass with an explicit delimiter stack.
//
// The document is parsed in two phases. The block phase produces block
// nodes and collects link reference definitions on the way (a definition
// may appear after its uses, and definitions inside quotes and lists
// register for the whole document). The render phase walks the nodes
// and runs the inline parser over heading / paragraph / table text.

// ---------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------

const ESCAPABLE = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

// Escape the five HTML-sensitive characters. When `encode` is false an
// ampersand that already introduces a character reference (&#1;, &#x1f;
// or &name;) is left alone, which is how marked treats running text.
const HTML_SPECIAL_RE = /[&<>"']/;
function escapeHtml(text, encode) {
  if (!HTML_SPECIAL_RE.test(text)) return text;
  let out = '';
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    let rep = null;
    if (ch === '&') {
      if (encode || !/^(?:#\d{1,7};|#[xX][0-9A-Fa-f]{1,6};|\w+;)/.test(text.slice(i + 1, i + 34))) rep = '&amp;';
    } else if (ch === '<') rep = '&lt;';
    else if (ch === '>') rep = '&gt;';
    else if (ch === '"') rep = '&quot;';
    else if (ch === "'") rep = '&#39;';
    if (rep !== null) {
      out += text.slice(last, i) + rep;
      last = i + 1;
    }
  }
  return last === 0 ? text : out + text.slice(last);
}

// marked renders a link destination through encodeURI and then undoes
// the %-escaping of literal percent signs that were already encoded.
// An href encodeURI cannot handle makes the link render as plain
// content, signalled here by null.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Decode one numeric character reference body ("123" or "x1F600") the
// way the HTML spec demands: NUL, surrogates and values past U+10FFFF
// become U+FFFD.
function numericRefChar(body) {
  let cp;
  if (body[0] === 'x' || body[0] === 'X') cp = parseInt(body.slice(1), 16);
  else cp = parseInt(body, 10);
  if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
  return String.fromCodePoint(cp);
}

// Marked's Ie() transform on text tokens: when the text contains at
// least one valid numeric character reference, decode all of them
// (NUL, surrogates and values past U+10FFFF become U+FFFD; a decoded
// ampersand stays escaped as &amp;) and escape every other bare
// ampersand that does not introduce a character reference.
const NUMERIC_REF_RE = /&#(?:\d{1,7}|[Xx][0-9A-Fa-f]{1,6});/;
function ieDecode(text) {
  if (!NUMERIC_REF_RE.test(text)) return text;
  return text.replace(
    /&#(?:(\d{1,7})|[Xx]([0-9A-Fa-f]{1,6}));|&(?!(?:#\d{1,7}|#[Xx][0-9A-Fa-f]{1,6}|\w+);)/g,
    (m, dec, hex) => {
      if (dec === undefined && hex === undefined) return '&amp;';
      const cp = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
      if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
      if (cp === 38) return '&amp;';
      return String.fromCodePoint(cp);
    });
}

// The label a reference link is stored and looked up under: trimmed,
// whitespace runs collapsed to one space, case folded (through an
// upper-case round trip, as marked does it).
function normaliseLabel(raw) {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Resolve backslash escapes of punctuation only (no entity decoding);
// used for link destinations, titles and fence info strings.
function resolveBackslashEscapes(raw) {
  if (!raw.includes('\\')) return raw;
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\' && i + 1 < raw.length && ESCAPABLE.includes(raw[i + 1])) {
      out += raw[i + 1];
      i += 1;
    } else out += raw[i];
  }
  return out;
}

// marked's trailing-blank trim for code and HTML block raw text: if
// more than two line slots trail the last non-blank line, the raw is
// cut back to that line.
function trimTrailingBlanks(raw) {
  const lines = raw.split('\n');
  let last = lines.length - 1;
  while (last >= 0 && /^[ \t]*$/.test(lines[last])) last -= 1;
  if (lines.length - last <= 2) return raw;
  return lines.slice(0, last + 1).join('\n');
}

// ---------------------------------------------------------------------
// Line utilities. Columns follow the CommonMark convention: a tab
// advances to the next multiple of four.
// ---------------------------------------------------------------------

function lineEnd(src, pos) {
  const nl = src.indexOf('\n', pos);
  return nl === -1 ? src.length : nl;
}

// Columns of indentation at the start of a line, and how many source
// characters that indentation occupies.
function measureIndent(line) {
  let cols = 0;
  let chars = 0;
  while (chars < line.length) {
    const ch = line[chars];
    if (ch === ' ') { cols += 1; chars += 1; }
    else if (ch === '\t') { cols += 4 - (cols % 4); chars += 1; }
    else break;
  }
  return { cols, chars };
}

// Remove `cols` columns of leading whitespace from a string whose
// first character sits at column `baseCol`. A tab that is only partly
// consumed leaves the rest of its width behind as spaces, and any tabs
// still in the leading whitespace afterwards are expanded to the width
// they had at their original column, so column counts stay exact.
// Tabs past the first non-whitespace character are content and are
// left untouched.
function dropColumns(s, baseCol, cols) {
  let col = baseCol;
  let i = 0;
  let remaining = cols;
  let pad = 0;
  while (i < s.length && remaining > 0) {
    const ch = s[i];
    if (ch === ' ') { col += 1; i += 1; remaining -= 1; }
    else if (ch === '\t') {
      const width = 4 - (col % 4);
      if (width <= remaining) { col += width; i += 1; remaining -= width; }
      else { pad = width - remaining; col += width; i += 1; remaining = 0; }
    } else break;
  }
  // Expand tabs that remain in the leading whitespace to their
  // original widths so later column math on this string stays exact.
  let out = ' '.repeat(pad);
  let colNow = baseCol + cols + pad;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) {
    if (s[i] === ' ') { out += ' '; colNow += 1; i += 1; }
    else {
      const width = 4 - (colNow % 4);
      out += ' '.repeat(width);
      colNow += width;
      i += 1;
    }
  }
  return out + s.slice(i);
}

// Remove up to `cols` columns of indentation from a line that starts
// at column 0.
function stripIndent(line, cols) {
  return dropColumns(line, 0, cols);
}

function isBlankLine(line) {
  return /^[ \t]*$/.test(line);
}

// ---------------------------------------------------------------------
// Link reference definitions
// ---------------------------------------------------------------------

// Try to read a link reference definition starting at `pos` (which is
// at the first character of a line whose indentation is already known
// to be at most 3). On success returns { label, href, title, end }
// where `end` is the offset just past the definition (including the
// final newline); on failure returns null.
function readDef(src, pos, defs) {
  let i = pos;
  // Opening bracket after at most three columns of indentation.
  const firstLineEnd = lineEnd(src, i);
  const firstLine = src.slice(i, firstLineEnd);
  const ind = measureIndent(firstLine);
  if (ind.cols > 3 || firstLine[ind.chars] !== '[') return null;
  i += ind.chars + 1;
  // Label: up to the matching unescaped ']', at most 999 characters.
  let label = '';
  let closed = false;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < src.length) { label += ch + src[i + 1]; i += 2; continue; }
    if (ch === '[') return null;
    if (ch === ']') { closed = true; i += 1; break; }
    if (label.length > 999) return null;
    label += ch;
    i += 1;
  }
  if (!closed || src[i] !== ':') return null;
  if (label.trim() === '') return null;
  i += 1;
  // Destination: on this line or the next. After the colon marked
  // allows spaces only, then at most one newline.
  while (src[i] === ' ') i += 1;
  if (src[i] === '\n') {
    i += 1;
    while (src[i] === ' ' || src[i] === '\t') i += 1;
  }
  const dest = readLinkDestinationAt(src, i);
  if (!dest) return null;
  i = dest.end;
  let href = dest.href;
  // Optional title, separated from the destination by spaces or by a
  // newline, and the last thing on its line. If a title is present
  // but junk follows it on the line, the definition still counts —
  // without the title.
  let title = null;
  const save = i;
  const titled = readDefTitle(src, i);
  if (titled) {
    const eol = lineEnd(src, titled.end);
    if (/^ *$/.test(src.slice(titled.end, eol))) {
      title = titled.title;
      i = titled.end;
    }
  }
  if (title === null) {
    i = save;
    const eol = lineEnd(src, i);
    if (!/^ *$/.test(src.slice(i, eol))) return null;
  }
  const key = normaliseLabel(label);
  if (!defs.has(key)) {
    defs.set(key, {
      href: resolveBackslashEscapes(href),
      title: title === null ? null : resolveBackslashEscapes(title),
    });
  }
  const endOfLine = lineEnd(src, i);
  return { end: endOfLine < src.length ? endOfLine + 1 : endOfLine };
}

// Whitespace run that may include at most one newline; returns the new
// offset or -1 when the run holds more than one newline.
function skipInlineWhitespace(src, i, allowNewline) {
  let sawNewline = false;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t') { i += 1; continue; }
    if (ch === '\n' && allowNewline) {
      if (sawNewline) return -1;
      sawNewline = true;
      i += 1;
      continue;
    }
    break;
  }
  return i;
}

// A link destination at offset i (leading whitespace already allowed
// to include one newline when `multiline` is set): either <...> or a
// run of non-space characters with balanced parentheses.
function readLinkDestination(src, i, multiline) {
  i = skipInlineWhitespace(src, i, multiline);
  if (i < 0 || i >= src.length) return null;
  return readLinkDestinationAt(src, i);
}

// A link destination at exactly offset i: <...> or a bare run.
function readLinkDestinationAt(src, i) {
  if (src[i] === '<') {
    let href = '';
    let j = i + 1;
    while (j < src.length) {
      const ch = src[j];
      if (ch === '\\' && j + 1 < src.length) { href += ch + src[j + 1]; j += 2; continue; }
      if (ch === '>') return { href, end: j + 1 };
      if (ch === '<' || ch === '\n') return null;
      href += ch;
      j += 1;
    }
    return null;
  }
  let href = '';
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const ch = src[j];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch < ' ') break;
    if (ch === '\\' && j + 1 < src.length) { href += ch + src[j + 1]; j += 2; continue; }
    if (ch === '(') { depth += 1; if (depth > 32) return null; }
    else if (ch === ')') {
      if (depth === 0) break;
      depth -= 1;
    }
    href += ch;
    j += 1;
  }
  if (j === i || depth !== 0) return null;
  return { href, end: j };
}

// A definition title following the destination. Separation is spaces
// only, optionally with one newline; the title itself is "..." ,
// '...' or (...).
function readDefTitle(src, i) {
  let j = i;
  while (src[j] === ' ') j += 1;
  if (src[j] === '\n') {
    j += 1;
    while (src[j] === ' ' || src[j] === '\t') j += 1;
  }
  if (j === i) return null; // needs separating whitespace
  i = j;
  const open = src[i];
  if (open !== '"' && open !== "'" && open !== '(') return null;
  const close = open === '(' ? ')' : open;
  let title = '';
  j = i + 1;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '\\' && j + 1 < src.length) { title += ch + src[j + 1]; j += 2; continue; }
    if (ch === close) return { title, end: j + 1 };
    if (open === '(' && ch === '(') return null;
    if (open === "'" && ch === '\n' && src[j + 1] === '\n') return null;
    title += ch;
    j += 1;
  }
  return null;
}

// ---------------------------------------------------------------------
// Block-level recognisers. Each works on one line (no trailing \n).
// ---------------------------------------------------------------------

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// A fenced code opener: ``` or ~~~ after at most 3 columns of indent.
// A backtick fence's info string may not itself contain a backtick.
function fenceStart(line) {
  const ind = measureIndent(line);
  if (ind.cols > 3) return null;
  const rest = line.slice(ind.chars);
  const ch = rest[0];
  if (ch !== '`' && ch !== '~') return null;
  let count = 0;
  while (rest[count] === ch) count += 1;
  if (count < 3) return null;
  const info = rest.slice(count);
  if (ch === '`' && info.includes('`')) return null;
  return { ch, count, info: info.trim() };
}

function fenceClose(line, fence) {
  const ind = measureIndent(line);
  if (ind.cols > 3) return false;
  const rest = line.slice(ind.chars);
  let count = 0;
  while (rest[count] === fence.ch) count += 1;
  if (count < fence.count) return false;
  return /^ *$/.test(rest.slice(count));
}

// An ATX heading: 1-6 '#' after at most 3 columns, then whitespace or
// end of line. The text is trimmed; a trailing run of hashes counts
// as a closing sequence only when what precedes it is empty or ends
// in a space or tab.
function atxHeading(line) {
  const ind = measureIndent(line);
  if (ind.cols > 3) return null;
  const rest = line.slice(ind.chars);
  let level = 0;
  while (rest[level] === '#') level += 1;
  if (level === 0 || level > 6) return null;
  const after = rest.slice(level);
  if (after !== '' && after[0] !== ' ' && after[0] !== '\t') return null;
  let text = after.trim();
  if (text.endsWith('#')) {
    const stripped = text.replace(/#+$/, '');
    if (stripped === '' || /[ \t]$/.test(stripped)) text = stripped.trim();
  }
  return { level, text };
}

// A thematic break: 3+ of the same -, _ or * with only spaces/tabs
// mixed in, after at most 3 columns of indent.
function isThematicBreak(line) {
  const ind = measureIndent(line);
  if (ind.cols > 3) return false;
  const rest = line.slice(ind.chars);
  let ch = '';
  let count = 0;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === ' ' || c === '\t') continue;
    if (c !== '-' && c !== '_' && c !== '*') return false;
    if (ch === '') ch = c;
    if (c !== ch) return false;
    count += 1;
  }
  return count >= 3;
}

// A setext underline: only = (level 1) or only - (level 2) plus
// spaces/tabs, after at most 3 columns of indent.
function setextLevel(line) {
  const ind = measureIndent(line);
  if (ind.cols > 3) return 0;
  const rest = line.slice(ind.chars).replace(/[ \t]+$/, '');
  if (/^=+$/.test(rest)) return 1;
  if (/^-+$/.test(rest)) return 2;
  return 0;
}

// HTML block start conditions (CommonMark types 1-7). Returns
// { kind, endTag? } where kind 1-5 end at a terminator, kinds 6-7 end
// at a blank line. Type 7 may not interrupt a paragraph.
function htmlBlockStart(line) {
  const ind = measureIndent(line);
  if (ind.cols > 3) return null;
  const rest = line.slice(ind.chars);
  if (rest[0] !== '<') return null;
  let m = /^<(script|pre|style|textarea)(?=[ \t>]|$)/i.exec(rest);
  if (m) return { kind: 1, endTag: '</' + m[1].toLowerCase() };
  if (rest.startsWith('<!--')) return { kind: 2, endMark: '-->' };
  if (rest.startsWith('<?')) return { kind: 3, endMark: '?>' };
  if (/^<![A-Z]/.test(rest)) return { kind: 4, endMark: '>' };
  if (rest.startsWith('<![CDATA[')) return { kind: 5, endMark: ']]>' };
  m = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?=[ \t>]|\/>|$)/.exec(rest);
  if (m && BLOCK_TAGS.has(m[1].toLowerCase())) return { kind: 6 };
  if (isCompleteTagLine(rest)) return { kind: 7 };
  return null;
}

// Whether the line consists of exactly one complete open or closing
// tag (the CommonMark type-7 condition).
function isCompleteTagLine(rest) {
  const tag = scanTag(rest, 0);
  if (!tag) return false;
  return /^[ \t]*$/.test(rest.slice(tag.end));
}

// Scan an HTML tag at offset i of a string. Returns
// { end, name, closing, selfClosing } or null.
function scanTag(s, i) {
  if (s[i] !== '<') return null;
  let j = i + 1;
  let closing = false;
  if (s[j] === '/') { closing = true; j += 1; }
  const nameMatch = /^[A-Za-z][A-Za-z0-9-]*/.exec(s.slice(j, j + 64));
  if (!nameMatch) return null;
  const name = nameMatch[0].toLowerCase();
  j += nameMatch[0].length;
  if (closing) {
    while (s[j] === ' ' || s[j] === '\t' || s[j] === '\n') j += 1;
    if (s[j] !== '>') return null;
    return { end: j + 1, name, closing, selfClosing: false };
  }
  // Attributes.
  for (;;) {
    let spaces = 0;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) { j += 1; spaces += 1; }
    if (s[j] === '>') return { end: j + 1, name, closing, selfClosing: false };
    if (s[j] === '/' && s[j + 1] === '>') return { end: j + 2, name, closing, selfClosing: true };
    if (j >= s.length || spaces === 0) return null;
    const attr = /^[A-Za-z_:][A-Za-z0-9_.:-]*/.exec(s.slice(j, j + 128));
    if (!attr) return null;
    j += attr[0].length;
    // Optional = value, whitespace allowed around the equals sign.
    let k = j;
    while (s[k] === ' ' || s[k] === '\t' || s[k] === '\n') k += 1;
    if (s[k] === '=') {
      k += 1;
      while (s[k] === ' ' || s[k] === '\t' || s[k] === '\n') k += 1;
      const q = s[k];
      if (q === '"' || q === "'") {
        const closeQuote = s.indexOf(q, k + 1);
        if (closeQuote === -1) return null;
        j = closeQuote + 1;
      } else {
        const val = /^[^ \t\n"'=<>`]+/.exec(s.slice(k));
        if (!val) return null;
        j = k + val[0].length;
      }
    }
  }
}

// ---------------------------------------------------------------------
// Block parsing. Produces a list of nodes:
//   { t:'p', text }            paragraph (raw inline text)
//   { t:'h', level, text }     heading
//   { t:'code', text, lang }   code block (text not yet escaped)
//   { t:'html', text }         raw HTML block
//   { t:'hr' }
//   { t:'quote', children }    blockquote
// Lists and tables are added by later stages of this parser.
// ---------------------------------------------------------------------

function nextLine(src, pos) {
  const end = lineEnd(src, pos);
  return { text: src.slice(pos, end), end, next: end < src.length ? end + 1 : end };
}

// Does this line interrupt a paragraph? `following` is the line after
// it (or null). Ordered lists only interrupt when they start at 1 and
// no list item may interrupt when it is empty.
function interruptsParagraph(line, following) {
  if (fenceStart(line)) return true;
  if (atxHeading(line)) return true;
  if (setextLevel(line)) return true; // handled by caller as setext
  if (isThematicBreak(line)) return true;
  const ind = measureIndent(line);
  if (ind.cols <= 3 && line[ind.chars] === '>') return true;
  const mk = listMarker(line);
  if (mk) {
    // A list interrupts a paragraph only with a non-empty item, and
    // an ordered list only when it starts at 1.
    const rest = line.slice(mk.indent.chars + mk.markerChars).replace(/^[ \t]+/, '');
    if (rest !== '' && (!mk.ordered || mk.number === 1)) return true;
  }
  const hb = htmlBlockStart(line);
  if (hb && hb.kind !== 7) return true;
  return false;
}

// Does this line start a construct that setext (lheading) content may
// not begin with (first line) or cross (continuation lines)?
function lheadingForbidden(line, isFirst) {
  const ind = measureIndent(line);
  if (isFirst && ind.cols >= 4) return true;
  if (fenceStart(line)) return true;
  if (ind.cols <= 3 && line[ind.chars] === '>') return true;
  if (atxHeading(line)) return true;
  if (!isFirst && isThematicBreak(line)) return true;
  const mk = listMarker(line);
  if (mk) {
    const rest = line.slice(mk.indent.chars + mk.markerChars);
    if (rest === '' || rest[0] === ' ' || rest[0] === '\t') return true;
  }
  if (/^ {0,3}<[^\n>]*>/.test(line)) return true;
  if (/^ {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*$/.test(line)) return true;
  return false;
}

// A blank line ends a paragraph chunk — except a whitespace-only
// final line with no terminator, which marked's paragraph pattern
// still counts as content.
function isBlankBreak(src, ln) {
  if (!isBlankLine(ln.text)) return false;
  return ln.next < src.length || src.endsWith('\n');
}
function readParagraph(src, pos, defs, top) {
  // First, the setext attempt: scan the would-be heading content.
  {
    let cursor = pos;
    let eligible = true;
    const lines = [];
    for (;;) {
      const ln = nextLine(src, cursor);
      if (lines.length === 0) {
        if (lheadingForbidden(ln.text, true)) { eligible = false; break; }
      }
      lines.push(ln.text);
      cursor = ln.next;
      if (cursor >= src.length) break;
      const peek = nextLine(src, cursor);
      if (isBlankBreak(src, peek)) break;
      const setext = setextLevel(peek.text);
      if (setext) {
        return {
          node: { t: 'h', level: setext, text: lines.join('\n').trim() },
          end: peek.next,
        };
      }
      if (lheadingForbidden(peek.text, false)) { eligible = false; break; }
    }
    void eligible;
  }
  const lines = [];
  let cursor = pos;
  for (;;) {
    const ln = nextLine(src, cursor);
    lines.push(ln.text);
    cursor = ln.next;
    if (cursor >= src.length) break;
    const peek = nextLine(src, cursor);
    if (isBlankBreak(src, peek)) break;
    if (top) {
      const after = peek.next < src.length ? nextLine(src, peek.next) : null;
      if (interruptsParagraph(peek.text, after ? after.text : null)) break;
    } else if (startsAnyBlock(src, cursor)) break;
  }
  return { node: { t: top ? 'p' : 'text', text: lines.join('\n') }, end: cursor };
}

// In non-top contexts (list items), does the line at `pos` start a
// block construct (so a text run must stop before it)?
function startsAnyBlock(src, pos) {
  const ln = nextLine(src, pos);
  const line = ln.text;
  if (measureIndent(line).cols >= 4) return true;
  if (fenceStart(line)) return true;
  if (atxHeading(line)) return true;
  if (isThematicBreak(line)) return true;
  const ind = measureIndent(line);
  if (ind.cols <= 3 && line[ind.chars] === '>') return true;
  if (listMarker(line)) return true;
  if (htmlBlockStart(line)) return true;
  if (readDef(src, pos, new Map())) return true;
  const after = ln.next < src.length ? nextLine(src, ln.next) : null;
  if (after && isTableStart(line, after.text)) return true;
  return false;
}

// Does this node list end in an open paragraph (possibly nested
// inside a trailing list item or blockquote)?
function endsInOpenParagraph(nodes) {
  const last = nodes[nodes.length - 1];
  if (!last) return false;
  if (last.t === 'p' || last.t === 'text') return true;
  if (last.t === 'list') {
    const item = last.items[last.items.length - 1];
    return item ? endsInOpenParagraph(item.children) : false;
  }
  if (last.t === 'quote') return endsInOpenParagraph(last.children);
  return false;
}

// Is this line a blockquote line (up to 3 columns of indent, then >)?
function isQuoteLine(line) {
  const ind = measureIndent(line);
  return ind.cols <= 3 && line[ind.chars] === '>';
}

// The capture prefix of a quote line: ' {0,3}>' plus one optional
// space. Content after it decides whether lazy lines may follow.
function quoteContentBlank(line) {
  const m = /^ {0,3}> ?/.exec(line);
  const rest = m ? line.slice(m[0].length) : '';
  return /^[ \t]*$/.test(rest);
}

// Expand tabs in a whitespace run, counting columns from `col`
// (marked's J helper, applied to the whitespace after a > marker).
function expandTabsFrom(ws, col) {
  let out = '';
  for (const ch of ws) {
    if (ch === '\t') {
      const width = 4 - (col % 4);
      out += ' '.repeat(width);
      col += width;
    } else {
      out += ch;
      col += 1;
    }
  }
  return out;
}

// Marked's per-group transform: expand the whitespace after each
// marker, protect lazy setext underlines by indenting them, then
// strip the markers.
function transformQuoteGroup(group) {
  let u = group.join('\n');
  u = u.replace(/^( {0,3}>)([ \t]+)/gm, (m, pre, ws) => pre + expandTabsFrom(ws, pre.length));
  u = u.replace(/\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g, '\n    $1');
  u = u.replace(/^ {0,3}>[ \t]?/gm, '');
  return u;
}

// Strip quote markers plainly (used by the quote extension branch).
function stripQuoteMarkersPlain(text) {
  return text.replace(/^ {0,3}>[ \t]?/gm, '');
}

// Would this line stop the paragraph that a quote unit is capturing
// (marked's Ke paragraph stop-set)?
function quoteCaptureStops(line, followingLine) {
  if (fenceStart(line) || atxHeading(line) || isThematicBreak(line)) return true;
  if (isQuoteLine(line)) return true;
  const mk = listMarker(line);
  if (mk) {
    const rest = line.slice(mk.indent.chars + mk.markerChars);
    if (rest === '' || rest[0] === ' ' || rest[0] === '\t') return true;
  }
  if (htmlBlockStart(line)) return true;
  if (followingLine !== null && isTableStart(line, followingLine)) return true;
  return false;
}

// Collect a blockquote starting at `pos`, following marked's
// tokenizer: capture candidate lines (marked lines plus lazy
// paragraph continuations), split them into groups, lex each group
// into a shared token array, and let a trailing list or nested quote
// absorb following lines when it can.
function readBlockquote(src, pos, defs) {
  // --- capture candidate lines ---
  const cand = []; // { raw, end }
  let cursor = pos;
  let unitOpen = false;
  while (cursor < src.length) {
    const ln = nextLine(src, cursor);
    if (isQuoteLine(ln.text)) {
      cand.push({ raw: ln.text, end: ln.next });
      unitOpen = !quoteContentBlank(ln.text);
      cursor = ln.next;
      continue;
    }
    if (cand.length === 0 || !unitOpen || isBlankLine(ln.text)) break;
    const following = ln.next < src.length ? nextLine(src, ln.next) : null;
    if (quoteCaptureStops(ln.text, following ? following.text : null)) break;
    cand.push({ raw: ln.text, end: ln.next });
    cursor = ln.next;
  }
  // --- group loop ---
  const nodes = [];
  let remaining = cand.map(c => c.raw);
  let consumed = 0;
  let firstGroup = true;
  while (remaining.length > 0) {
    const group = [];
    let seenMarked = false;
    let gi = 0;
    while (gi < remaining.length) {
      if (isQuoteLine(remaining[gi])) { group.push(remaining[gi]); seenMarked = true; gi += 1; }
      else if (!seenMarked) { group.push(remaining[gi]); gi += 1; }
      else break;
    }
    remaining = remaining.slice(gi);
    const groupText = transformQuoteGroup(group);
    parseBlocksInto(groupText, defs, nodes, {
      top: true, mergeParagraph: true, continuation: !firstGroup,
    });
    firstGroup = false;
    consumed += group.length;
    if (remaining.length === 0) break;
    const last = nodes[nodes.length - 1];
    if (!last) break;
    if (last.t === 'code' || last.t === 'h' || last.t === 'hr' || last.t === 'html' || last.t === 'table') break;
    if (last.t === 'quote') {
      // Try to extend the nested quote with the remaining lines.
      const lastRaw = last._raw || '';
      const m = lastRaw + '\n' + stripQuoteMarkersPlain(remaining.join('\n'));
      const sub = readBlockquote(m, 0, defs);
      const subRawLen = m.slice(0, sub.end).replace(/\n+$/, '').split('\n').length;
      const lastRawLines = lastRaw.split('\n').length;
      const took = subRawLen - lastRawLines;
      if (took > 0) {
        nodes[nodes.length - 1] = sub.node;
        consumed += took;
        remaining = remaining.slice(took);
        if (remaining.length > 0 && isQuoteLine(remaining[0])) continue;
      }
      break;
    }
    if (last.t === 'list') {
      // Try to extend the list with the remaining lines (original form).
      const lastRaw = last._raw || '';
      const b = lastRaw + '\n' + remaining.join('\n');
      const sub = readList(b, 0, defs);
      if (sub.end > lastRaw.length) {
        const extra = b.slice(lastRaw.length + 1, sub.end).replace(/\n+$/, '');
        const took = extra === '' ? 0 : extra.split('\n').length;
        if (took > 0) {
          nodes[nodes.length - 1] = sub.node;
          consumed += took;
          remaining = remaining.slice(took);
          continue;
        }
      }
      // No growth: fall through and lex the next group normally.
    }
  }
  const end = consumed > 0 ? cand[consumed - 1].end : pos;
  return { node: { t: 'quote', children: nodes }, end };
}

// Marked's ge() trim: if the text ends with two or more blank lines,
// cut everything after the last non-blank line; otherwise keep it
// exactly as it is.
function geTrim(raw) {
  const lines = raw.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && /^[ \t]*$/.test(lines[t])) t -= 1;
  if (lines.length - t <= 2) return raw;
  return lines.slice(0, t + 1).join('\n');
}

// ---------------------------------------------------------------------
// Tables (GFM)
// ---------------------------------------------------------------------

// Marked's splitCells: a pipe preceded by an odd number of
// backslashes is a literal pipe, not a separator. Cells are trimmed,
// `\|` becomes `|`, an empty first/last cell (from a leading or
// trailing pipe) is dropped, and the row is truncated or padded to
// `count` cells when a count is given.
function splitTableCells(row, count) {
  let marked = '';
  for (let i = 0; i < row.length; i++) {
    if (row[i] === '|') {
      let backslashes = 0;
      for (let p = i - 1; p >= 0 && row[p] === '\\'; p--) backslashes += 1;
      marked += backslashes % 2 === 1 ? '|' : ' |';
    } else marked += row[i];
  }
  let cells = marked.split(' |');
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.splice(count);
    while (cells.length < count) cells.push('');
  }
  return cells.map(c => c.trim().replace(/\\\|/g, '|'));
}

const TABLE_DELIM_RE = /^ {0,3}(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?$/;

// Could `delimLine` serve as a table delimiter row? The delimiter
// must also contain at least one pipe or colon.
function isTableDelimiter(delimLine) {
  if (!TABLE_DELIM_RE.test(delimLine)) return false;
  const capture = delimLine.replace(/^ {0,3}/, '');
  return /[:|]/.test(capture);
}

function isTableStart(headerLine, delimLine) {
  if (!/^ *[^\n ]/.test(headerLine)) return false;
  return isTableDelimiter(delimLine);
}

// Does this line end a table body?
function tableBodyStops(line) {
  if (isThematicBreak(line)) return true;
  if (atxHeading(line)) return true;
  if (isQuoteLine(line)) return true;
  if (isCodeLine(line)) return true;
  if (fenceStart(line)) return true;
  const mk = listMarker(line);
  if (mk && (!mk.ordered || mk.number === 1)) {
    const rest = line.slice(mk.indent.chars + mk.markerChars);
    if (rest !== '' && (rest[0] === ' ' || rest[0] === '\t')) return true;
  }
  const hb = htmlBlockStart(line);
  if (hb && hb.kind !== 7) return true;
  return false;
}

// Read a table starting at `pos` (header line + delimiter line).
// Returns null when the header and delimiter cell counts disagree.
function readTable(src, pos, defs) {
  void defs;
  const headLn = nextLine(src, pos);
  const delimLn = nextLine(src, headLn.next);
  const header = splitTableCells(headLn.text.replace(/^ */, ''));
  const alignRaw = delimLn.text.replace(/^ {0,3}/, '').replace(/^\||\| *$/g, '');
  const alignCells = alignRaw.split('|');
  if (header.length !== alignCells.length) return null;
  const align = alignCells.map(cell => {
    if (/^ *-+: *$/.test(cell)) return 'right';
    if (/^ *:-+: *$/.test(cell)) return 'center';
    if (/^ *:-+ *$/.test(cell)) return 'left';
    return null;
  });
  const rows = [];
  let cursor = delimLn.next;
  while (cursor < src.length) {
    const ln = nextLine(src, cursor);
    if (ln.text === '' || /^ *$/.test(ln.text)) break;
    // Marked keeps a newline-terminated whitespace line that
    // contains a tab as a row of empty cells.
    if (/^[ \t]*$/.test(ln.text)) {
      if (ln.next <= cursor + ln.text.length) break;
      rows.push(splitTableCells(ln.text, header.length));
      cursor = ln.next;
      continue;
    }
    if (tableBodyStops(ln.text)) break;
    rows.push(splitTableCells(ln.text, header.length));
    cursor = ln.next;
  }
  return { node: { t: 'table', header, align, rows }, end: cursor };
}

function renderTable(node, defs) {
  let out = '<table>\n<thead>\n<tr>\n';
  node.header.forEach((cell, i) => {
    const a = node.align[i];
    out += (a ? '<th align="' + a + '">' : '<th>') + renderInline(cell, defs) + '</th>\n';
  });
  out += '</tr>\n</thead>\n';
  if (node.rows.length > 0) {
    out += '<tbody>';
    for (const row of node.rows) {
      out += '<tr>\n';
      row.forEach((cell, i) => {
        const a = node.align[i];
        out += (a ? '<td align="' + a + '">' : '<td>') + renderInline(cell, defs) + '</td>\n';
      });
      out += '</tr>\n';
    }
    out += '</tbody>';
  }
  return out + '</table>\n';
}
// Collect an HTML block starting at `pos` whose start condition is hb.
function readHtmlBlock(src, pos, hb) {
  let cursor = pos;
  if (hb.kind <= 5) {
    // Ends with the first line containing the terminator (or EOF).
    while (cursor < src.length) {
      const ln = nextLine(src, cursor);
      cursor = ln.next;
      const hay = ln.text.toLowerCase();
      const needle = hb.kind === 1 ? hb.endTag : hb.endMark;
      if (hay.includes(needle)) break;
    }
    // Blank lines after the terminator belong to the raw text too.
    while (cursor < src.length) {
      const bl = nextLine(src, cursor);
      if (!isBlankLine(bl.text)) break;
      cursor = bl.next;
    }
    return { node: { t: 'html', text: geTrim(src.slice(pos, cursor)) }, end: cursor };
  }
  // Kinds 6 and 7 run until a blank line; the blank lines themselves
  // are part of the raw text (ge then trims an excess of them).
  while (cursor < src.length) {
    const ln = nextLine(src, cursor);
    cursor = ln.next;
    if (isBlankLine(ln.text)) {
      // Consume the whole blank run, then stop.
      while (cursor < src.length) {
        const bl = nextLine(src, cursor);
        if (!isBlankLine(bl.text)) break;
        cursor = bl.next;
      }
      break;
    }
  }
  return { node: { t: 'html', text: geTrim(src.slice(pos, cursor)) }, end: cursor };
}

// Is this line an indented-code line (4+ columns of indent followed
// by at least one more character)?
function isCodeLine(line) {
  return /^(?: {4}| {0,3}\t)/.test(line) && line.replace(/^(?: {4}| {0,3}\t)/, '').length > 0;
}

// Collect an indented code block starting at `pos`: code lines and
// blank lines, with the raw text ge-trimmed and each line dedented
// the way marked does it (remove a leading tab with up to 3 spaces,
// or 1-4 leading spaces).
function readIndentedCode(src, pos) {
  let cursor = pos;
  while (cursor < src.length) {
    const ln = nextLine(src, cursor);
    if (isCodeLine(ln.text) || isBlankLine(ln.text)) { cursor = ln.next; continue; }
    break;
  }
  const raw = geTrim(src.slice(pos, cursor));
  const text = raw.replace(/^(?: {0,3}\t| {1,4})/gm, '');
  return { node: { t: 'code', text, lang: '' }, end: cursor };
}

// Collect a fenced code block starting at `pos`.
function readFence(src, pos, fence) {
  const first = nextLine(src, pos);
  let cursor = first.next;
  const contentStart = cursor;
  let contentEnd = src.length;
  let closed = false;
  while (cursor < src.length) {
    const ln = nextLine(src, cursor);
    if (fenceClose(ln.text, fence)) { contentEnd = cursor; cursor = ln.next; closed = true; break; }
    cursor = ln.next;
    contentEnd = cursor;
  }
  void closed;
  let text = src.slice(contentStart, contentEnd);
  // The newline before the closing fence (or at EOF) is a separator,
  // not content.
  if (text.endsWith('\n')) text = text.slice(0, -1);
  // Marked compensates for the opening fence's indentation on
  // backtick fences: each content line loses up to that many leading
  // whitespace characters.
  const indentChars = measureIndent(first.text).chars;
  if (fence.ch === '`' && indentChars > 0) {
    text = text.split('\n').map(line => {
      const lead = /^[ \t]+/.exec(line);
      if (!lead) return line;
      return line.slice(Math.min(lead[0].length, indentChars));
    }).join('\n');
  }
  const lang = resolveBackslashEscapes((fence.info || '').trim());
  return { node: { t: 'code', text, lang }, end: cursor };
}

// Parse blocks from `src` into the shared `nodes` array. Marked's
// lexer merges certain tokens into a preceding paragraph or text
// token when they are directly adjacent (no space token between):
// an indented code block's text and a link definition's raw text are
// absorbed, and the definition is then NOT registered. A single
// blank line does not create a space token in marked; two or more
// do, and block adjacency for merging.
function parseBlocksInto(src, defs, nodes, opts) {
  const top = opts.top;
  let pos = 0;
  let blankRaw = opts.continuation ? 0 : 2; // >1 means "separated"
  const adjacentText = () => {
    const last = nodes[nodes.length - 1];
    return last && (last.t === 'p' || last.t === 'text') && blankRaw <= 1 ? last : null;
  };
  // After a node is consumed, the whitespace run that follows it
  // starts with the line terminator of its last line (when present).
  const afterNode = end => { blankRaw = end > 0 && src[end - 1] === '\n' ? 1 : 0; };
  while (pos < src.length) {
    const ln = nextLine(src, pos);
    if (isBlankLine(ln.text)) { blankRaw += ln.next - pos; pos = ln.next; continue; }
    // A blank run long enough to form a space token now sits between
    // two tokens of this call (marked's list-loose rule (b) keys on
    // exactly that).
    if (blankRaw > 1 && nodes.length > 0 && opts.tracker) opts.tracker.spaceLoose = true;
    const start = pos;
    // A definition directly adjacent to a paragraph or text token is
    // absorbed into it and NOT registered; decide adjacency first so
    // the speculative read does not register it either way.
    const prev = adjacentText();
    const def = readDef(src, pos, prev ? new Map() : defs);
    if (def) {
      if (prev) {
        const raw = src.slice(pos, def.end).replace(/\n+$/, '');
        prev.text += '\n' + raw;
        prev._raw = (prev._raw || '') + '\n' + raw;
        afterNode(def.end);
      } else {
        // A registered definition is itself a token: it breaks
        // adjacency for whatever follows.
        blankRaw = 2;
      }
      pos = def.end;
      continue;
    }
    const fence = fenceStart(ln.text);
    if (fence && measureIndent(ln.text).cols < 4) {
      const r = readFence(src, pos, fence);
      r.node._raw = src.slice(start, r.end).replace(/\n+$/, '');
      nodes.push(r.node); pos = r.end; afterNode(r.end); continue;
    }
    if (measureIndent(ln.text).cols >= 4) {
      const r = readIndentedCode(src, pos);
      if (prev) {
        prev.text += '\n' + r.node.text;
        prev._raw = (prev._raw || '') + '\n' + src.slice(start, r.end).replace(/\n+$/, '');
      } else {
        r.node._raw = src.slice(start, r.end).replace(/\n+$/, '');
        nodes.push(r.node);
      }
      pos = r.end; afterNode(r.end); continue;
    }
    const heading = atxHeading(ln.text);
    if (heading) {
      const node = { t: 'h', level: heading.level, text: heading.text, _raw: ln.text };
      nodes.push(node);
      pos = ln.next; afterNode(ln.next); continue;
    }
    if (isThematicBreak(ln.text)) {
      nodes.push({ t: 'hr', _raw: ln.text });
      pos = ln.next; afterNode(ln.next); continue;
    }
    const ind = measureIndent(ln.text);
    if (ind.cols <= 3 && ln.text[ind.chars] === '>') {
      const r = readBlockquote(src, pos, defs);
      r.node._raw = src.slice(start, r.end).replace(/\n+$/, '');
      nodes.push(r.node); pos = r.end; afterNode(r.end); continue;
    }
    if (listMarker(ln.text)) {
      const r = readList(src, pos, defs);
      r.node._raw = src.slice(start, r.end).replace(/\n+$/, '');
      nodes.push(r.node); pos = r.end; afterNode(r.end); continue;
    }
    const hb = htmlBlockStart(ln.text);
    if (hb) {
      const r = readHtmlBlock(src, pos, hb);
      r.node._raw = src.slice(start, r.end).replace(/\n+$/, '');
      nodes.push(r.node); pos = r.end; afterNode(r.end); continue;
    }
    const after = ln.next < src.length ? nextLine(src, ln.next) : null;
    if (after && isTableStart(ln.text, after.text)) {
      const r = readTable(src, pos, defs);
      if (r) {
        r.node._raw = src.slice(start, r.end).replace(/\n+$/, '');
        nodes.push(r.node); pos = r.end; afterNode(r.end); continue;
      }
    }
    const para = readParagraph(src, pos, defs, top);
    para.node._raw = src.slice(start, para.end).replace(/\n+$/, '');
    const prevPara = nodes[nodes.length - 1];
    if (opts.mergeParagraph && prevPara && prevPara.t === 'p' && para.node.t === 'p' && blankRaw <= 1) {
      prevPara.text += '\n' + para.node.text;
      prevPara._raw += '\n' + para.node._raw;
    } else nodes.push(para.node);
    pos = para.end;
    afterNode(para.end);
  }
  return nodes;
}

function parseBlockList(src, defs) {
  return parseBlocksInto(src, defs, [], { top: true });
}

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------

function renderCodeBlock(node) {
  let body = node.text;
  if (body.endsWith('\n')) body = body.slice(0, -1);
  const escaped = escapeHtml(body, true);
  const lang = node.lang ? node.lang.split(/\s+/)[0] : '';
  const attr = lang ? ' class="language-' + escapeHtml(lang, false) + '"' : '';
  return '<pre><code' + attr + '>' + (escaped === '' ? '' : escaped + '\n') + '</code></pre>\n';
}

function renderNodes(nodes, defs) {
  let out = '';
  for (const node of nodes) {
    if (node.t === 'p' || node.t === 'text') out += '<p>' + renderInline(node.text, defs) + '</p>\n';
    else if (node.t === 'h') out += '<h' + node.level + '>' + renderInline(node.text, defs) + '</h' + node.level + '>\n';
    else if (node.t === 'code') out += renderCodeBlock(node);
    else if (node.t === 'html') out += node.text;
    else if (node.t === 'hr') out += '<hr>\n';
    else if (node.t === 'quote') out += '<blockquote>\n' + renderNodes(node.children, defs) + '</blockquote>\n';
    else if (node.t === 'list') out += renderList(node, defs);
    else if (node.t === 'table') out += renderTable(node, defs);
  }
  return out;
}

// ---------------------------------------------------------------------
// Inline parsing. The scanner produces a token list; emphasis is then
// resolved over that list with the delimiter-run algorithm. Token
// kinds: text, escape, code, html, br, delim, link, image, autolink.
// ---------------------------------------------------------------------

const PUNCT_RE = /[\p{P}\p{S}]/u;

function isWsChar(ch) {
  return ch === undefined || /\s/.test(ch);
}
function isPunctChar(ch) {
  return ch !== undefined && PUNCT_RE.test(ch);
}

// Resolve backslash escapes of punctuation and decode numeric
// character references; used for link destinations and titles.
function unescapeText(raw) {
  return resolveBackslashEscapes(raw);
}

// Find the ']' matching the '[' at openIdx, honouring backslash
// escapes, code spans, and HTML or autolink constructs (a construct
// that swallows the closing bracket makes the link fail, as in
// marked). Returns -1 when there is none.
function findMatchingBracket(src, openIdx) {
  let depth = 1;
  let i = openIdx + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '`') {
      let run = 0;
      while (src[i + run] === '`') run += 1;
      const close = findCodeSpanClose(src, i + run, run);
      i = close === -1 ? i + run : close + run;
      continue;
    }
    if (ch === '<') {
      const html = scanInlineHtml(src, i);
      if (html) { i += html.length; continue; }
      const auto = AUTOLINK_SCHEME.exec(src.slice(i, i + 1200)) || AUTOLINK_EMAIL.exec(src.slice(i, i + 400));
      if (auto) { i += auto[0].length; continue; }
      i += 1;
      continue;
    }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

function skipAllWhitespace(src, i) {
  while (i < src.length && (src[i] === ' ' || src[i] === '\t' || src[i] === '\n')) i += 1;
  return i;
}

// A title in an inline link: "..." , '...' or (...) at offset i.
function scanInlineTitle(src, i) {
  const open = src[i];
  if (open !== '"' && open !== "'" && open !== '(') return null;
  const close = open === '(' ? ')' : open;
  let raw = '';
  let j = i + 1;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '\\' && j + 1 < src.length) { raw += ch + src[j + 1]; j += 2; continue; }
    if (ch === close) return { raw, end: j + 1 };
    if (open === '(' && ch === '(') return null;
    raw += ch;
    j += 1;
  }
  return null;
}

// The '(href "title")' tail of an inline link, starting at the '('.
// Returns { href, title, end } or null.
function readInlineLinkTail(src, i) {
  let j = skipAllWhitespace(src, i + 1);
  let href = '';
  let title = null;
  if (src[j] !== ')') {
    const dest = readLinkDestination(src, j, false);
    if (!dest) return null;
    href = dest.href;
    j = skipAllWhitespace(src, dest.end);
    if (src[j] !== ')') {
      if (j === dest.end) return null; // title needs separation
      const t = scanInlineTitle(src, j);
      if (!t) return null;
      title = t.raw;
      j = skipAllWhitespace(src, t.end);
    }
  }
  if (src[j] !== ')') return null;
  return { href: unescapeText(href), title: title === null ? null : unescapeText(title), end: j + 1 };
}

// Try to parse a link or image whose text ends at closeIdx (the ']').
// `start` is the offset of the '[' (or of '!' for an image). Returns
// { href, title, end } or null.
function readLinkTail(src, closeIdx, defs, textRaw) {
  let i = closeIdx + 1;
  if (src[i] === '(') {
    const inline = readInlineLinkTail(src, i);
    if (inline) return inline;
    // A failed inline tail falls back to a shortcut reference.
    const def = defs.get(normaliseLabel(textRaw));
    if (!def) return null;
    return { href: def.href, title: def.title, end: closeIdx + 1 };
  }
  if (src[i] === '[') {
    const labelEnd = findMatchingBracket(src, i);
    if (labelEnd === -1) return null;
    const labelRaw = src.slice(i + 1, labelEnd);
    const label = labelRaw === '' ? textRaw : labelRaw;
    const def = defs.get(normaliseLabel(label));
    if (!def) return null;
    return { href: def.href, title: def.title, end: labelEnd + 1 };
  }
  const def = defs.get(normaliseLabel(textRaw));
  if (!def) return null;
  return { href: def.href, title: def.title, end: closeIdx + 1 };
}

const AUTOLINK_SCHEME = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/;
const AUTOLINK_EMAIL = /^<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/;

// An inline HTML fragment at offset i: comment, CDATA, processing
// instruction, declaration, or a single tag. Returns the raw string.
function scanInlineHtml(src, i) {
  if (src.startsWith('<!--', i)) {
    // A comment is '<!--' then either '>' or '->' (abrupt closings),
    // or content up to '-->' — or to the end of the input.
    if (src[i + 4] === '>') return '<!-->';
    if (src[i + 4] === '-' && src[i + 5] === '>') return '<!--->';
    const end = src.indexOf('-->', i + 4);
    return end === -1 ? src.slice(i) : src.slice(i, end + 3);
  }
  if (src.startsWith('<![CDATA[', i)) {
    const end = src.indexOf(']]>', i + 9);
    return end === -1 ? null : src.slice(i, end + 3);
  }
  if (src.startsWith('<?', i)) {
    const end = src.indexOf('?>', i + 2);
    return end === -1 ? null : src.slice(i, end + 2);
  }
  if (/^<![A-Za-z]/.test(src.slice(i, i + 3))) {
    const end = src.indexOf('>', i + 2);
    return end === -1 ? null : src.slice(i, end + 1);
  }
  const tag = scanTag(src, i);
  return tag ? src.slice(i, tag.end) : null;
}

// Marked's _backpedal trimming for extended autolinks: repeatedly
// take the longest prefix that does not end in dangling punctuation,
// an unbalanced closing bracket, or an entity that does not run to
// the end of the match, until it stops changing.
const BACKPEDAL_RE = /^(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
function backpedal(s) {
  let prev;
  do {
    prev = s;
    const m = BACKPEDAL_RE.exec(s);
    s = m ? m[0] : '';
  } while (s !== prev);
  return s;
}

const EXT_URL_RE = /((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*/y;
const EMAIL_CORE = '[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])';
const EXT_EMAIL_RE = new RegExp(EMAIL_CORE, 'y');
const EMAIL_PROTOCOL_RE = new RegExp('(?:mailto:' + EMAIL_CORE + '|xmpp:' + EMAIL_CORE + '(?:\\/[A-Za-z0-9@.]+)?)', 'y');

// GFM extended autolinks at offset i. `prev` is the character before
// i (undefined at the start). Returns { text, href } or null.
function scanExtendedAutolink(src, i, prev) {
  const ch = src[i];
  // mailto: / xmpp: forms; they may not start right after an
  // alphanumeric character.
  if ((ch === 'm' || ch === 'x') && !(prev !== undefined && /[A-Za-z0-9]/.test(prev))) {
    EMAIL_PROTOCOL_RE.lastIndex = i;
    const m = EMAIL_PROTOCOL_RE.exec(src);
    if (m) {
      const text = backpedal(m[0]);
      return { text, href: text };
    }
  }
  // Protocol URLs may start anywhere; www. only after start,
  // whitespace, or one of * _ ~ ( .
  if (ch === 'h' || ch === 'H' || ch === 'f' || ch === 'F' || (ch === 'w' && src.startsWith('www.', i))) {
    if (ch !== 'w' || prev === undefined || /[\s*_~(]/.test(prev)) {
      EXT_URL_RE.lastIndex = i;
      const m = EXT_URL_RE.exec(src);
      if (m) {
        const text = backpedal(m[0]);
        if (text.length > (m[1] === 'www.' ? 4 : m[1].length)) {
          return { text, href: m[1] === 'www.' ? 'http://' + text : text };
        }
      }
    }
  }
  // Bare email addresses may start anywhere.
  if (isLocalPartCode(src.charCodeAt(i))) {
    // Cheap gate: an '@' must appear within the local-part run.
    let j = i;
    while (j < src.length && isLocalPartCode(src.charCodeAt(j))) j += 1;
    if (src[j] === '@') {
      EXT_EMAIL_RE.lastIndex = i;
      const m = EXT_EMAIL_RE.exec(src);
      if (m) return { text: m[0], href: 'mailto:' + m[0] };
    }
  }
  return null;
}

// ---------------------------------------------------------------------
// Marked's own emphasis / strikethrough matching, ported from the
// marked 18 tokenizer: an opener is tried greedily at its position
// with the emStrongLDelim / delLDelim classification of the following
// character, then the matching RDelim regex scans the (escape-masked)
// remainder with a balance counter: delimiter runs that could open
// (capture groups 3 and 4) raise the balance, closer-like runs lower
// it, and the run that brings the balance to zero closes the span.
// The scan is bounded by the last delimiter run in the string whose
// preceding character is not whitespace (marked's fe() bound).
// ---------------------------------------------------------------------

const EM_LDELIM_RE = /(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?|_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?)/yu;
const EM_RDELIM_AST_RE = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
const EM_RDELIM_UND_RE = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?![_])[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?![_])[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?![_])[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;
const EM_RDELIM_AST_HEAD_RE = /[^_*]*?__[^_*]*?\*[^_*]*?(?=__)/y;
const EM_RDELIM_UND_HEAD_RE = /[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)/y;
const DEL_LDELIM_RE = /~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/y;
const DEL_RDELIM_RE = /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu;
const PUNCT_OR_WS_RE = /^((?![*_])[\s\p{P}\p{S}])/u;
const ALNUM_RE = /[\p{L}\p{N}]/u;

function isPunctOrWs(ch) {
  return ch !== '' && ch !== undefined && PUNCT_OR_WS_RE.test(ch);
}

// True when src[from..to) contains an unescaped '[' or ']' outside
// any code span.
function labelHasBareBracket(src, from, to) {
  let i = from;
  while (i < to) {
    const ch = src[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '`') {
      let run = 0;
      while (src[i + run] === '`') run += 1;
      const close = findCodeSpanClose(src, i + run, run);
      i = close === -1 || close >= to ? i + run : close + run;
      continue;
    }
    if (ch === '[' || ch === ']') return true;
    i += 1;
  }
  return false;
}

// Marked scans for emphasis closers over a masked copy of the
// source: escaped punctuation becomes ++, and code spans, links,
// images and HTML tags collapse to [aaa...], so a delimiter inside
// one of those constructs never takes part in emphasis matching.
// The mask is length-preserving, so offsets stay valid for the raw
// source.
function maskForScan(src, defs) {
  if (!src.includes('\\') && !src.includes('`') && !src.includes('<') && !src.includes('[')) return src;
  let out = '';
  let i = 0;
  const n = src.length;
  const blank = (len) => '[' + 'a'.repeat(Math.max(0, len - 2)) + ']';
  while (i < n) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < n && isPunctChar(src[i + 1])) {
      out += '++';
      i += 2;
      continue;
    }
    if (ch === '`') {
      let run = 0;
      while (src[i + run] === '`') run += 1;
      const close = findCodeSpanClose(src, i + run, run);
      if (close !== -1) {
        const len = close + run - i;
        out += blank(len);
        i += len;
        continue;
      }
      out += '`'.repeat(run);
      i += run;
      continue;
    }
    if (ch === '<') {
      const scheme = AUTOLINK_SCHEME.exec(src.slice(i, i + 1200));
      const email = scheme ? null : AUTOLINK_EMAIL.exec(src.slice(i, i + 400));
      const html = scheme || email ? null : scanInlineHtml(src, i);
      const len = scheme ? scheme[0].length : email ? email[0].length : html ? html.length : 0;
      if (len > 0) {
        out += blank(len);
        i += len;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '[' || (ch === '!' && src[i + 1] === '[')) {
      const openIdx = ch === '!' ? i + 1 : i;
      const closeIdx = findMatchingBracket(src, openIdx);
      if (closeIdx !== -1) {
        const textRaw = src.slice(openIdx + 1, closeIdx);
        const tail = readLinkTail(src, closeIdx, defs, textRaw);
        if (tail) {
          if (src[closeIdx + 1] === '(') {
            // Marked's blockSkip only masks an inline link whose
            // label holds no bare brackets outside code spans; a
            // nested label stays visible to the emphasis scan.
            if (!labelHasBareBracket(src, openIdx + 1, closeIdx)) {
              out += blank(tail.end - i);
              i = tail.end;
              continue;
            }
          } else if (src[closeIdx + 1] === '[') {
            // A reference link whose label itself contains a link
            // keeps its label visible; only the [ref] is masked
            // (it is blanked when the scan reaches it as a shortcut).
            if (!textRaw.includes('[')) {
              out += blank(tail.end - i);
              i = tail.end;
              continue;
            }
          } else {
            out += blank(tail.end - i);
            i = tail.end;
            continue;
          }
        }
      }
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// Per-string scan context, built lazily on the first emphasis or
// strikethrough attempt: the masked source plus the fe() bounds
// (last run start of each delimiter char whose preceding character
// is not whitespace; -1 when there is none).
function makeScanCtx(src, defs) {
  return { src, defs, ready: false, masked: src, lastEm: { '*': -1, _: -1 }, lastDel: -1 };
}

function ensureScan(scan) {
  if (scan.ready) return;
  scan.ready = true;
  const masked = maskForScan(scan.src, scan.defs);
  scan.masked = masked;
  const lastEm = scan.lastEm;
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const before = s === 0 ? '\n' : masked[s - 1];
    let e = s + 1;
    while (e < n && masked[e] === r) e += 1;
    if (before !== ' ' && before !== '\t' && before !== '\n' && before !== '\r' && before !== '\f') {
      if (r === '~') scan.lastDel = s;
      else lastEm[r] = s;
    }
    s = e - 1;
  }
}

// Try to form an em/strong span opening at offset i (src[i] is '*'
// or '_'), following marked's emStrong. `prevChar` is the last
// character of the preceding text token ('' when there is none or
// the preceding token was not text). Returns { type, content, end }
// or null.
function matchEmStrong(src, scan, i, prevChar) {
  ensureScan(scan);
  EM_LDELIM_RE.lastIndex = i;
  const s = EM_LDELIM_RE.exec(src);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
  const delim = src[i];
  const sameCharPrev = prevChar === delim;
  const masked = scan.masked;
  // Walk back over a run of the same delimiter in the masked source.
  let l = i;
  while (l > 0 && masked[l - 1] === delim) l -= 1;
  const p = l === 0 ? '' : [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const h = p === '*' || p === '_' || isPunctOrWs(p);
  let prev = prevChar;
  if (l < i) prev = p;
  const u = l < i ? h : isPunctOrWs(prevChar);
  if (s[4] && ALNUM_RE.test(prev)) return null;
  const d = s[1] || s[3] || '';
  if (d && prev && !u) return null;
  const k = [...s[0]].length - 1;
  let balance = k;
  let surplus = 0;
  const y = i - l + k;
  const bigR = p.trim() !== '' && (!!d || (delim === '*' && !h));
  const lastIdx = scan.lastEm[delim];
  if (lastIdx < i + k) return null;
  const re = delim === '*' ? EM_RDELIM_AST_RE : EM_RDELIM_UND_RE;
  const head = delim === '*' ? EM_RDELIM_AST_HEAD_RE : EM_RDELIM_UND_HEAD_RE;
  re.lastIndex = i + k;
  head.lastIndex = i + k;
  const hm = head.exec(masked);
  if (hm) re.lastIndex = i + k + hm[0].length;
  let m;
  while ((m = re.exec(masked)) !== null) {
    if (m.index > lastIdx) break;
    const g = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
    if (!g) continue;
    let b = g.length;
    if (m[3] || m[4]) { balance += b; continue; }
    if (m[5] || m[6] || bigR) {
      if (sameCharPrev && (m[5] || m[6])) break;
      if (y % 3 && !((y + b) % 3)) { surplus += b; continue; }
    }
    balance -= b;
    if (balance > 0) continue;
    b = Math.min(b, b + balance + surplus);
    const te = [...m[0]][0].length;
    const end = m.index + te + b;
    const raw = src.slice(i, end);
    if (Math.min(k, b) % 2) return { type: 'em', content: raw.slice(1, -1), end };
    return { type: 'strong', content: raw.slice(2, -2), end };
  }
  return null;
}

// Try to form a strikethrough span opening at offset i (src[i] is
// '~'), following marked's del. Returns { content, end } or null.
function matchDelMarked(src, scan, i, prevChar) {
  ensureScan(scan);
  DEL_LDELIM_RE.lastIndex = i;
  const s = DEL_LDELIM_RE.exec(src);
  if (!s) return null;
  if (s[1] && prevChar && !isPunctOrWs(prevChar)) return null;
  const o = [...s[0]].length - 1;
  let balance = o;
  const lastIdx = scan.lastDel;
  if (lastIdx < i + o) return null;
  const re = DEL_RDELIM_RE;
  re.lastIndex = i + o;
  let m;
  while ((m = re.exec(scan.masked)) !== null) {
    if (m.index > lastIdx) break;
    const g = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
    if (!g || g.length !== o) continue;
    let len = g.length;
    if (m[3] || m[4]) { balance += len; continue; }
    balance -= len;
    if (balance > 0) continue;
    len = Math.min(len, len + balance);
    const te = [...m[0]][0].length;
    const end = m.index + te + len;
    const raw = src.slice(i, end);
    return { content: raw.slice(o, raw.length - o), end };
  }
  return null;
}

// Marked's lexer state, shared across every inline tokenisation of
// one document in order: an unclosed <a > tag disables extended
// autolinks until a </a> appears, and text inside <pre>/<code>/
// <kbd>/<script> is rendered raw. Reset by parse().
const lexerState = { inLink: false, inRawBlock: false };
const START_A_TAG_RE = /^<a /i;
const END_A_TAG_RE = /^<\/a>/i;
const START_RAW_TAG_RE = /^<(pre|code|kbd|script)(\s|>)/i;
const END_RAW_TAG_RE = /^<\/(pre|code|kbd|script)(\s|>)/i;

function noteHtmlTag(html) {
  if (!lexerState.inLink && START_A_TAG_RE.test(html)) lexerState.inLink = true;
  else if (lexerState.inLink && END_A_TAG_RE.test(html)) lexerState.inLink = false;
  if (!lexerState.inRawBlock && START_RAW_TAG_RE.test(html)) lexerState.inRawBlock = true;
  else if (lexerState.inRawBlock && END_RAW_TAG_RE.test(html)) lexerState.inRawBlock = false;
}

// True when everything from `from` to the end of src is whitespace
// (marked's /^\s*$/ test on the remainder, without copying it).
function restIsAllWhitespace(src, from) {
  for (let j = from; j < src.length; j++) {
    const c = src[j];
    if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r' && c !== '\v' && c !== '\f') {
      if (!/\s/.test(c)) return false;
    }
  }
  return true;
}

// Character codes of the extended-autolink local-part class
// [A-Za-z0-9._+-].
function isLocalPartCode(cc) {
  return (cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) ||
    cc === 46 || cc === 95 || cc === 43 || cc === 45;
}

// True when a protocol URL (http://, https://, ftp://) starts at i.
function protocolAt(src, i) {
  const c1 = src.charCodeAt(i) | 32;
  if (c1 === 104) {
    if ((src.charCodeAt(i + 1) | 32) !== 116 || (src.charCodeAt(i + 2) | 32) !== 116 ||
        (src.charCodeAt(i + 3) | 32) !== 112) return false;
    let j = i + 4;
    if ((src.charCodeAt(j) | 32) === 115) j += 1;
    return src.charCodeAt(j) === 58 && src.charCodeAt(j + 1) === 47 && src.charCodeAt(j + 2) === 47;
  }
  if (c1 === 102) {
    return (src.charCodeAt(i + 1) | 32) === 116 && (src.charCodeAt(i + 2) | 32) === 112 &&
      src.charCodeAt(i + 3) === 58 && src.charCodeAt(i + 4) === 47 && src.charCodeAt(i + 5) === 47;
  }
  return false;
}

// Cheap gate for scanExtendedAutolink: a protocol URL, a www. or
// mailto:/xmpp: form, or an email at the start of a local-part run.
// (An email attempt inside a run can never succeed when the attempt
// at the run's start failed: the domain after the '@' is the same.)
function mayAutolinkStart(src, i) {
  const ch = src[i];
  if (ch === 'w' && src.startsWith('www.', i)) return true;
  if (ch === 'm' && src.startsWith('mailto:', i)) return true;
  if (ch === 'x' && src.startsWith('xmpp:', i)) return true;
  if ((ch === 'h' || ch === 'H' || ch === 'f' || ch === 'F') && protocolAt(src, i)) return true;
  if (!isLocalPartCode(src.charCodeAt(i))) return false;
  return i === 0 || !isLocalPartCode(src.charCodeAt(i - 1));
}

function tokenizeInline(src, defs, ctx) {
  const tokens = [];
  const scan = makeScanCtx(src, defs);
  let buf = '';
  // Marked's prevChar for emStrong/del: the last character of the
  // preceding text token ('' when the preceding token was not text,
  // and unchanged-by-underscore when a text token ends in '_').
  let pc = '';
  let pcBeforeBuf = '';
  let bufStarted = false;
  const addBuf = (s) => {
    if (!bufStarted) { pcBeforeBuf = pc; bufStarted = true; }
    buf += s;
  };
  const flush = () => {
    if (buf) {
      pc = buf.charCodeAt(buf.length - 1) === 95 ? pcBeforeBuf : buf[buf.length - 1];
      tokens.push(lexerState.inRawBlock ? { k: 'text', s: buf, raw: true } : { k: 'text', s: buf });
      buf = '';
      bufStarted = false;
    }
  };
  const emit = (tok) => { flush(); tokens.push(tok); pc = ''; };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < src.length) {
      const next = src[i + 1];
      if (next === '\n') {
        // A backslash break counts only when something other than
        // whitespace follows the newline.
        if (restIsAllWhitespace(src, i + 2)) { addBuf(ch); i += 1; continue; }
        emit({ k: 'br' });
        i += 2;
        while (src[i] === ' ' || src[i] === '\t') i += 1;
        continue;
      }
      if (ESCAPABLE.includes(next)) { emit({ k: 'escape', s: next }); i += 2; continue; }
      addBuf(ch); i += 1; continue;
    }
    if (ch === '`') {
      let run = 0;
      while (src[i + run] === '`') run += 1;
      const close = findCodeSpanClose(src, i + run, run);
      if (close !== -1) {
        let content = src.slice(i + run, close).replace(/\n/g, ' ');
        if (content.length > 1 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
          content = content.slice(1, -1);
        }
        emit({ k: 'code', s: content });
        i = close + run;
        continue;
      }
      addBuf('`'.repeat(run)); i += run; continue;
    }
    if (ch === '<') {
      const scheme = AUTOLINK_SCHEME.exec(src.slice(i, i + 1200));
      if (scheme) {
        emit({ k: 'autolink', href: scheme[1], text: scheme[1] });
        i += scheme[0].length;
        continue;
      }
      const email = AUTOLINK_EMAIL.exec(src.slice(i, i + 400));
      if (email) {
        emit({ k: 'autolink', href: 'mailto:' + email[1], text: email[1] });
        i += email[0].length;
        continue;
      }
      const html = scanInlineHtml(src, i);
      if (html) { emit({ k: 'html', s: html }); noteHtmlTag(html); i += html.length; continue; }
      addBuf(ch); i += 1; continue;
    }
    if (ch === '[' || (ch === '!' && src[i + 1] === '[')) {
      const isImage = ch === '!';
      const openIdx = isImage ? i + 1 : i;
      const closeIdx = findMatchingBracket(src, openIdx);
      if (closeIdx !== -1) {
        const textRaw = src.slice(openIdx + 1, closeIdx);
        const tail = readLinkTail(src, closeIdx, defs, textRaw);
        if (tail) {
          if (isImage) {
            emit({ k: 'image', href: tail.href, title: tail.title, altSrc: textRaw });
            i = tail.end;
            continue;
          }
          // Marked abandons a link whose label itself forms a link:
          // the outer brackets stay literal and the inner link is
          // what renders. (Autolinks inside a label do not count.)
          const labelCtx = { inLink: true, formedLink: false };
          const children = tokenizeInline(textRaw, defs, labelCtx);
          if (!labelCtx.formedLink) {
            flush();
            if (ctx.inLink) ctx.formedLink = true;
            tokens.push({ k: 'link', href: tail.href, title: tail.title, children });
            pc = '';
            i = tail.end;
            continue;
          }
        }
      }
      addBuf(ch); i += 1; continue;
    }
    if (ch === '*' || ch === '_') {
      flush();
      const m = matchEmStrong(src, scan, i, pc);
      if (m) {
        tokens.push({ k: m.type, children: tokenizeInline(m.content, defs, ctx) });
        pc = '';
        i = m.end;
        continue;
      }
      addBuf(ch); i += 1; continue;
    }
    if (ch === '~') {
      flush();
      const m = matchDelMarked(src, scan, i, pc);
      if (m) {
        tokens.push({ k: 'del', children: tokenizeInline(m.content, defs, ctx) });
        pc = '';
        i = m.end;
        continue;
      }
      addBuf(ch); i += 1; continue;
    }
    if (ch === '\n') {
      const trail = / {2,}$/.exec(buf);
      if (trail && !restIsAllWhitespace(src, i + 1)) {
        buf = buf.slice(0, buf.length - trail[0].length);
        if (!buf) bufStarted = false;
        emit({ k: 'br' });
        i += 1;
        while (src[i] === ' ' || src[i] === '\t') i += 1;
        continue;
      }
      addBuf(ch); i += 1; continue;
    }
    if (!ctx.inLink && !lexerState.inLink && mayAutolinkStart(src, i)) {
      const auto = scanExtendedAutolink(src, i, i === 0 ? undefined : src[i - 1]);
      if (auto && auto.text.length > 0) {
        emit({ k: 'autolink', href: auto.href, text: auto.text });
        i += auto.text.length;
        continue;
      }
    }
    addBuf(ch);
    i += 1;
  }
  flush();
  return tokens;
}

// The closing ~~ for a strikethrough opener: the next ~~ whose
// preceding character is not whitespace.
function findDelClose(src, from) {
  let i = from;
  for (;;) {
    const idx = src.indexOf('~~', i);
    if (idx === -1) return -1;
    const before = src[idx - 1];
    if (before !== ' ' && before !== '\t' && before !== '\n' && idx > from) return idx;
    i = idx + 2;
  }
}

// The CommonMark delimiter-run algorithm over the token list.
function processDelimiters(tokens) {
  const delims = [];
  for (let idx = 0; idx < tokens.length; idx++) {
    if (tokens[idx].k === 'delim') delims.push(idx);
  }
  let ci = 0;
  while (ci < delims.length) {
    const closeIdx = delims[ci];
    const closer = tokens[closeIdx];
    if (!closer || closer.k !== 'delim' || !closer.canClose || closer.len === 0) { ci += 1; continue; }
    // Find the nearest matching opener below the closer.
    let oi = ci - 1;
    let matched = false;
    while (oi >= 0) {
      const openIdx = delims[oi];
      const opener = tokens[openIdx];
      if (!opener || opener.k !== 'delim' || opener.ch !== closer.ch || !opener.canOpen || opener.len === 0) { oi -= 1; continue; }
      // Rule of three.
      if ((closer.canOpen || opener.canClose) &&
          (opener.len + closer.len) % 3 === 0 &&
          !(opener.len % 3 === 0 && closer.len % 3 === 0)) {
        oi -= 1;
        continue;
      }
      const use = opener.len >= 2 && closer.len >= 2 ? 2 : 1;
      opener.len -= use;
      closer.len -= use;
      const inner = tokens.splice(openIdx + 1, closeIdx - openIdx - 1);
      const node = { k: use === 2 ? 'strong' : 'em', children: inner };
      tokens.splice(openIdx + 1, 0, node);
      // Delimiter indices between opener and closer are gone; fix up.
      const removed = closeIdx - openIdx - 1;
      for (let d = oi + 1; d < ci; d++) delims[d] = -1;
      for (let d = ci; d < delims.length; d++) delims[d] -= removed - 1;
      matched = true;
      break;
    }
    if (!matched) ci += 1;
    // When matched with length left on the closer, retry the same
    // closer against earlier openers.
  }
  // Turn leftover delimiters back into literal text.
  for (let idx = 0; idx < tokens.length; idx++) {
    const t = tokens[idx];
    if (t.k === 'delim') tokens[idx] = { k: 'text', s: t.ch.repeat(t.len) };
  }
}

function renderTokens(tokens, defs) {
  let out = '';
  for (const t of tokens) {
    if (t.k === 'text') out += t.raw ? t.s : escapeHtml(ieDecode(t.s), false);
    else if (t.k === 'delim') out += escapeHtml(ieDecode(t.ch.repeat(t.len)), false);
    else if (t.k === 'escape') out += escapeHtml(t.s, false);
    else if (t.k === 'code') out += '<code>' + escapeHtml(t.s, true) + '</code>';
    else if (t.k === 'html') out += t.s;
    else if (t.k === 'br') out += '<br>';
    else if (t.k === 'em') out += '<em>' + renderTokens(t.children, defs) + '</em>';
    else if (t.k === 'strong') out += '<strong>' + renderTokens(t.children, defs) + '</strong>';
    else if (t.k === 'del') out += '<del>' + renderTokens(t.children, defs) + '</del>';
    else if (t.k === 'link') {
      const cleaned = cleanUrl(t.href);
      const inner = renderTokens(t.children, defs);
      if (cleaned === null) { out += inner; continue; }
      out += '<a href="' + escapeHtml(cleaned, false) + '"';
      if (t.title) out += ' title="' + escapeHtml(t.title, false) + '"';
      out += '>' + inner + '</a>';
    } else if (t.k === 'image') {
      const cleaned = cleanUrl(t.href);
      const alt = plainTextOf(t.altSrc, defs);
      if (cleaned === null) { out += escapeHtml(alt, false); continue; }
      out += '<img src="' + escapeHtml(cleaned, false) + '" alt="' + escapeHtml(alt, false) + '"';
      if (t.title) out += ' title="' + escapeHtml(t.title, false) + '"';
      out += '>';
    } else if (t.k === 'autolink') {
      const cleaned = cleanUrl(t.href);
      if (cleaned === null) { out += escapeHtml(t.text, true); continue; }
      out += '<a href="' + escapeHtml(cleaned, true) + '">' + escapeHtml(t.text, true) + '</a>';
    }
  }
  return out;
}

// The plain-text content of an image's alt source.
function plainTextOf(altSrc, defs) {
  const tokens = tokenizeInline(altSrc, defs, { inLink: false, formedLink: false });
  const walk = (list) => {
    let s = '';
    for (const t of list) {
      if (t.k === 'text') s += t.raw ? t.s : ieDecode(t.s);
      else if (t.k === 'delim') s += t.ch.repeat(t.len);
      else if (t.k === 'escape') s += t.s;
      else if (t.k === 'code') s += t.s;
      else if (t.k === 'html') s += '';
      else if (t.k === 'br') s += '';
      else if (t.k === 'em' || t.k === 'strong' || t.k === 'del') s += walk(t.children);
      else if (t.k === 'link') s += walk(t.children);
      else if (t.k === 'image') s += plainTextOf(t.altSrc, defs);
      else if (t.k === 'autolink') s += t.text;
    }
    return s;
  };
  return walk(tokens);
}

function renderInline(src, defs) {
  return renderTokens(tokenizeInline(src, defs, { inLink: false, formedLink: false }), defs);
}

function findCodeSpanClose(src, from, run) {
  let i = from;
  while (i < src.length) {
    if (src[i] === '`') {
      let r = 0;
      while (src[i + r] === '`') r += 1;
      if (r === run) return i;
      i += r;
    } else i += 1;
  }
  return -1;
}

// ---------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------

export function parse(markdown) {
  if (typeof markdown !== 'string') throw new TypeError('parse expects a string');
  const src = markdown.replace(/\r\n|\r/g, '\n');
  lexerState.inLink = false;
  lexerState.inRawBlock = false;
  const defs = new Map();
  const nodes = parseBlockList(src, defs);
  return renderNodes(nodes, defs);
}

// ---------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------

// Recognise a list marker at the start of a line: a bullet (-, +, *)
// or an ordered marker (1-9 digits then . or )), after at most 3
// columns of indentation, followed by whitespace or end of line.
function listMarker(line) {
  const ind = measureIndent(line);
  if (ind.cols > 3) return null;
  const rest = line.slice(ind.chars);
  let m = /^([*+-])(?=[ \t]|$)/.exec(rest);
  if (m) {
    return { indent: ind, ordered: false, bullet: m[1], delim: '', number: 0, markerChars: 1 };
  }
  m = /^(\d{1,9})([.)])(?=[ \t]|$)/.exec(rest);
  if (m) {
    return { indent: ind, ordered: true, bullet: '', delim: m[2], number: parseInt(m[1], 10), markerChars: m[1].length + 1 };
  }
  return null;
}

function sameListMarker(line, list) {
  const mk = listMarker(line);
  if (!mk || mk.ordered !== list.ordered) return null;
  if (list.ordered ? mk.delim !== list.delim : mk.bullet !== list.bullet) return null;
  return mk;
}

// Collect one list item whose marker line starts at `pos`.
// Returns { lines, end, spannedBlank } where `end` is the offset of
// the first line that no longer belongs to the item and
// `spannedBlank` says a blank line sits between two parts of the item.
function readListItem(src, pos, mk, contentIndent) {
  const first = nextLine(src, pos);
  const afterMarker = first.text.slice(mk.indent.chars + mk.markerChars);
  const firstContent = dropColumns(afterMarker, mk.indent.cols + mk.markerChars, contentIndent - mk.indent.cols - mk.markerChars);
  const lines = [firstContent];
  let cursor = first.next;
  let contentEnd = cursor;
  let pendingBlanks = 0;
  let spannedBlank = false;
  // A fence opened inside the item swallows following lines until it
  // closes, even lines that are not indented into the item.
  let openFence = fenceStart(firstContent);
  while (cursor < src.length) {
    const ln = nextLine(src, cursor);
    if (openFence) {
      const dedented = measureIndent(ln.text).cols >= contentIndent
        ? dropColumns(ln.text, 0, contentIndent)
        : ln.text;
      if (pendingBlanks > 0) spannedBlank = true;
      for (let b = 0; b < pendingBlanks; b++) lines.push('');
      pendingBlanks = 0;
      lines.push(dedented);
      cursor = ln.next;
      contentEnd = cursor;
      if (fenceClose(dedented, openFence)) openFence = null;
      continue;
    }
    if (isBlankLine(ln.text)) {
      // A blank line before the item has any content ends the item.
      if (!lines.some(l => l.trim() !== '')) break;
      pendingBlanks += 1; cursor = ln.next; continue;
    }
    const lineIndent = measureIndent(ln.text).cols;
    if (lineIndent >= contentIndent) {
      if (pendingBlanks > 0) spannedBlank = true;
      for (let b = 0; b < pendingBlanks; b++) lines.push('');
      pendingBlanks = 0;
      const dedented = dropColumns(ln.text, 0, contentIndent);
      lines.push(dedented);
      if (!openFence) openFence = fenceStart(dedented);
      cursor = ln.next;
      contentEnd = cursor;
      continue;
    }
    // A line starting a new list item never joins this item.
    if (listMarker(ln.text)) break;
    // Not indented enough: the item continues only as a lazy
    // paragraph continuation, and only with no blank line before it.
    if (pendingBlanks === 0 && lines.length && itemLazyOk(lines, ln.text)) {
      lines.push(setextLevel(ln.text) ? ' ' + ln.text.replace(/^ {0,3}/, '') : ln.text);
      cursor = ln.next;
      contentEnd = cursor;
      continue;
    }
    break;
  }
  return { lines, end: contentEnd, spannedBlank };
}

function itemLazyOk(lines, line) {
  // A thematic break line never joins the item (it ends the list),
  // even though it could double as a setext underline.
  if (isThematicBreak(line)) return false;
  const text = lines.join('\n');
  const nodes = parseBlocksInto(text, new Map(), [], { top: false });
  if (nodes.length === 0) return false;
  if (setextLevel(line)) {
    // A setext underline joins the item when it completes a heading.
    const test = parseBlocksInto(text + '\n' + line, new Map(), [], { top: false });
    return test.length > 0 && test[test.length - 1].t === 'h';
  }
  if (interruptsParagraph(line, null)) return false;
  return endsInOpenParagraph(nodes);
}

// The columns of whitespace after a marker on its line, counted with
// tabs at their original columns, and whether any content follows.
function markerSpaceAfter(firstLine, mk) {
  const after = firstLine.slice(mk.indent.chars + mk.markerChars);
  let col = mk.indent.cols + mk.markerChars;
  let cols = 0;
  let i = 0;
  while (i < after.length && (after[i] === ' ' || after[i] === '\t')) {
    const width = after[i] === '\t' ? 4 - (col % 4) : 1;
    col += width;
    cols += width;
    i += 1;
  }
  return { cols, hasContent: i < after.length };
}

// Collect a whole list starting at `pos`.
function readList(src, pos, defs) {
  const firstLine = nextLine(src, pos);
  const first = listMarker(firstLine.text);
  const list = {
    t: 'list',
    ordered: first.ordered,
    bullet: first.bullet,
    delim: first.delim,
    start: first.number,
    loose: false,
    items: [],
  };
  let cursor = pos;
  let end = pos;
  while (cursor < src.length) {
    const ln = nextLine(src, cursor);
    if (isThematicBreak(ln.text)) break; // a break line ends the list
    const mk = sameListMarker(ln.text, list);
    if (!mk) break;
    const { cols, hasContent } = markerSpaceAfter(ln.text, mk);
    let spaceAfter = hasContent ? cols : 1;
    if (spaceAfter > 4) spaceAfter = 1;
    const contentIndent = mk.indent.cols + mk.markerChars + spaceAfter;
    const item = readListItem(src, cursor, mk, contentIndent);
    // Build the item's blocks (non-top mode: text runs stay text).
    // Marked trims trailing spaces and tabs from the item text.
    const innerLines = item.lines;
    const itemText = innerLines.join('\n').replace(/[ \t]+$/, '');
    const tracker = {};
    const children = parseBlocksInto(itemText, defs, [], { top: false, tracker });
    if (tracker.spaceLoose) list.loose = true;
    // Task lists: a checkbox is recognised when the item's first
    // block is a text run starting with '[ ]' / '[x]' plus space.
    let task = false;
    let checked = false;
    const first = children[0];
    if (first && (first.t === 'text' || first.t === 'p')) {
      const tm = /^\[([ xX])\][ \t]+(?=\S)/.exec(first.text);
      if (tm) {
        task = true;
        checked = tm[1] !== ' ';
        first.text = first.text.slice(tm[0].length);
      }
    }
    list.items.push({ children, task, checked });
    cursor = item.end;
    end = cursor;
    // Blank lines between this item and the next loosen the list;
    // trailing blank lines at the end of the list do not.
    let blanks = 0;
    let scan = cursor;
    while (scan < src.length) {
      const bl = nextLine(src, scan);
      if (!isBlankLine(bl.text)) break;
      blanks += 1;
      scan = bl.next;
    }
    if (scan < src.length && sameListMarker(nextLine(src, scan).text, list)) {
      if (blanks > 0) list.loose = true;
      cursor = scan;
      end = cursor;
    } else {
      break;
    }
  }
  return { node: list, end };
}

function renderList(node, defs) {
  const tag = node.ordered ? 'ol' : 'ul';
  let out = '<' + tag + (node.ordered && node.start !== 1 ? ' start="' + node.start + '"' : '') + '>\n';
  for (const item of node.items) {
    out += '<li>' + renderListItem(item, node.loose, defs) + '</li>\n';
  }
  return out + '</' + tag + '>\n';
}

function renderListItem(item, loose, defs) {
  const box = item.task
    ? '<input ' + (item.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox">'
    : null;
  if (!loose) {
    let inner = '';
    for (const child of item.children) {
      inner += child.t === 'text' || child.t === 'p'
        ? renderInline(child.text, defs)
        : renderNodes([child], defs);
    }
    return box ? box + ' ' + inner : inner;
  }
  // Loose: text runs render as paragraphs; the checkbox token is
  // placed inside the first paragraph when there is one.
  let inner = '';
  item.children.forEach((child, idx) => {
    if (child.t === 'text' || child.t === 'p') {
      const prefix = idx === 0 && box ? box + ' ' : '';
      inner += '<p>' + prefix + renderInline(child.text, defs) + '</p>\n';
    } else {
      inner += renderNodes([child], defs);
    }
  });
  if (box && !(item.children[0] && (item.children[0].t === 'text' || item.children[0].t === 'p'))) {
    inner = box + ' ' + inner;
  }
  return inner;
}
