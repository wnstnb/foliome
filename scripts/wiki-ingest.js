/**
 * wiki-ingest.js — Content ingestion for wiki articles (tweets, YouTube, URL validation)
 *
 * Dual-use: importable functions + CLI subcommands.
 *
 * CLI:
 *   node scripts/wiki-ingest.js validate <url>
 *   node scripts/wiki-ingest.js tweet <url>
 *   node scripts/wiki-ingest.js youtube <url> [--thumbnail <dest-path>]
 *
 * All subcommands output JSON to stdout. Errors produce JSON with ok: false.
 */

const { URL } = require('url');
const net = require('net');
const dns = require('dns');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

/** CIDR-style private IP check */
function isPrivateIP(ip) {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts[0] === 10) return true;                                    // 10.0.0.0/8
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12
    if (parts[0] === 192 && parts[1] === 168) return true;              // 192.168.0.0/16
    if (parts[0] === 127) return true;                                   // 127.0.0.0/8
    if (parts[0] === 169 && parts[1] === 254) return true;              // 169.254.0.0/16 (link-local)
    if (parts[0] === 0) return true;                                     // 0.0.0.0/8
  }
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    if (normalized === '::1') return true;
    if (normalized.startsWith('fe80:')) return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  }
  return false;
}

/**
 * Validate a URL for safety: HTTPS required, SSRF block (private IPs + DNS rebinding).
 * @param {string} url
 * @returns {Promise<{safe: boolean, hostname?: string, reason?: string}>}
 */
async function validateUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { safe: false, reason: 'Invalid URL' };
  }

  if (parsed.protocol !== 'https:') {
    return { safe: false, hostname: parsed.hostname, reason: 'HTTPS required' };
  }

  // Direct IP in hostname
  if (net.isIP(parsed.hostname)) {
    if (isPrivateIP(parsed.hostname)) {
      return { safe: false, hostname: parsed.hostname, reason: 'Private IP blocked (SSRF protection)' };
    }
    return { safe: true, hostname: parsed.hostname };
  }

  // DNS rebinding check — resolve hostname and verify it's not private
  try {
    const addresses = await dns.promises.resolve4(parsed.hostname);
    for (const addr of addresses) {
      if (isPrivateIP(addr)) {
        return { safe: false, hostname: parsed.hostname, reason: `DNS resolves to private IP ${addr} (SSRF protection)` };
      }
    }
  } catch {
    // DNS resolution failed — could be IPv6-only or transient. Allow it through;
    // the actual fetch will fail if the host is unreachable.
  }

  return { safe: true, hostname: parsed.hostname };
}

// ---------------------------------------------------------------------------
// Tweet fetching
// ---------------------------------------------------------------------------

/**
 * Parse a tweet URL into user and tweetId.
 * @param {string} url
 * @returns {{user: string, tweetId: string} | null}
 */
function parseTweetUrl(url) {
  try {
    const parsed = new URL(url);
    if (!['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com'].includes(parsed.hostname)) {
      return null;
    }
    const match = parsed.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
    if (!match) return null;
    return { user: match[1], tweetId: match[2] };
  } catch {
    return null;
  }
}

/**
 * Fetch tweet content. Tries FxTwitter API first, oEmbed fallback.
 * @param {string} url
 * @returns {Promise<{ok: boolean, content?: object, source?: string, error?: string}>}
 */
async function fetchTweet(url) {
  const parsed = parseTweetUrl(url);
  if (!parsed) {
    return { ok: false, error: 'Not a valid tweet URL' };
  }

  // Method 1: FxTwitter API
  try {
    const apiUrl = `https://api.fxtwitter.com/${parsed.user}/status/${parsed.tweetId}`;
    const resp = await fetch(apiUrl, {
      headers: { 'User-Agent': 'foliome-wiki-ingest/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.tweet) {
        const t = data.tweet;
        return {
          ok: true,
          source: 'fxtwitter',
          content: {
            text: t.text,
            author: t.author?.name || parsed.user,
            handle: t.author?.screen_name || parsed.user,
            date: t.created_at || null,
            timestamp: t.created_timestamp || null,
            media: (t.media?.all || []).map(m => ({ type: m.type, url: m.url })),
            likes: t.likes || 0,
            retweets: t.retweets || 0,
            replies: t.replies || 0,
            url,
          },
        };
      }
    }
  } catch {
    // Fall through to oEmbed
  }

  // Method 2: oEmbed fallback
  try {
    const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}`;
    const resp = await fetch(oembedUrl, {
      signal: AbortSignal.timeout(10000),
    });
    if (resp.ok) {
      const data = await resp.json();
      // Extract text from HTML blockquote
      let text = data.html || '';
      text = text.replace(/<[^>]+>/g, '').replace(/&mdash;.*$/, '').trim();
      // Unescape HTML entities
      text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      return {
        ok: true,
        source: 'oembed',
        content: {
          text,
          author: data.author_name || parsed.user,
          handle: parsed.user,
          date: null,
          media: [],
          url: data.url || url,
        },
      };
    }
  } catch {
    // Both methods failed
  }

  return { ok: false, error: 'Both FxTwitter API and oEmbed failed. Use WebFetch or browser tools as fallback.' };
}

// ---------------------------------------------------------------------------
// YouTube fetching
// ---------------------------------------------------------------------------

/**
 * Parse a YouTube URL into videoId.
 * @param {string} url
 * @returns {{videoId: string} | null}
 */
function parseYouTubeUrl(url) {
  try {
    const parsed = new URL(url);
    // youtube.com/watch?v=ID
    if (['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(parsed.hostname)) {
      const v = parsed.searchParams.get('v');
      if (v) return { videoId: v };
      // youtube.com/shorts/ID
      const shortsMatch = parsed.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]+)/);
      if (shortsMatch) return { videoId: shortsMatch[1] };
    }
    // youtu.be/ID
    if (parsed.hostname === 'youtu.be') {
      const id = parsed.pathname.slice(1).split('/')[0];
      if (id) return { videoId: id };
    }
    return null;
  } catch {
    return null;
  }
}

/** Check if yt-dlp is available on the system */
async function checkYtDlp() {
  return new Promise(resolve => {
    execFile('yt-dlp', ['--version'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve({ available: false });
      resolve({ available: true, version: stdout.trim() });
    });
  });
}

/** Run yt-dlp with args, return stdout */
function runYtDlp(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile('yt-dlp', args, { timeout: opts.timeout || 30000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

/** Fetch YouTube video metadata via yt-dlp --print */
async function fetchYouTubeMetadata(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const stdout = await runYtDlp([
    '--skip-download', '--no-exec', '--ignore-config',
    '--print', '%(title)s\n%(uploader)s\n%(duration)s\n%(upload_date)s',
    url,
  ]);
  const lines = stdout.trim().split('\n');
  return {
    title: lines[0] || 'Unknown',
    uploader: lines[1] || 'Unknown',
    duration: parseInt(lines[2], 10) || 0,
    uploadDate: lines[3] || null,
  };
}

/** Clean SRT subtitle content to plain text */
function cleanSrt(srt) {
  return srt
    .replace(/^\d+\s*$/gm, '')                    // sequence numbers
    .replace(/\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}/g, '') // timestamps
    .replace(/<[^>]+>/g, '')                       // formatting tags
    .replace(/\{[^}]+\}/g, '')                     // SSA/ASS formatting
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .filter((line, i, arr) => line !== arr[i - 1]) // collapse consecutive duplicates
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Fetch YouTube transcript via yt-dlp subtitle download.
 * Uses temp dir, cleaned up in finally.
 * @param {string} videoId
 * @returns {Promise<{ok: boolean, transcript?: string, lang?: string, auto?: boolean, error?: string}>}
 */
async function fetchYouTubeTranscript(videoId) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foliome-yt-'));
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const outTemplate = path.join(tmpDir, '%(id)s');

  try {
    // Try manual subtitles first
    for (const [flag, auto] of [['--write-sub', false], ['--write-auto-sub', true]]) {
      try {
        await runYtDlp([
          '--skip-download', '--no-exec', '--ignore-config',
          flag, '--sub-format', 'srt', '--sub-lang', 'en',
          '-o', outTemplate, url,
        ], { timeout: 30000 });

        // Look for the downloaded subtitle file
        const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.srt') || f.endsWith('.vtt'));
        if (files.length > 0) {
          const content = fs.readFileSync(path.join(tmpDir, files[0]), 'utf-8');
          const transcript = cleanSrt(content);
          if (transcript.length > 0) {
            return { ok: true, transcript, lang: 'en', auto };
          }
        }
      } catch {
        // Try next method
      }
    }

    return { ok: false, error: 'No English subtitles available (manual or auto-generated)' };
  } finally {
    // Clean up temp dir
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * Fetch YouTube thumbnail. Tries maxresdefault, falls back to hqdefault.
 * Re-encodes through Sharp if available (strips EXIF, destroys polyglots).
 * @param {string} videoId
 * @param {string} dest — destination file path
 * @returns {Promise<{ok: boolean, path?: string, reencoded?: boolean, error?: string}>}
 */
async function fetchYouTubeThumbnail(videoId, dest) {
  const urls = [
    `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
  ];

  let imageBuffer = null;
  for (const thumbUrl of urls) {
    try {
      const resp = await fetch(thumbUrl, { signal: AbortSignal.timeout(10000) });
      if (resp.ok) {
        const ct = resp.headers.get('content-type') || '';
        if (!ct.startsWith('image/')) continue;
        imageBuffer = Buffer.from(await resp.arrayBuffer());
        // YouTube returns a small placeholder for missing maxres — skip if too small
        if (imageBuffer.length < 5000 && thumbUrl.includes('maxresdefault')) {
          imageBuffer = null;
          continue;
        }
        break;
      }
    } catch {
      continue;
    }
  }

  if (!imageBuffer) {
    return { ok: false, error: 'Could not fetch thumbnail from YouTube' };
  }

  // Re-encode through Sharp if available (security: strips EXIF, destroys polyglots)
  let reencoded = false;
  try {
    const sharp = require('sharp');
    imageBuffer = await sharp(imageBuffer).png().toBuffer();
    reencoded = true;
  } catch {
    // Sharp not available — save raw JPEG (acceptable fallback)
  }

  const destPath = dest.endsWith('.png') || dest.endsWith('.jpg') ? dest : dest + (reencoded ? '.png' : '.jpg');
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, imageBuffer);

  return { ok: true, path: destPath, reencoded };
}

/**
 * Fetch YouTube content: metadata + transcript + optional thumbnail.
 * @param {string} url
 * @param {{thumbnail?: string}} opts
 * @returns {Promise<{ok: boolean, content?: object, error?: string}>}
 */
async function fetchYouTube(url, opts = {}) {
  const parsed = parseYouTubeUrl(url);
  if (!parsed) {
    return { ok: false, error: 'Not a valid YouTube URL' };
  }

  const ytdlp = await checkYtDlp();
  if (!ytdlp.available) {
    return { ok: false, error: 'yt-dlp is not installed. Install with: brew install yt-dlp (macOS) or pip install yt-dlp' };
  }

  const result = { ok: true, content: { videoId: parsed.videoId, url } };

  // Fetch metadata
  try {
    result.content.metadata = await fetchYouTubeMetadata(parsed.videoId);
  } catch (e) {
    result.content.metadata = { error: e.message };
  }

  // Fetch transcript
  try {
    const transcript = await fetchYouTubeTranscript(parsed.videoId);
    result.content.transcript = transcript;
  } catch (e) {
    result.content.transcript = { ok: false, error: e.message };
  }

  // Fetch thumbnail if requested
  if (opts.thumbnail) {
    try {
      result.content.thumbnail = await fetchYouTubeThumbnail(parsed.videoId, opts.thumbnail);
    } catch (e) {
      result.content.thumbnail = { ok: false, error: e.message };
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Content sanitization
// ---------------------------------------------------------------------------

/**
 * Wrap text in untrusted content boundary markers.
 * @param {string} text
 * @param {string} source — e.g. "tweet", "youtube", "article"
 * @returns {string}
 */
function wrapUntrusted(text, source) {
  return `--- BEGIN UNTRUSTED EXTERNAL CONTENT (source: ${source}) ---\n${text}\n--- END UNTRUSTED EXTERNAL CONTENT ---`;
}

/**
 * Sanitize a string for use as a filename.
 * Strips to [a-zA-Z0-9._-], caps length at 100.
 * @param {string} name
 * @returns {string}
 */
function sanitizeFilename(name) {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100) || 'untitled';
}

/**
 * Re-encode an image through Sharp to PNG (strips EXIF, destroys polyglots).
 * Graceful no-op if Sharp is not installed.
 * @param {string} input — source image path
 * @param {string} output — destination path
 * @returns {Promise<{ok: boolean, reencoded?: boolean, error?: string}>}
 */
async function reencodeImage(input, output) {
  try {
    const sharp = require('sharp');
    await sharp(input).png().toFile(output);
    return { ok: true, reencoded: true };
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
      return { ok: false, reencoded: false, error: 'Sharp not installed — skipping re-encode' };
    }
    return { ok: false, reencoded: false, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
  validateUrl,
  parseTweetUrl,
  fetchTweet,
  parseYouTubeUrl,
  checkYtDlp,
  fetchYouTube,
  fetchYouTubeMetadata,
  fetchYouTubeTranscript,
  fetchYouTubeThumbnail,
  wrapUntrusted,
  sanitizeFilename,
  reencodeImage,
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  function output(obj) {
    console.log(JSON.stringify(obj, null, 2));
  }

  async function main() {
    switch (command) {
      case 'validate': {
        const url = args[1];
        if (!url) {
          output({ ok: false, error: 'Usage: wiki-ingest.js validate <url>' });
          process.exit(1);
        }
        const result = await validateUrl(url);
        output(result);
        break;
      }

      case 'tweet': {
        const url = args[1];
        if (!url) {
          output({ ok: false, error: 'Usage: wiki-ingest.js tweet <url>' });
          process.exit(1);
        }
        const validation = await validateUrl(url);
        if (!validation.safe) {
          output({ ok: false, error: `URL validation failed: ${validation.reason}` });
          process.exit(1);
        }
        const result = await fetchTweet(url);
        output(result);
        break;
      }

      case 'youtube': {
        const url = args[1];
        if (!url) {
          output({ ok: false, error: 'Usage: wiki-ingest.js youtube <url> [--thumbnail <dest-path>]' });
          process.exit(1);
        }
        const validation = await validateUrl(url);
        if (!validation.safe) {
          output({ ok: false, error: `URL validation failed: ${validation.reason}` });
          process.exit(1);
        }
        const opts = {};
        const thumbIdx = args.indexOf('--thumbnail');
        if (thumbIdx !== -1 && args[thumbIdx + 1]) {
          opts.thumbnail = args[thumbIdx + 1];
        }
        const result = await fetchYouTube(url, opts);
        output(result);
        break;
      }

      default:
        output({
          ok: false,
          error: 'Unknown command. Usage:\n  wiki-ingest.js validate <url>\n  wiki-ingest.js tweet <url>\n  wiki-ingest.js youtube <url> [--thumbnail <dest-path>]',
        });
        process.exit(1);
    }
  }

  main().catch(e => {
    output({ ok: false, error: e.message });
    process.exit(1);
  });
}
