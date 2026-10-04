/**
 * Wiki data access: one model of data/wiki/ shared by the dashboard API and scripts/wiki.js.
 *
 * Pages are organised by kind of claim (docs/wiki.md): goal, decision, finding, context,
 * reflection, source. Backlinks, open items and wiki health are computed when the wiki is
 * read, never stored. No database: just markdown files. CommonJS, no side effects.
 */

const fs = require('fs');
const path = require('path');

const WIKI_DIR = process.env.WIKI_DIR ? path.resolve(process.env.WIKI_DIR) : path.resolve(__dirname, '..', 'data', 'wiki');

// Infrastructure files, not pages
const EXCLUDED_FILES = new Set(['index.md', 'log.md', 'schema.md', 'README.md', 'dev-privileges.md']);

const KINDS = ['goal', 'decision', 'finding', 'context', 'reflection', 'source'];
const KIND_LABELS = { goal: 'Goals', decision: 'Decisions', finding: 'Findings', context: 'Context', reflection: 'Reflections', source: 'Sources' };
const KIND_FOLDERS = { goal: 'goals', decision: 'decisions', finding: 'findings', context: 'context', reflection: 'reflections', source: 'sources' };
const STATUSES = { finding: ['standing', 'refuted', 'superseded'], default: ['active', 'parked', 'closed'] };
const CURRENT = new Set(['standing', 'active']); // statuses that count as "what we believe now"
const TOPICS = ['spending', 'cash-flow', 'investing', 'planning', 'data-quality', 'sync', 'household', 'tax'];

// Asset MIME types (extension allowlist — no SVG, no HTML, no executable)
const ASSET_MIMES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
};

// ─── Frontmatter Parser ──────────────────────────────────────────────────────
// Hand-rolled: the schema is flat key-value pairs plus [a, b] lists, so no yaml dependency.

function unquote(v) {
  return (v.length > 1 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) ? v.slice(1, -1) : v;
}

function parseFrontmatter(content) {
  const fm = {};
  if (!content.startsWith('---')) return { frontmatter: fm, body: content };

  const endIdx = content.indexOf('\n---', 3);
  if (endIdx === -1) return { frontmatter: fm, body: content };

  const fmBlock = content.slice(4, endIdx).trim();
  const body = content.slice(endIdx + 4).replace(/^-*\n/, '').trim();

  for (const line of fmBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1 || /^\s/.test(line)) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).replace(/\s+#.*$/, '').trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map(s => unquote(s.trim())).filter(Boolean);
    } else {
      value = unquote(value);
    }
    fm[key] = value;
  }

  return { frontmatter: fm, body };
}

// ─── Path Security ───────────────────────────────────────────────────────────

const SAFE_PATH_RE = /^[a-zA-Z0-9._-]+$/;

function isPathSafe(relativePath) {
  if (relativePath.includes('\x00')) return false;
  const parts = relativePath.split(/[/\\]/);
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || !SAFE_PATH_RE.test(part)) return false;
  }
  return true;
}

function isConfined(resolvedPath) {
  const wikiRoot = path.resolve(WIKI_DIR);
  return resolvedPath.startsWith(wikiRoot + path.sep) || resolvedPath === wikiRoot;
}

function isSymlink(filePath) {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

// ─── Scanner ─────────────────────────────────────────────────────────────────

function scanMarkdownFiles(dir, baseDir) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'assets' || entry.name.startsWith('.')) continue;
      results.push(...scanMarkdownFiles(fullPath, baseDir));
    } else if (entry.isFile() && entry.name.endsWith('.md') && !isSymlink(fullPath)) {
      if (EXCLUDED_FILES.has(entry.name)) continue;
      results.push({ fullPath, relativePath: path.relative(baseDir, fullPath).replace(/\\/g, '/') });
    }
  }
  return results;
}

// ─── Page model ──────────────────────────────────────────────────────────────

const LINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;

function plain(md) {
  return md.replace(LINK_RE, (m, slug, label) => label || slug.replace(/-/g, ' '))
    .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1').replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();
}

function section(body, name) {
  const m = body.match(new RegExp(`^##\\s+${name}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'mi'));
  return m ? m[1] : '';
}

function parsePage(fullPath, relativePath) {
  const content = fs.readFileSync(fullPath, 'utf8');
  const { frontmatter: fm, body } = parseFrontmatter(content);
  const slug = path.basename(relativePath, '.md');
  const heading = body.match(/^#\s+(.+)$/m);
  const title = fm.title || (heading ? plain(heading[1]) : slug.replace(/-/g, ' ').replace(/^\w/, c => c.toUpperCase()));
  // Lead: the first real paragraph after the H1 (not a heading, list, table, quote or bold status line)
  const afterTitle = heading ? body.slice(body.indexOf(heading[0]) + heading[0].length) : body;
  const lead = (afterTitle.split(/\n\s*\n/).map(p => p.trim())
    .find(p => p && !/^(#|[-*+] |\d+\. |\||>|<!--|\*\*Status|\*\*Found|\*\*Type)/.test(p)) || '');
  const links = [];
  for (const m of body.matchAll(LINK_RE)) { const s = m[1].trim().split('/').pop(); if (s !== slug && !links.includes(s)) links.push(s); }
  const open = [];
  for (const line of section(body, 'Open').split('\n')) {
    const m = line.match(/^\s*[-*]\s+\[ \]\s+(.+)$/);
    if (m && !/^~~.*~~$/.test(m[1].trim())) open.push(plain(m[1]));
  }
  const type = KINDS.includes(fm.type) ? fm.type : (fm.type || 'context');
  return {
    slug,
    path: relativePath.replace(/\.md$/, ''),
    type,
    status: fm.status || '',
    title,
    short: fm.short || '',
    topic: fm.topic || '',
    created: fm.created || '',
    updated: fm.updated || fm.created || '',
    tags: Array.isArray(fm.tags) ? fm.tags : (fm.tags ? [fm.tags] : []),
    sources: Array.isArray(fm.sources) ? fm.sources : (fm.sources ? [fm.sources] : []),
    headline: fm.headline || '',
    superseded_by: fm.superseded_by && fm.superseded_by !== 'null' ? fm.superseded_by : '',
    source_url: fm.source_url || undefined,
    source_type: fm.source_type || undefined,
    lead: plain(lead).slice(0, 400),
    links,
    open,
    _fm: fm,
    _body: body,
  };
}

/** Load every page, with backlinks and link counts computed. */
function loadWiki() {
  const pages = [];
  for (const { fullPath, relativePath } of scanMarkdownFiles(WIKI_DIR, WIKI_DIR)) {
    try { pages.push(parsePage(fullPath, relativePath)); } catch { /* skip unreadable */ }
  }
  const bySlug = new Map(pages.map(p => [p.slug, p]));
  for (const p of pages) p.backlinks = [];
  for (const p of pages) for (const s of p.links) { const t = bySlug.get(s); if (t && !t.backlinks.includes(p.slug)) t.backlinks.push(p.slug); }
  return { pages, bySlug };
}

function publicMeta(p) {
  const { _fm, _body, links, backlinks, ...meta } = p;
  return { ...meta, summary: p.lead, linkCount: backlinks.length,
    progress: _fm.progress != null && _fm.progress !== '' ? Math.max(0, Math.min(1, parseFloat(_fm.progress) || 0)) : null,
    on_track: _fm.on_track ? _fm.on_track !== 'no' : null,
    fromStatement: !!_fm.pfs_goal };
}

function readLog(limit = 8) {
  try {
    const lines = fs.readFileSync(path.join(WIKI_DIR, 'log.md'), 'utf8').split('\n');
    const out = [];
    let date = '';
    for (const line of lines) {
      const h = line.match(/^##\s+\[?(\d{4}-\d{2}-\d{2})\]?\s*(.*)$/);
      if (h) { date = h[1]; if (h[2].trim()) out.push({ date, text: plain(h[2]) }); continue; }
      const b = line.match(/^\s*[-*]\s+(.+)$/);
      if (b && date) out.push({ date, text: plain(b[1]) });
    }
    // Newest first, whichever order the file is in
    // Drop bare tags ("morning-sync") and leading file paths; newest first, whichever order the file is in
    return out.map(e => ({ ...e, text: e.text.replace(/^\[?\d{4}-\d{2}-\d{2}\]?\s*/, '').replace(/^(new page\s+)?[\w./-]+\.md:?\s*/i, '') }))
      .filter(e => /\s/.test(e.text) && e.text.length > 12)
      .sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
  } catch {
    return [];
  }
}

/** Health problems: broken links, missing header fields, statuses that don't fit the kind, one-way links. */
function wikiHealth(wiki = loadWiki()) {
  const { pages, bySlug } = wiki;
  const broken = [], missing = [], badStatus = [], oneWay = [];
  for (const p of pages) {
    for (const s of p.links) if (!bySlug.has(s)) broken.push({ page: p.path, link: s });
    const need = ['type', 'status', 'title', 'updated'].filter(k => !p._fm[k]);
    if (need.length) missing.push({ page: p.path, fields: need });
    if (!KINDS.includes(p.type)) badStatus.push({ page: p.path, problem: `unknown kind "${p.type}"` });
    else if (p.status && !(STATUSES[p.type] || STATUSES.default).includes(p.status)) badStatus.push({ page: p.path, problem: `status "${p.status}" doesn't fit a ${p.type}` });
    if (p.superseded_by && !bySlug.has(p.superseded_by)) broken.push({ page: p.path, link: p.superseded_by });
    for (const s of p.links) { const t = bySlug.get(s); if (t && !t.links.includes(p.slug) && p.type !== 'reflection' && t.type !== 'reflection') oneWay.push({ from: p.slug, to: s }); }
  }
  return { broken, missing, badStatus, oneWay };
}

// ─── Exported API ────────────────────────────────────────────────────────────

/**
 * Wiki index for the dashboard: pages grouped by kind (most-linked first), the home view
 * (goals, rules, open items, recent changes) and wiki health counts.
 */
function getWikiIndex() {
  const wiki = loadWiki();
  const { pages } = wiki;
  const groups = [];
  for (const type of [...KINDS, ...new Set(pages.map(p => p.type).filter(t => !KINDS.includes(t)))]) {
    const list = pages.filter(p => p.type === type)
      .sort((a, b) => (CURRENT.has(b.status) - CURRENT.has(a.status)) || (b.backlinks.length - a.backlinks.length) || (b.updated || '').localeCompare(a.updated || ''));
    if (type === 'reflection') list.sort((a, b) => b.slug.localeCompare(a.slug));
    if (list.length) groups.push({ type, label: KIND_LABELS[type] || type, pages: list.map(publicMeta) });
  }
  const open = [];
  for (const p of pages) if (CURRENT.has(p.status) || !p.status) for (const text of p.open) open.push({ text, page: p.path, pageTitle: p.short || p.title });
  const health = wikiHealth(wiki);
  return {
    groups,
    totalPages: pages.length,
    home: {
      goals: pages.filter(p => p.type === 'goal' && p.status === 'active').map(publicMeta),
      rules: pages.filter(p => p.type === 'decision' && p.status === 'active')
        .sort((a, b) => (b.backlinks.length - a.backlinks.length) || (b.updated || '').localeCompare(a.updated || '')).map(publicMeta),
      open,
      recent: readLog(8),
    },
    health: { brokenLinks: health.broken.length, missingFields: health.missing.length + health.badStatus.length, oneWayLinks: health.oneWay.length },
  };
}

/**
 * One page by relative path (without .md): header, body, title, and a Related list that
 * merges outgoing links and backlinks, flagging one-way links.
 */
function getWikiPage(relativePath) {
  if (!relativePath || !isPathSafe(relativePath)) return null;
  const filePath = path.resolve(WIKI_DIR, relativePath + '.md');
  if (!isConfined(filePath) || isSymlink(filePath) || !fs.existsSync(filePath)) return null;
  try {
    const wiki = loadWiki();
    const p = wiki.pages.find(x => x.path === relativePath) || parsePage(filePath, relativePath + '.md');
    const related = [];
    for (const s of new Set([...(p.links || []), ...(p.backlinks || [])])) {
      const t = wiki.bySlug.get(s);
      if (!t) continue;
      const out = p.links.includes(s), inn = (p.backlinks || []).includes(s);
      related.push({ path: t.path, title: t.short || t.title, type: t.type, status: t.status, direction: out && inn ? 'both' : out ? 'out' : 'in' });
    }
    related.sort((a, b) => ({ both: 0, out: 1, in: 2 }[a.direction] - { both: 0, out: 1, in: 2 }[b.direction]));
    const replacement = p.superseded_by ? wiki.bySlug.get(p.superseded_by) : null;
    return {
      frontmatter: p._fm,
      body: p._body,
      title: p.title,
      meta: publicMeta(p),
      related,
      supersededBy: replacement ? { path: replacement.path, title: replacement.title } : null,
    };
  } catch {
    return null;
  }
}

/** A wiki asset (image, PDF) by relative path: { filePath, mime, isPdf } or null. */
function getWikiAsset(relativePath) {
  if (!relativePath || !isPathSafe(relativePath)) return null;
  const filePath = path.resolve(WIKI_DIR, relativePath);
  if (!isConfined(filePath)) return null;
  if (isSymlink(filePath)) return null;
  const ext = path.extname(filePath).toLowerCase();
  const mime = ASSET_MIMES[ext];
  if (!mime) return null;
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return { filePath, mime, isPdf: ext === '.pdf' };
  } catch {
    return null;
  }
}

module.exports = {
  getWikiIndex, getWikiPage, getWikiAsset,
  // shared with scripts/wiki.js
  loadWiki, wikiHealth, parseFrontmatter, WIKI_DIR, KINDS, KIND_LABELS, KIND_FOLDERS, STATUSES, TOPICS,
};
