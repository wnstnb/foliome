#!/usr/bin/env node
/**
 * Read and write the household profile (config/pfs-profile.json) during the
 * interview, so every answer lands in the right place with its source.
 *
 *   node scripts/pfs/profile.js init                    copy the template if no profile exists
 *   node scripts/pfs/profile.js get <path>              print a value
 *   node scripts/pfs/profile.js set <path> <json> [--source "who said it, when"]
 *   node scripts/pfs/profile.js push <path> <json>      append to an array
 *   node scripts/pfs/profile.js open                    list interview questions still open (from derive.js)
 *   Any command takes --profile <file> (or PFS_PROFILE) to work on a different profile; PFS_DATA_DIR moves data/pfs.
 *
 * <path> is dotted, with [n] or [id=value] for array items, e.g.
 *   household.members[id=adult1].age
 *   goals[id=edu-kid1].selected
 * When --source is given and the target's parent is an object, `source` is set beside the value.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const argv = process.argv.slice(2);
const flag = n => { const i = argv.indexOf(n); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
// --profile <file> (or PFS_PROFILE) and PFS_DATA_DIR let a dry run use a scratch profile without touching the real one
const PROFILE = path.resolve(flag('--profile') || process.env.PFS_PROFILE || path.join(ROOT, 'config', 'pfs-profile.json'));
const PFS_DIR = process.env.PFS_DATA_DIR ? path.resolve(process.env.PFS_DATA_DIR) : path.join(ROOT, 'data', 'pfs');
const TEMPLATE = path.join(ROOT, 'config-templates', 'pfs-profile.json');
const [cmd, p, raw, ...rest] = argv;
const sourceArg = rest.includes('--source') ? rest[rest.indexOf('--source') + 1] : (raw === '--source' ? null : null);

function load() { return JSON.parse(fs.readFileSync(PROFILE, 'utf8')); }
function save(j) { fs.writeFileSync(PROFILE, JSON.stringify(j, null, 2) + '\n'); }
function tokens(pathStr) {
  return pathStr.match(/[^.[\]]+|\[[^\]]*\]/g).map(t => t.startsWith('[') ? { sel: t.slice(1, -1) } : { key: t });
}
function step(o, t, create) {
  if (t.key != null) { if (o[t.key] == null && create) o[t.key] = {}; return [o, t.key]; }
  if (/^\d+$/.test(t.sel)) return [o, +t.sel];
  const [k, v] = t.sel.split('=');
  const i = o.findIndex(x => String(x[k]) === v);
  if (i < 0) throw new Error(`No item with ${k}=${v}`);
  return [o, i];
}
function resolve(j, pathStr, create = false) {
  const ts = tokens(pathStr); let o = j;
  for (const t of ts.slice(0, -1)) { const [c, k] = step(o, t, create); if (c[k] == null && create) c[k] = {}; o = c[k]; }
  return step(o, ts[ts.length - 1], create);
}
const parse = v => { try { return JSON.parse(v); } catch { return v; } };

try {
  if (cmd === 'init') {
    if (fs.existsSync(PROFILE)) { console.log('Profile already exists.'); process.exit(0); }
    fs.mkdirSync(path.dirname(PROFILE), { recursive: true }); fs.copyFileSync(TEMPLATE, PROFILE); console.log(`Created ${path.relative(ROOT, PROFILE)} from the template.`);
  } else if (cmd === 'get') {
    const [o, k] = resolve(load(), p); console.log(JSON.stringify(o[k], null, 2));
  } else if (cmd === 'set' || cmd === 'push') {
    const j = load(); const [o, k] = resolve(j, p, true); const v = parse(raw);
    if (cmd === 'push') (o[k] ||= []).push(v); else o[k] = v;
    if (sourceArg && cmd === 'set' && !Array.isArray(o) && o !== j) o.source = sourceArg;
    if (sourceArg && cmd === 'set' && o === j && v && typeof v === 'object' && !Array.isArray(v) && !v.source) v.source = sourceArg;
    if (sourceArg && cmd === 'push' && v && typeof v === 'object' && !v.source) v.source = sourceArg;
    const section = tokens(p)[0].key;
    if (Array.isArray(j._examples) && j._examples.includes(section)) j._examples = j._examples.filter(x => x !== section); // answered: no longer sample data
    save(j); console.log(`${cmd === 'push' ? 'Appended to' : 'Set'} ${p}`);
  } else if (cmd === 'open') {
    const d = JSON.parse(fs.readFileSync(path.join(PFS_DIR, 'derived.json'), 'utf8'));
    for (const q of d.questions) console.log(`- [${q.id}] ${q.ask}${q.hint ? `  (${q.hint})` : ''}`);
  } else {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
  }
} catch (e) { console.error(e.message); process.exit(1); }
