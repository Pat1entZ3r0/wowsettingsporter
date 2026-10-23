'use strict';
// Parser and writer for WoW SavedVariables files.
//
// SavedVariables are Lua 5.1 chunks made of `Name = <constructor>` assignments. They are
// read as latin1 ("binary") text so every byte survives a round trip untouched: strings in
// them are raw bytes (UTF-8 names, serialized addon payloads), never re-encoded here.
//
// AST nodes:
//   { type: 'table', entries: [{ key: Node | null, value: Node }] }   key null = positional
//   { type: 'string', value }        value is a latin1 string (one char per byte)
//   { type: 'number', raw }          raw source text, written back as-is
//   { type: 'boolean', value }
//   { type: 'nil' }
//   { type: 'raw', raw }             any other expression (math.huge, 1/0, ...), kept verbatim
// A file is { assignments: [{ name, value }] }.

class LuaParseError extends Error {
  constructor(message, pos, src) {
    const line = src ? src.slice(0, pos).split('\n').length : 0;
    super(`${message} (line ${line})`);
    this.pos = pos;
    this.line = line;
  }
}

const IDENT_START = /[A-Za-z_]/;
const NAME_RE = /[A-Za-z_][A-Za-z0-9_]*/y;
const NUMBER_RE = /0[xX][0-9A-Fa-f]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

function parse(src) {
  let pos = 0;
  const n = src.length;

  function fail(msg) {
    throw new LuaParseError(msg, pos, src);
  }

  function skipLongBracket() {
    // at '[', returns content or null if this is not a long bracket
    const m = /^\[(=*)\[/.exec(src.slice(pos, pos + 64));
    if (!m) return null;
    const close = ']' + m[1] + ']';
    const start = pos + m[0].length;
    const end = src.indexOf(close, start);
    if (end < 0) fail('unfinished long bracket');
    pos = end + close.length;
    let body = src.slice(start, end);
    if (body.startsWith('\r\n')) body = body.slice(2);
    else if (body.startsWith('\n') || body.startsWith('\r')) body = body.slice(1);
    return body;
  }

  function isLongBracket(at) {
    if (src.charCodeAt(at) !== 0x5b) return false;
    let i = at + 1;
    while (src.charCodeAt(i) === 0x3d) i++;
    return src.charCodeAt(i) === 0x5b;
  }

  function skipWs() {
    for (;;) {
      for (;;) {
        const c = src.charCodeAt(pos);
        if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0b || c === 0x0c) pos++;
        else break;
      }
      if (src.charCodeAt(pos) === 0x2d && src.charCodeAt(pos + 1) === 0x2d) {
        pos += 2;
        if (isLongBracket(pos)) {
          skipLongBracket();
        } else {
          while (pos < n && src[pos] !== '\n') pos++;
        }
        continue;
      }
      // a BOM some editors add in front of the file
      if (pos === 0 && src.startsWith('ï»¿')) {
        pos = 3;
        continue;
      }
      break;
    }
  }

  function readName() {
    NAME_RE.lastIndex = pos;
    const m = NAME_RE.exec(src);
    if (!m) fail('expected a name');
    pos += m[0].length;
    return m[0];
  }

  function readString() {
    const q = src.charCodeAt(pos++);
    let out = '';
    for (;;) {
      // copy the run up to the next quote, backslash or line end in one slice
      const start = pos;
      let c = src.charCodeAt(pos);
      while (pos < n && c !== q && c !== 0x5c && c !== 0x0a) c = src.charCodeAt(++pos);
      if (pos > start) out += src.slice(start, pos);
      if (pos >= n || c === 0x0a) fail('unfinished string');
      pos++;
      if (c === q) return out;
      const e = src[pos++];
      switch (e) {
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case 'a': out += '\x07'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'v': out += '\v'; break;
        case '\\': out += '\\'; break;
        case '"': out += '"'; break;
        case "'": out += "'"; break;
        case '\n': out += '\n'; if (src[pos] === '\r') pos++; break;
        case '\r': out += '\n'; if (src[pos] === '\n') pos++; break;
        case 'x': {
          const h = src.slice(pos, pos + 2);
          if (!/^[0-9A-Fa-f]{2}$/.test(h)) fail('bad \\x escape');
          out += String.fromCharCode(parseInt(h, 16));
          pos += 2;
          break;
        }
        case 'z':
          while (pos < n && /\s/.test(src[pos])) pos++;
          break;
        default:
          if (e >= '0' && e <= '9') {
            let d = e;
            while (d.length < 3 && src[pos] >= '0' && src[pos] <= '9') d += src[pos++];
            const v = parseInt(d, 10);
            if (v > 255) fail('escape too large');
            out += String.fromCharCode(v);
          } else {
            fail('bad escape \\' + e);
          }
      }
    }
  }

  function readNumber(neg) {
    NUMBER_RE.lastIndex = pos;
    const m = NUMBER_RE.exec(src);
    if (!m) fail('bad number');
    pos += m[0].length;
    return { type: 'number', raw: (neg ? '-' : '') + m[0] };
  }

  // An expression this parser doesn't model (math.huge, 1/0, function calls): kept as
  // its source text up to the next separator at bracket depth 0.
  function readRaw(start) {
    let depth = 0;
    pos = start;
    while (pos < n) {
      const c = src[pos];
      if (c === '"' || c === "'") { readString(); continue; }
      if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') {
        if (depth === 0) break;
        depth--;
      } else if ((c === ',' || c === ';') && depth === 0) break;
      else if (c === '\n' && depth === 0) {
        // a top level assignment ends at the line end
        const rest = src.slice(pos + 1);
        if (/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.test(rest) || /^\s*$/.test(rest)) break;
      }
      pos++;
    }
    const raw = src.slice(start, pos).trim();
    if (!raw) fail('expected a value');
    return { type: 'raw', raw };
  }

  function readValue() {
    skipWs();
    const start = pos;
    const c = src[pos];
    let v;
    if (c === '{') v = readTable();
    else if (c === '"' || c === "'") v = { type: 'string', value: readString() };
    else if (isLongBracket(pos)) v = { type: 'string', value: skipLongBracket() };
    else if (c === '-' && src[pos + 1] !== '-') {
      pos++;
      skipWs();
      if (/[0-9.]/.test(src[pos] || '')) v = readNumber(true);
      else return readRaw(start);
    } else if (/[0-9.]/.test(c || '')) v = readNumber(false);
    else if (IDENT_START.test(c || '')) {
      const name = readName();
      if (name === 'true' || name === 'false') v = { type: 'boolean', value: name === 'true' };
      else if (name === 'nil') v = { type: 'nil' };
      else return readRaw(start);
    } else fail('unexpected character ' + JSON.stringify(c));
    // An operator before the separator (1/0, 2^53) makes it a raw expression. A name can
    // follow only at the top level, where it starts the next assignment.
    const save = pos;
    skipWs();
    const next = src[pos];
    pos = save;
    if (next !== undefined && !',;}]'.includes(next) && !IDENT_START.test(next)) {
      return readRaw(start);
    }
    return v;
  }

  function readTable() {
    pos++; // {
    const entries = [];
    for (;;) {
      skipWs();
      if (src[pos] === '}') { pos++; return { type: 'table', entries }; }
      if (pos >= n) fail('unfinished table');
      let key = null;
      if (src[pos] === '[' && !isLongBracket(pos)) {
        pos++;
        key = readValue();
        skipWs();
        if (src[pos] !== ']') fail("expected ']'");
        pos++;
        skipWs();
        if (src[pos] !== '=') fail("expected '='");
        pos++;
      } else if (IDENT_START.test(src[pos])) {
        const save = pos;
        const name = readName();
        skipWs();
        if (src[pos] === '=' && src[pos + 1] !== '=') {
          pos++;
          key = { type: 'string', value: name };
        } else {
          pos = save;
        }
      }
      const value = readValue();
      entries.push({ key, value });
      skipWs();
      if (src[pos] === ',' || src[pos] === ';') pos++;
      else if (src[pos] !== '}') fail("expected ',' or '}'");
    }
  }

  const assignments = [];
  for (;;) {
    skipWs();
    if (pos >= n) break;
    const name = readName();
    skipWs();
    if (src[pos] !== '=') fail("expected '=' after " + name);
    pos++;
    const value = readValue();
    assignments.push({ name, value });
    skipWs();
    if (src[pos] === ';') pos++;
  }
  return { assignments };
}

const NEEDS_ESCAPE = /[\x00-\x1f\x7f\\"]/;

function quote(s) {
  if (!NEEDS_ESCAPE.test(s)) return '"' + s + '"';
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x5c) out += '\\\\';
    else if (c === 0x22) out += '\\"';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0d) out += '\\r';
    else if (c < 0x20 || c === 0x7f) {
      // three digits, so a digit that follows can't extend the escape
      out += '\\' + String(c).padStart(3, '0');
    } else out += s[i];
  }
  return out + '"';
}

function keyText(key) {
  switch (key.type) {
    case 'string': return '[' + quote(key.value) + ']';
    case 'number': return '[' + key.raw + ']';
    case 'boolean': return '[' + String(key.value) + ']';
    case 'raw': return '[' + key.raw + ']';
    default: throw new Error('unsupported key type ' + key.type);
  }
}

function numberValue(node) {
  const r = node.raw.trim();
  if (/^-?0[xX]/.test(r)) return (r.startsWith('-') ? -1 : 1) * parseInt(r.replace(/^-?0[xX]/, ''), 16);
  return Number(r);
}

// Writes a node the way the WoW client writes SavedVariables: one entry per line, tab
// indents, every string key in [""] form, the leading run of positional values with a
// "-- [n]" comment.
function serializeValue(node, indent) {
  switch (node.type) {
    case 'string': return quote(node.value);
    case 'number': return node.raw;
    case 'boolean': return String(node.value);
    case 'nil': return 'nil';
    case 'raw': return node.raw;
    case 'table': {
      if (node.entries.length === 0) return '{\n' + indent + '}';
      const inner = indent + '\t';
      let out = '{\n';
      let nextIndex = 1;
      let positional = true;
      for (const e of node.entries) {
        let k = e.key;
        if (positional && k === null) {
          out += inner + serializeValue(e.value, inner) + ', -- [' + nextIndex + ']\n';
          nextIndex++;
          continue;
        }
        positional = false;
        if (k === null) k = { type: 'number', raw: String(nextIndex++) };
        out += inner + keyText(k) + ' = ' + serializeValue(e.value, inner) + ',\n';
      }
      return out + indent + '}';
    }
    default: throw new Error('unknown node ' + node.type);
  }
}

function serialize(file) {
  let out = '\n';
  for (const a of file.assignments) {
    out += a.name + ' = ' + serializeValue(a.value, '') + '\n';
  }
  return out;
}

// Keys compare by type and value: the string "1" and the number 1 are different keys.
function keyId(key) {
  if (!key) return null;
  switch (key.type) {
    case 'string': return 's:' + key.value;
    case 'number': return 'n:' + numberValue(key);
    case 'boolean': return 'b:' + key.value;
    default: return 'r:' + key.raw;
  }
}

// Gives every positional entry its implicit index key, so tables can be merged by key.
function explicitKeys(table) {
  let i = 1;
  return table.entries.map((e) => (e.key ? e : { key: { type: 'number', raw: String(i++) }, value: e.value }));
}

function isArrayLike(table) {
  if (table.entries.length === 0) return false;
  let i = 1;
  for (const e of table.entries) {
    if (e.key === null) { i++; continue; }
    if (e.key.type !== 'number' || numberValue(e.key) !== i) return false;
    i++;
  }
  return true;
}

function clone(node) {
  return JSON.parse(JSON.stringify(node));
}

// Deep merges `incoming` into `base` (both table nodes) and returns a new table: keys only
// in base stay, keys in both take incoming's value, and nested tables merge, except
// list-like tables, which incoming replaces whole (merging lists by index mixes them).
function mergeTables(base, incoming) {
  if (isArrayLike(incoming) || isArrayLike(base)) return clone(incoming);
  const result = explicitKeys(base).map((e) => ({ key: e.key, value: e.value }));
  const index = new Map(result.map((e, i) => [keyId(e.key), i]));
  for (const e of explicitKeys(incoming)) {
    const id = keyId(e.key);
    if (index.has(id)) {
      const cur = result[index.get(id)];
      if (cur.value.type === 'table' && e.value.type === 'table') cur.value = mergeTables(cur.value, e.value);
      else cur.value = clone(e.value);
    } else {
      index.set(id, result.length);
      result.push({ key: clone(e.key), value: clone(e.value) });
    }
  }
  return { type: 'table', entries: result };
}

function mergeFiles(base, incoming) {
  const out = { assignments: base.assignments.map((a) => ({ name: a.name, value: a.value })) };
  const index = new Map(out.assignments.map((a, i) => [a.name, i]));
  for (const a of incoming.assignments) {
    if (index.has(a.name)) {
      const cur = out.assignments[index.get(a.name)];
      if (cur.value.type === 'table' && a.value.type === 'table') cur.value = mergeTables(cur.value, a.value);
      else cur.value = clone(a.value);
    } else {
      out.assignments.push({ name: a.name, value: clone(a.value) });
    }
  }
  return out;
}

// Plain JS view of a node, for tests and detection (string keys/values stay latin1).
function toJS(node) {
  switch (node.type) {
    case 'string': return node.value;
    case 'number': return numberValue(node);
    case 'boolean': return node.value;
    case 'nil': return null;
    case 'raw': return { raw: node.raw };
    case 'table': {
      const o = {};
      for (const e of explicitKeys(node)) {
        const k = e.key.type === 'string' ? e.key.value : e.key.type === 'number' ? numberValue(e.key) : String(e.key.value ?? e.key.raw);
        o[k] = toJS(e.value);
      }
      return o;
    }
  }
}

module.exports = {
  parse, serialize, serializeValue, quote, mergeFiles, mergeTables, toJS, keyId, isArrayLike, explicitKeys, LuaParseError,
};
