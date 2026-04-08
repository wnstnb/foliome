#!/usr/bin/env node
/**
 * Dashboard Server — serves the financial dashboard as a Telegram Mini App.
 *
 * Validates Telegram initData (HMAC-SHA256 signed with bot token) before serving.
 * Only users matching TELEGRAM_CHAT_ID can access the dashboard.
 *
 * Usage:
 *   node scripts/dashboard-server.js                # start on port 3847
 *   node scripts/dashboard-server.js --port 8080    # custom port
 *
 * The server regenerates the dashboard HTML from SQLite on each request
 * (< 100ms) so it's always fresh.
 *
 * For Telegram Mini App integration:
 *   1. Start this server
 *   2. Expose via cloudflared tunnel
 *   3. Bot sends InlineKeyboardButton with web_app: { url: tunnelUrl }
 */

require('@dotenvx/dotenvx').config({ path: require('path').join(__dirname, '..', '.env') });
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getOverview, getTransactions, getSpending, getHoldings, getSubscriptions, getHealth, getBudgets } = require('./dashboard-queries.js');
const { getWikiIndex, getWikiPage, getWikiAsset } = require('./wiki-queries.js');

// ─── Token Resolution ───────────────────────────────────────────────────────────
// Telegram Mini App initData is HMAC-signed by whichever bot sent the web_app
// button. The dashboard server must validate against that SAME token.
//
// In Foliome's architecture there may be two bot identities:
//   - The Claude Code Telegram plugin bot (sends messages + web_app buttons)
//   - The foliome notification bot (TELEGRAM_BOT_TOKEN in .env)
// These may differ. If they do and we validate against the wrong one, every
// request silently fails with 403. Auto-detection prevents this.
//
// Resolution order:
//   1. DASHBOARD_BOT_TOKEN env var  — explicit override, always wins
//   2. Plugin bot token             — auto-detected from ~/.claude/channels/telegram/.env
//   3. TELEGRAM_BOT_TOKEN           — foliome .env fallback

function resolveToken() {
  // Tier 1: Explicit override (set when plugin bot differs from .env bot)
  if (process.env.DASHBOARD_BOT_TOKEN) {
    console.log('[dashboard] Token source: DASHBOARD_BOT_TOKEN env var');
    return process.env.DASHBOARD_BOT_TOKEN;
  }

  // Tier 2: Claude Code Telegram plugin (most common Foliome deployment)
  const pluginEnv = path.join(os.homedir(), '.claude', 'channels', 'telegram', '.env');
  try {
    const content = fs.readFileSync(pluginEnv, 'utf8');
    const match = content.match(/^TELEGRAM_BOT_TOKEN=(.+)$/m);
    if (match) {
      const pluginToken = match[1].trim();
      if (pluginToken !== process.env.TELEGRAM_BOT_TOKEN) {
        console.log('[dashboard] Token source: Telegram plugin bot (auto-detected, differs from .env)');
      } else {
        console.log('[dashboard] Token source: Telegram plugin bot (matches .env)');
      }
      return pluginToken;
    }
  } catch {}

  // Tier 3: Foliome .env (user runs their own bot, no plugin)
  if (process.env.TELEGRAM_BOT_TOKEN) {
    console.log('[dashboard] Token source: TELEGRAM_BOT_TOKEN from .env');
    return process.env.TELEGRAM_BOT_TOKEN;
  }

  return null;
}

const BOT_TOKEN = resolveToken();
const ALLOWED_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PORT = process.argv.includes('--port')
  ? parseInt(process.argv[process.argv.indexOf('--port') + 1])
  : 3847;

if (!BOT_TOKEN) {
  console.error('[dashboard] No bot token found. Set DASHBOARD_BOT_TOKEN, install the Telegram plugin, or set TELEGRAM_BOT_TOKEN in .env');
  process.exit(1);
}

// ─── Telegram initData Validation ──────────────────────────────────────────────
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app

function validateInitData(initData) {
  if (!initData) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;

  // Remove hash from params and sort alphabetically
  params.delete('hash');
  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  // HMAC-SHA256 with secret key derived from bot token
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  // Timing-safe comparison to prevent hash leakage via response timing
  if (computedHash.length !== hash.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(computedHash), Buffer.from(hash))) return null;

  // Reject stale initData (replay protection — 1 hour window)
  const authDate = parseInt(params.get('auth_date') || '0');
  if (Date.now() / 1000 - authDate > 3600) return null;

  // Parse user data
  try {
    const user = JSON.parse(params.get('user') || '{}');
    return {
      userId: user.id,
      firstName: user.first_name,
      chatId: params.get('chat_instance'),
      authDate,
    };
  } catch {
    return null;
  }
}

// ─── Dashboard HTML Generation ─────────────────────────────────────────────────

const { queryData, generateHTML } = require('./dashboard.js');

function generateDashboard() {
  try {
    const data = queryData();
    return generateHTML(data, { telegram: true });
  } catch (e) {
    console.error('[dashboard] Dashboard generation error:', e.message);
    return `<html><body><h1>Error</h1><p>Dashboard generation failed</p></body></html>`;
  }
}

// ─── HTTP Server ───────────────────────────────────────────────────────────────
// Three-step auth flow (token redirect):
//   1. GET / → serves a loader page that reads Telegram.WebApp.initData
//      and POSTs it to /api/auth for validation
//   2. POST /api/auth → validates initData, returns a short-lived token
//   3. Loader redirects to /dashboard?t=<token> → server validates token,
//      serves dashboard HTML as a normal page load (scripts execute reliably)
// Direct browser access (no Telegram) sees a blank "Access denied" page.
//
// Why not document.write()? Telegram's WebView doesn't reliably execute
// <script> tags injected via document.write(). The redirect approach serves
// the dashboard as a real page load, so Chart.js and tab switching JS work.

// Short-lived auth tokens (token → { userId, firstName, expires })
const authTokens = new Map();

function createAuthToken(user) {
  const token = crypto.randomBytes(32).toString('hex');
  authTokens.set(token, { ...user, expires: Date.now() + 60000 }); // 60s TTL
  return token;
}

function consumeAuthToken(token) {
  const entry = authTokens.get(token);
  if (!entry) return null;
  authTokens.delete(token); // one-time use
  if (Date.now() > entry.expires) return null;
  return entry;
}

// Cleanup expired tokens periodically
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of authTokens) {
    if (now > entry.expires) authTokens.delete(token);
  }
  for (const [token, entry] of sessionTokens) {
    if (now > entry.expires) sessionTokens.delete(token);
  }
}, 30000);

// ─── Session Tokens (SPA) ──────────────────────────────────────────────────────
// Long-lived session tokens for SPA API calls. 30min TTL with sliding window.

const sessionTokens = new Map();
const SESSION_TTL = 30 * 60 * 1000; // 30 minutes

const SESSION_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hour absolute max

function createSessionToken(user) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessionTokens.set(token, { ...user, expires: now + SESSION_TTL, createdAt: now });
  return token;
}

function validateSessionToken(token) {
  if (!token) return null;
  const entry = sessionTokens.get(token);
  if (!entry) return null;
  const now = Date.now();
  if (now > entry.expires || now - entry.createdAt > SESSION_MAX_AGE) {
    sessionTokens.delete(token);
    return null;
  }
  // Sliding window refresh
  entry.expires = now + SESSION_TTL;
  return entry;
}

// ─── Auth Helper ────────────────────────────────────────────────────────────────

function requireAuth(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  return validateSessionToken(token);
}

// ─── Static File Server ─────────────────────────────────────────────────────────

const DIST_DIR = path.join(__dirname, '..', 'dashboard', 'dist');
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function hasDist() {
  try { return fs.existsSync(path.join(DIST_DIR, 'index.html')); } catch { return false; }
}

function serveStatic(pathname, res) {
  // Prevent directory traversal
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(DIST_DIR, safePath);

  try {
    const stat = fs.statSync(filePath);
    if (stat.isFile()) {
      const ext = path.extname(filePath);
      const mime = MIME_TYPES[ext] || 'application/octet-stream';
      const headers = { 'Content-Type': mime };
      // Prevent browser caching of index.html so rebuilt dashboards appear immediately
      if (ext === '.html') {
        headers['Cache-Control'] = 'no-cache';
        headers['Content-Security-Policy'] = CSP_HEADER;
      }
      res.writeHead(200, headers);
      fs.createReadStream(filePath).pipe(res);
      return true;
    }
  } catch {}

  // SPA fallback: if it's not a file with an extension, serve index.html
  if (!path.extname(pathname)) {
    try {
      const indexPath = path.join(DIST_DIR, 'index.html');
      const html = fs.readFileSync(indexPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP_HEADER });
      res.end(html);
      return true;
    } catch {}
  }

  return false;
}

const LOADER_HTML = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
  body { margin: 0; background: #0F1B2D; color: #94A3B8; font-family: -apple-system, sans-serif;
         display: flex; align-items: center; justify-content: center; height: 100vh; }
</style>
</head><body>
<div id="msg">Loading...</div>
<script>
  const tg = window.Telegram?.WebApp;
  if (!tg || !tg.initData) {
    document.getElementById('msg').textContent = 'Access denied';
  } else {
    tg.ready();
    tg.expand();
    fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'initData=' + encodeURIComponent(tg.initData)
    })
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(data => { window.location.replace('/dashboard?t=' + data.token); })
    .catch(() => { document.getElementById('msg').textContent = 'Access denied'; });
  }
</script>
</body></html>`;

// ─── Content Security Policy ─────────────────────────────────────────────────

const CSP_HEADER = [
  "default-src 'self'",
  "script-src 'self' https://telegram.org",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https://cdn.simpleicons.org",
  "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
  "connect-src 'self'",
  "object-src 'none'",
].join('; ');

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Health check (no auth needed — returns no data)
  if (parsed.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  // Step 1: Serve the loader page (reads initData from Telegram, POSTs it back)
  // If SPA dist exists, the loader is served from there (static handler below).
  // Otherwise, serve the inline LOADER_HTML for legacy mode.
  if (parsed.pathname === '/' && !parsed.searchParams.get('t') && !hasDist()) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(LOADER_HTML);
    return;
  }

  // Step 2: Validate initData and issue a short-lived token
  if (parsed.pathname === '/api/auth' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const initData = params.get('initData');

      if (!initData) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No authentication data' }));
        return;
      }

      const user = validateInitData(initData);
      if (!user) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid authentication' }));
        return;
      }

      if (ALLOWED_CHAT_ID && String(user.userId) !== String(ALLOWED_CHAT_ID)) {
        console.log(`[dashboard] Rejected user ${user.userId} (${user.firstName}) — not in allowlist`);
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      const token = createAuthToken(user);
      const session = createSessionToken(user);
      console.log(`[dashboard] Issued token for ${user.firstName} (${user.userId})`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token, sessionToken: session }));
    });
    return;
  }

  // Step 3: Validate token and serve dashboard as a normal page load (legacy)
  if (parsed.pathname === '/dashboard' && parsed.searchParams.get('t')) {
    const user = consumeAuthToken(parsed.searchParams.get('t'));
    if (!user) {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body style="background:#0F1B2D;color:#94A3B8;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif">Session expired — reopen from Telegram</body></html>');
      return;
    }

    console.log(`[dashboard] Authorized: ${user.firstName} (${user.userId})`);
    const html = generateDashboard();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // ─── API Routes (protected by session token) ───────────────────────────────
  if (parsed.pathname.startsWith('/api/') && req.method === 'GET') {
    const user = requireAuth(req);
    if (!user) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const sendJson = (data) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Security-Policy': CSP_HEADER });
      res.end(JSON.stringify(data));
    };

    try {
      if (parsed.pathname === '/api/overview') {
        sendJson(getOverview());
        return;
      }
      if (parsed.pathname === '/api/transactions') {
        const sp = parsed.searchParams;
        const filters = {
          from: sp.get('from') || undefined,
          to: sp.get('to') || undefined,
          accounts: sp.get('accounts') ? sp.get('accounts').split(',') : undefined,
          categories: sp.get('categories') ? sp.get('categories').split(',') : undefined,
          q: sp.get('q') || undefined,
          limit: sp.get('limit') || undefined,
        };
        sendJson(getTransactions(undefined, filters));
        return;
      }
      if (parsed.pathname === '/api/spending') {
        const sp = parsed.searchParams;
        const filters = {
          from: sp.get('from') || undefined,
          to: sp.get('to') || undefined,
          accounts: sp.get('accounts') ? sp.get('accounts').split(',') : undefined,
        };
        sendJson(getSpending(undefined, filters));
        return;
      }
      if (parsed.pathname === '/api/holdings') {
        sendJson(getHoldings());
        return;
      }
      if (parsed.pathname === '/api/subscriptions') {
        sendJson(getSubscriptions());
        return;
      }
      if (parsed.pathname === '/api/health') {
        sendJson(getHealth());
        return;
      }
      if (parsed.pathname === '/api/budgets') {
        sendJson(getBudgets());
        return;
      }
      if (parsed.pathname === '/api/brief') {
        const briefPath = path.join(__dirname, '..', 'data', 'brief', 'latest.json');
        try {
          if (fs.existsSync(briefPath)) {
            const brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
            sendJson({ exists: true, ...brief });
          } else {
            sendJson({ exists: false });
          }
        } catch (e) {
          console.error('[dashboard] Brief read error:', e.message);
          sendJson({ exists: false });
        }
        return;
      }
      // ─── Wiki API ──────────────────────────────────────────────────────
      if (parsed.pathname === '/api/wiki') {
        sendJson(getWikiIndex());
        return;
      }
      if (parsed.pathname === '/api/wiki/page') {
        const wikiPath = parsed.searchParams.get('path');
        const page = getWikiPage(wikiPath);
        if (!page) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }
        sendJson(page);
        return;
      }
      if (parsed.pathname === '/api/wiki/asset') {
        const assetPath = parsed.searchParams.get('path');
        const asset = getWikiAsset(assetPath);
        if (!asset) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }
        const headers = {
          'Content-Type': asset.mime,
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': CSP_HEADER,
        };
        if (asset.isPdf) headers['Content-Disposition'] = 'attachment';
        res.writeHead(200, headers);
        fs.createReadStream(asset.filePath).pipe(res);
        return;
      }
    } catch (e) {
      console.error(`[dashboard] API error ${parsed.pathname}:`, e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  // ─── Static File Serving (SPA) ─────────────────────────────────────────────
  if (hasDist()) {
    const pathname = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
    if (serveStatic(pathname, res)) return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`[dashboard] Server running on http://localhost:${PORT}`);
  console.log(`[dashboard] Allowed Telegram user: ${ALLOWED_CHAT_ID}`);
  console.log(`[dashboard] Expose with: cloudflared tunnel --url http://localhost:${PORT}`);
});
