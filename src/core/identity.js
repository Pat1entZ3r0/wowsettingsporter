'use strict';
// Character identities and the rewrite rules that move data from one to another.
//
// On WoW Forever a character is "First Surname", and realms are gone: AceDB (r39+) keys a
// character by "First Surname" alone and uses the ruleset as its realm key ("PvE", "PvP",
// "RP", "Hardcore"), so faction-realm data lives under "Alliance - PvE". Addons on an older
// AceDB still key by "First - <GetRealmName()>", and some store the character GUID
// ("Player-<realmId>-<hex>"). Every one of those forms is handled here.
//
// All matching runs on latin1 strings (one char per byte), the way SavedVariables are read,
// so UTF-8 names with accents match byte for byte.

const RULESETS = [
  { key: 'PvE', label: 'Normal' },
  { key: 'PvP', label: 'PvP' },
  { key: 'RP', label: 'Roleplaying' },
  { key: 'Hardcore', label: 'Hardcore' },
];
const RULESET_KEYS = RULESETS.map((r) => r.key);
const FACTIONS = ['Alliance', 'Horde', 'Neutral'];
const GUID_RE = /^Player-(\d+)-([0-9A-Fa-f]{8,})$/;

function bytes(s) {
  return Buffer.from(String(s ?? ''), 'utf8').toString('latin1');
}
function text(latin1) {
  return Buffer.from(latin1, 'latin1').toString('utf8');
}

function fullName(id) {
  return id.last ? `${id.first} ${id.last}` : id.first;
}

// "Alice-Smith" -> { first: 'Alice', last: 'Smith' }. Forever names have no hyphens, so the
// first hyphen (or space) splits a character folder name.
function splitFolderName(folder) {
  const m = /^([^- ]+)[- ](.+)$/.exec(folder);
  return m ? { first: m[1], last: m[2] } : { first: folder, last: '' };
}

// The character folder name for a target, following the source folder's pattern.
function folderNameFor(sourceFolder, source, target) {
  if (source && sourceFolder && source.first && sourceFolder.startsWith(source.first)) {
    const rest = sourceFolder.slice(source.first.length);
    if (source.last && rest.endsWith(source.last)) {
      const sep = rest.slice(0, rest.length - source.last.length);
      return target.last ? target.first + sep + target.last : target.first;
    }
    if (!source.last && rest === '') return target.last ? `${target.first}-${target.last}` : target.first;
  }
  return target.last ? `${target.first}-${target.last}` : target.first;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Letters, digits and UTF-8 bytes count as part of a word: "Alice Smith" must not match
// inside "Alice Smithers", nor "- 70" inside "- 701".
const WORD = 'A-Za-z0-9\\x80-\\xff';

/**
 * Builds the rewrite rules from a source identity to a target one.
 * An identity: { first, last, ruleset, realmName, faction, guid } (UTF-8 strings, '' if unknown).
 * Options: { firstNameOnly } rewrites strings that are exactly the first name.
 */
function buildRules(src, tgt, options = {}) {
  const sub = []; // [from, to, label], matched inside any string, at word boundaries
  const exact = []; // [from, to, label], whole string only (keys and values)
  const keyOnly = []; // [from, to, label, parentKey|null], table keys only
  const add = (list, from, to, label, extra) => {
    if (!from || from === to || to === undefined || to === null) return;
    list.push(extra === undefined ? [bytes(from), bytes(to), label] : [bytes(from), bytes(to), label, extra]);
  };

  const sFull = fullName(src);
  const tFull = fullName(tgt);
  const sFaction = src.faction || '';
  const tFaction = tgt.faction || sFaction;

  if (src.realmName && tgt.realmName) {
    const sR = src.realmName;
    const tR = tgt.realmName;
    add(sub, `${sFull} - ${sR}`, `${tFull} - ${tR}`, 'character key (name - realm)');
    add(sub, `${src.first} - ${sR}`, `${tgt.first} - ${tR}`, 'character key (first name - realm)');
    add(sub, `${sFull}-${sR.replace(/\s/g, '')}`, `${tFull}-${tR.replace(/\s/g, '')}`, 'character key (name-realm)');
    add(sub, `${src.first}-${sR.replace(/\s/g, '')}`, `${tgt.first}-${tR.replace(/\s/g, '')}`, 'character key (first name-realm)');
    for (const f of sFaction ? [sFaction] : FACTIONS) {
      add(sub, `${f} - ${sR}`, `${sFaction ? tFaction : f} - ${tR}`, 'faction - realm');
    }
    if (!/^\d+$/.test(sR) && sR.length >= 3) {
      add(exact, sR, tR, 'realm name');
    }
  }

  if (src.ruleset && tgt.ruleset) {
    for (const f of sFaction ? [sFaction] : FACTIONS) {
      add(sub, `${f} - ${src.ruleset}`, `${sFaction ? tFaction : f} - ${tgt.ruleset}`, 'faction - ruleset');
    }
    // AceDB's realm section: db.sv.realm["PvE"]
    add(keyOnly, src.ruleset, tgt.ruleset, 'ruleset (realm section)', 'realm');
  } else if (sFaction && tFaction !== sFaction) {
    for (const r of RULESET_KEYS) add(sub, `${sFaction} - ${r}`, `${tFaction} - ${r}`, 'faction - ruleset');
  }

  add(sub, sFull, tFull, 'character name');
  if (src.last && tgt.last) {
    add(sub, `${src.first}-${src.last}`, `${tgt.first}-${tgt.last}`, 'character name (folder form)');
    add(sub, `${src.first}${src.last}`, `${tgt.first}${tgt.last}`, 'character name (joined)');
  }
  if (src.guid && tgt.guid) add(sub, src.guid, tgt.guid, 'character GUID');
  if (options.firstNameOnly !== false && src.last) add(exact, src.first, tgt.first, 'first name');

  return { sub, exact, keyOnly };
}

// Strings that identify other characters of the source account; table entries keyed by
// them are left out of a snapshot applied elsewhere.
function otherCharacterKeys(others, src) {
  const keys = new Set();
  const sFull = fullName(src);
  for (const o of others) {
    const full = fullName(o);
    if (!o.first || full === sFull) continue;
    keys.add(bytes(full));
    if (o.last) keys.add(bytes(`${o.first}-${o.last}`));
    if (src.realmName) {
      keys.add(bytes(`${full} - ${src.realmName}`));
      keys.add(bytes(`${full}-${src.realmName.replace(/\s/g, '')}`));
      if (o.first !== src.first) {
        keys.add(bytes(`${o.first} - ${src.realmName}`));
        keys.add(bytes(`${o.first}-${src.realmName.replace(/\s/g, '')}`));
      }
    }
    if (o.guid) keys.add(bytes(o.guid));
  }
  return keys;
}

function compileRules(rules) {
  const subMap = new Map();
  for (const [from, to, label] of rules.sub) if (!subMap.has(from)) subMap.set(from, { to, label });
  const alts = [...subMap.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
  const re = alts.length ? new RegExp(`(?<![${WORD}])(?:${alts.join('|')})(?![${WORD}])`, 'g') : null;
  const exactMap = new Map();
  for (const [from, to, label] of rules.exact) if (!exactMap.has(from)) exactMap.set(from, { to, label });
  const keyMap = new Map();
  for (const [from, to, label, parent] of rules.keyOnly) keyMap.set(from, { to, label, parent });
  return { re, subMap, exactMap, keyMap };
}

// Rewrites one latin1 string. Records every change in `stats` (Map "from -> to" => count).
function rewriteString(s, compiled, stats, isKey, parentKey) {
  if (isKey && compiled.keyMap.has(s)) {
    const k = compiled.keyMap.get(s);
    if (!k.parent || k.parent === parentKey) {
      note(stats, s, k.to, k.label);
      return k.to;
    }
  }
  if (compiled.exactMap.has(s)) {
    const e = compiled.exactMap.get(s);
    note(stats, s, e.to, e.label);
    return e.to;
  }
  if (!compiled.re) return s;
  compiled.re.lastIndex = 0;
  if (!compiled.re.test(s)) return s;
  compiled.re.lastIndex = 0;
  return s.replace(compiled.re, (m) => {
    const r = compiled.subMap.get(m);
    note(stats, m, r.to, r.label);
    return r.to;
  });
}

function note(stats, from, to, label) {
  if (!stats) return;
  const id = from + '\u0000' + to;
  const cur = stats.get(id);
  if (cur) cur.count++;
  else stats.set(id, { from: text(from), to: text(to), label, count: 1 });
}

/**
 * Rewrites a parsed SavedVariables file in place. Keys renamed onto a key that already exists
 * in the same table win over it (they carry the snapshot's data). Entries keyed by another
 * character (dropKeys) are removed.
 * Returns { stats: [{from,to,label,count}], dropped: number }.
 */
function rewriteFile(file, compiled, dropKeys) {
  const stats = new Map();
  let dropped = 0;

  function walk(node, parentKey) {
    if (node.type === 'string') {
      node.value = rewriteString(node.value, compiled, stats, false, parentKey);
      return;
    }
    if (node.type !== 'table') return;
    const out = [];
    const seen = new Map(); // key -> { index, renamed }
    for (const e of node.entries) {
      let renamed = false;
      let keyName = null;
      if (e.key && e.key.type === 'string') {
        // only keyed entries are dropped: lists naming other characters are data, not slots
        if (dropKeys && dropKeys.has(e.key.value)) {
          dropped++;
          continue;
        }
        const nk = rewriteString(e.key.value, compiled, stats, true, parentKey);
        renamed = nk !== e.key.value;
        e.key.value = nk;
        keyName = nk;
      }
      walk(e.value, keyName);
      if (keyName !== null) {
        const prev = seen.get(keyName);
        if (prev) {
          // a renamed key replaces the stale entry it lands on; otherwise the last one wins, as in Lua
          if (renamed || !prev.renamed) {
            out[prev.index] = e;
            prev.renamed = renamed;
          }
          continue;
        }
        seen.set(keyName, { index: out.length, renamed });
      }
      out.push(e);
    }
    node.entries = out;
  }

  for (const a of file.assignments) walk(a.value, a.name);
  return { stats: [...stats.values()], dropped };
}

// Rewrites a plain text file (macros-cache.txt, chat-cache.txt...) held as latin1.
function rewriteText(content, compiled) {
  const stats = new Map();
  if (!compiled.re) return { content, stats: [] };
  compiled.re.lastIndex = 0;
  const out = content.replace(compiled.re, (m) => {
    const r = compiled.subMap.get(m);
    note(stats, m, r.to, r.label);
    return r.to;
  });
  return { content: out, stats: [...stats.values()] };
}

// ---- detection -----------------------------------------------------------------------

function* walkTables(node, path = []) {
  if (!node || node.type !== 'table') return;
  yield { node, path };
  for (const e of node.entries) {
    const k = e.key && e.key.type === 'string' ? e.key.value : null;
    yield* walkTables(e.value, path.concat([k]));
  }
}

function inc(map, k, by = 1) {
  map.set(k, (map.get(k) || 0) + by);
}
function top(map) {
  let best = '';
  let n = 0;
  for (const [k, v] of map) if (v > n) { best = k; n = v; }
  return best;
}

/**
 * Looks through parsed SavedVariables for what an identity looks like in them.
 * files: [{ file, perCharacter: bool }]. Returns { ruleset, realmName, faction, guid,
 * evidence: { ... } } with UTF-8 strings ('' where nothing was found).
 */
function detectIdentity(files, first, last, realmFolder) {
  const full = bytes(last ? `${first} ${last}` : first);
  const f = bytes(first);
  const rulesets = new Map();
  const factions = new Map();
  const realms = new Map();
  const guids = new Map();
  const nameRe = new RegExp(`^(?:${escapeRe(full)}|${escapeRe(f)}) - (.+)$`);
  const factionRe = /^(Alliance|Horde|Neutral) - ([^-]+?)(?: - [A-Z]{2})?$/;

  for (const { file, perCharacter } of files) {
    for (const a of file.assignments) {
      for (const { node, path } of walkTables(a.value, [a.name])) {
        const own = path[path.length - 1];
        let mentionsMe = own === full || own === f || (own !== null && nameRe.test(own));
        const tableGuids = [];
        for (const e of node.entries) {
          const k = e.key && e.key.type === 'string' ? e.key.value : null;
          const v = e.value.type === 'string' ? e.value.value : null;
          for (const s of [k, v]) {
            if (s === null) continue;
            if (s === full || s === f) mentionsMe = true;
            const m = nameRe.exec(s);
            if (m) {
              mentionsMe = true;
              if (!RULESET_KEYS.includes(m[1])) inc(realms, m[1]);
            }
            const g = GUID_RE.exec(s);
            if (g) tableGuids.push(s);
          }
          if (k !== null) {
            const fm = factionRe.exec(k);
            if (fm) {
              inc(factions, fm[1]);
              if (RULESET_KEYS.includes(fm[2])) inc(rulesets, fm[2], 2);
            }
            if (path[path.length - 1] === 'realm' && RULESET_KEYS.includes(k)) inc(rulesets, k);
          }
        }
        for (const g of tableGuids) {
          const sameRealm = realmFolder && GUID_RE.exec(g)[1] === String(realmFolder);
          if (mentionsMe) inc(guids, g, sameRealm ? 3 : 2);
          else if (perCharacter && sameRealm) inc(guids, g, 1);
        }
      }
    }
  }
  return {
    ruleset: top(rulesets),
    realmName: text(top(realms)),
    faction: top(factions),
    guid: text(top(guids)),
    evidence: {
      rulesets: Object.fromEntries(rulesets),
      factions: Object.fromEntries(factions),
      realms: Object.fromEntries([...realms].map(([k, v]) => [text(k), v])),
      guids: Object.fromEntries([...guids].map(([k, v]) => [text(k), v])),
    },
  };
}

module.exports = {
  RULESETS, RULESET_KEYS, FACTIONS, GUID_RE,
  bytes, text, fullName, splitFolderName, folderNameFor,
  buildRules, compileRules, otherCharacterKeys, rewriteFile, rewriteText, rewriteString, detectIdentity,
};
