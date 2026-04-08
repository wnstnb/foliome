/**
 * Wiki data access module — frontmatter parsing, path confinement, index generation.
 *
 * Serves data/wiki/ files via the dashboard API. No database — just markdown files.
 * Follows dashboard-queries.js pattern (CommonJS, exported functions, no side effects).
 */

const fs = require('fs');
const path = require('path');

const WIKI_DIR = path.resolve(__dirname, '..', 'data', 'wiki');

// Files excluded from the index (infrastructure, not user-facing pages)
const EXCLUDED_FILES = new Set(['index.md', 'log.md', 'schema.md']);

// Ordered type groups for the index view
const TYPE_ORDER = ['goal', 'preference', 'concern', 'context', 'pattern', 'article', 'reflection'];
const TYPE_LABELS = {
  goal: 'Goals',
  preference: 'Preferences',
  concern: 'Concerns',
  context: 'Context',
  pattern: 'Patterns',
  article: 'Articles',
  reflection: 'Reflections',
};

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
// Hand-rolled YAML frontmatter parser. The wiki schema is simple key-value
// pairs + tags array, so no need for gray-matter or yaml dependency.

function parseFrontmatter(content) {
  const fm = {};
  if (!content.startsWith('---')) return { frontmatter: fm, body: content };

  const endIdx = content.indexOf('\n---', 3);
  if (endIdx === -1) return { frontmatter: fm, body: content };

  const fmBlock = content.slice(4, endIdx).trim();
  const body = content.slice(endIdx + 4).trim();

  for (const line of fmBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    // Parse arrays: [tag1, tag2]
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
    }

    fm[key] = value;
  }

  return { frontmatter: fm, body };
}

// ─── Path Security ───────────────────────────────────────────────────────────

const SAFE_PATH_RE = /^[a-zA-Z0-9._-]+$/;

function isPathSafe(relativePath) {
  // Null byte injection — reject immediately
  if (relativePath.includes('\x00')) return false;

  // Each path component must match safe chars
  const parts = relativePath.split(/[/\\]/);
  for (const part of parts) {
    if (!part || !SAFE_PATH_RE.test(part)) return false;
  }
  return true;
}

function isConfined(resolvedPath) {
  const wikiRoot = path.resolve(WIKI_DIR);
  return resolvedPath.startsWith(wikiRoot + path.sep) || resolvedPath === wikiRoot;
}

function isSymlink(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isSymbolicLink();
  } catch {
    return false;
  }
}

// ─── Recursive File Scanner ──────────────────────────────────────────────────

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
      // Skip assets directory and hidden dirs
      if (entry.name === 'assets' || entry.name.startsWith('.')) continue;
      results.push(...scanMarkdownFiles(fullPath, baseDir));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      if (EXCLUDED_FILES.has(entry.name)) continue;
      const rel = path.relative(baseDir, fullPath).replace(/\\/g, '/');
      results.push({ fullPath, relativePath: rel });
    }
  }
  return results;
}

// ─── Exported Functions ──────────────────────────────────────────────────────

/**
 * Get wiki index — all pages grouped by type.
 * Returns { groups: [...], totalPages: N }
 */
function getWikiIndex() {
  const files = scanMarkdownFiles(WIKI_DIR, WIKI_DIR);
  const pagesByType = {};

  for (const { fullPath, relativePath } of files) {
    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      const { frontmatter, body } = parseFrontmatter(content);

      // Extract title from first heading or filename
      const headingMatch = body.match(/^#\s+(.+)$/m);
      const title = headingMatch
        ? headingMatch[1]
        : relativePath.split('/').pop().replace('.md', '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

      // Extract summary (first 200 chars of body, skip headings)
      const bodyText = body.replace(/^#+\s+.+$/gm, '').trim();
      const summary = bodyText.slice(0, 200).replace(/\n/g, ' ').trim();

      const type = frontmatter.type || 'context';
      const page = {
        path: relativePath.replace(/\.md$/, ''),
        title,
        type,
        created: frontmatter.created || '',
        updated: frontmatter.updated || frontmatter.created || '',
        status: frontmatter.status || 'active',
        tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
        summary,
        source_url: frontmatter.source_url || undefined,
        source_type: frontmatter.source_type || undefined,
      };

      if (!pagesByType[type]) pagesByType[type] = [];
      pagesByType[type].push(page);
    } catch {
      // Skip unreadable files
    }
  }

  // Sort each group by updated desc
  for (const type of Object.keys(pagesByType)) {
    pagesByType[type].sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  }

  // Build ordered groups
  const groups = [];
  let totalPages = 0;
  for (const type of TYPE_ORDER) {
    const pages = pagesByType[type];
    if (pages && pages.length > 0) {
      groups.push({ type, label: TYPE_LABELS[type] || type, pages });
      totalPages += pages.length;
    }
  }

  // Include any types not in TYPE_ORDER (future-proof)
  for (const type of Object.keys(pagesByType)) {
    if (!TYPE_ORDER.includes(type)) {
      groups.push({ type, label: type, pages: pagesByType[type] });
      totalPages += pagesByType[type].length;
    }
  }

  return { groups, totalPages };
}

/**
 * Get a single wiki page by relative path (without .md extension).
 * Returns { frontmatter, body, title } or null.
 */
function getWikiPage(relativePath) {
  if (!relativePath || !isPathSafe(relativePath)) return null;

  const filePath = path.resolve(WIKI_DIR, relativePath + '.md');
  if (!isConfined(filePath)) return null;
  if (isSymlink(filePath)) return null;

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const { frontmatter, body } = parseFrontmatter(content);

    const headingMatch = body.match(/^#\s+(.+)$/m);
    const title = headingMatch
      ? headingMatch[1]
      : relativePath.split('/').pop().replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    return { frontmatter, body, title };
  } catch {
    return null;
  }
}

/**
 * Get a wiki asset (image, PDF) by relative path.
 * Returns { filePath, mime, isPdf } or null.
 */
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

module.exports = { getWikiIndex, getWikiPage, getWikiAsset };
