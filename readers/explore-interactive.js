#!/usr/bin/env node
/**
 * Interactive Visual Explorer — step-by-step bank exploration with annotated screenshots.
 *
 * Runs as a background process. Opens a Playwright browser and accepts commands
 * via file protocol. Each step produces an annotated screenshot with numbered
 * interactive elements, enabling the agent to navigate visually.
 *
 * Usage:
 *   node readers/explore-interactive.js <bank> <url> [usernameEnv] [passwordEnv]
 *
 * Send commands via:
 *   node readers/explore-cmd.js <bank> <action> [args...]
 *
 * The agent reads screenshots from data/explore/<bank>-step-<N>.png
 * and state from data/explore/<bank>-state.json.
 */

require('@dotenvx/dotenvx').config({ path: require('path').join(__dirname, '..', '.env') });
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { getCredentials } = require('../scripts/credentials');

const bank = process.argv[2];
const url = process.argv[3];
const usernameEnv = process.argv[4];
const passwordEnv = process.argv[5];

if (!bank || !url) {
  console.error('Usage: node readers/explore-interactive.js <bank> <url> [usernameEnv] [passwordEnv]');
  process.exit(1);
}

const PROFILE_DIR = path.join(__dirname, '..', 'data', 'chrome-profile', bank);
const EXPLORE_DIR = path.join(__dirname, '..', 'data', 'explore');
if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });
if (!fs.existsSync(EXPLORE_DIR)) fs.mkdirSync(EXPLORE_DIR, { recursive: true });

const stateFile = path.join(EXPLORE_DIR, `${bank}-state.json`);
const commandFile = path.join(EXPLORE_DIR, `${bank}-command.json`);
const historyFile = path.join(EXPLORE_DIR, `${bank}-history.json`);

let currentFrameIndex = null; // null = main page

// Use shared annotation module
const { annotateElements, removeLabels, detectIframes } = require('./annotate');
const { extractSanitizedText } = require('./sanitize-text');

function writeState(state) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

// ─── Target Resolution ───────────────────────────────────────────────────────

function getTarget(page) {
  if (currentFrameIndex !== null) {
    const frames = page.frames().filter(f => f !== page.mainFrame());
    if (frames[currentFrameIndex]) return frames[currentFrameIndex];
    console.log(`[explore] Frame ${currentFrameIndex} not found, falling back to main`);
    currentFrameIndex = null;
  }
  return page;
}

// ─── State Capture ───────────────────────────────────────────────────────────

async function captureState(page, step) {
  const target = getTarget(page);

  // Annotate interactive elements
  let elements = [];
  try {
    elements = await annotateElements(page, target);
  } catch (e) {
    console.log(`[explore] Annotation failed: ${e.message.substring(0, 60)}`);
  }

  // Take screenshot with annotations visible
  const ssPath = path.join(EXPLORE_DIR, `${bank}-step-${step}.png`);
  await page.screenshot({ path: ssPath });

  // Remove labels after screenshot
  await removeLabels(target);

  // Detect iframes
  const iframes = await detectIframes(page);

  // Get sanitized page text (Layer 1 + Layer 2 boundary markers)
  let pageText = '';
  try { pageText = await extractSanitizedText(target); } catch {}

  // Split into interactive elements vs form inputs
  const inputTags = new Set(['input', 'select', 'textarea']);
  const inputs = elements.filter(el => inputTags.has(el.tag));
  const interactive = elements.filter(el => !inputTags.has(el.tag));

  const state = {
    step,
    url: page.url(),
    title: await page.title().catch(() => ''),
    screenshot: ssPath,
    textLength: pageText.length,
    textPreview: pageText.substring(0, 500).replace(/\n{3,}/g, '\n\n'),
    elements: interactive,
    inputs,
    iframes,
    currentFrame: currentFrameIndex,
    ready: true,
  };

  writeState(state);
  console.log(`[explore] Step ${step}: ${state.url} (${elements.length} elements, ${iframes.length} iframes)`);
  return state;
}

// Resolved credentials (populated once in main() via getCredentials)
let resolvedUsername = null;
let resolvedPassword = null;

// ─── Command Execution ───────────────────────────────────────────────────────

async function executeCommand(page, cmd, allElements) {
  const target = getTarget(page);

  switch (cmd.action) {
    case 'screenshot':
      // Recapture only — handled by main loop after this returns
      break;

    case 'click': {
      const el = allElements.find(e => e.n === cmd.element);
      if (!el) throw new Error(`Element [${cmd.element}] not found`);
      console.log(`[explore] Clicking [${el.n}] ${el.tag}: "${el.text || el.selector}"`);
      try {
        await target.locator(el.selector).first().click({ timeout: 5000 });
      } catch {
        // Fallback: coordinate-based click (handles overlay-blocked elements)
        const x = el.bounds.x + el.bounds.w / 2;
        const y = el.bounds.y + el.bounds.h / 2;
        console.log(`[explore] Selector click failed, clicking coordinates (${x}, ${y})`);
        await page.mouse.click(x, y);
      }
      await page.waitForTimeout(2000);
      break;
    }

    case 'type': {
      const el = allElements.find(e => e.n === cmd.element);
      if (!el) throw new Error(`Element [${cmd.element}] not found`);
      let text = cmd.text;
      // Replace credential tokens with resolved credentials (Bitwarden or .env)
      if (text === '{{USERNAME}}' && resolvedUsername) text = resolvedUsername;
      if (text === '{{PASSWORD}}' && resolvedPassword) text = resolvedPassword;
      const logText = cmd.text.startsWith('{{') ? cmd.text : text.substring(0, 20) + '...';
      console.log(`[explore] Typing into [${el.n}] ${el.tag}: ${logText}`);
      try {
        await target.locator(el.selector).first().fill(text, { timeout: 5000 });
      } catch {
        // Fallback: click then keyboard type
        const x = el.bounds.x + el.bounds.w / 2;
        const y = el.bounds.y + el.bounds.h / 2;
        await page.mouse.click(x, y);
        await page.keyboard.type(text, { delay: 50 });
      }
      break;
    }

    case 'key':
      console.log(`[explore] Pressing key: ${cmd.key}`);
      await page.keyboard.press(cmd.key);
      await page.waitForTimeout(1000);
      break;

    case 'scroll': {
      const amount = cmd.amount || 300;
      const dir = cmd.direction || 'down';
      console.log(`[explore] Scrolling ${dir} ${amount}px`);
      await page.mouse.wheel(0, dir === 'up' ? -amount : amount);
      await page.waitForTimeout(500);
      break;
    }

    case 'navigate':
      console.log(`[explore] Navigating to ${cmd.url}`);
      await page.goto(cmd.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);
      break;

    case 'frame': {
      if (cmd.element === 'main' || cmd.element === -1) {
        currentFrameIndex = null;
        console.log('[explore] Switched to main frame');
      } else {
        const idx = typeof cmd.element === 'number' && cmd.element >= 100
          ? cmd.element - 100
          : cmd.element;
        currentFrameIndex = idx;
        console.log(`[explore] Switched to frame ${idx}`);
      }
      break;
    }

    case 'wait':
      console.log(`[explore] Waiting ${cmd.ms || 3000}ms`);
      await page.waitForTimeout(cmd.ms || 3000);
      break;

    case 'dismiss': {
      const dismissSelectors = [
        '#onetrust-accept-btn-handler',
        'button:has-text("Accept All")',
        'button:has-text("Accept Cookies")',
        'button:has-text("Dismiss")',
        'button:has-text("No thanks")',
        'button:has-text("Not now")',
        'button:has-text("Maybe later")',
        'button:has-text("Close")',
        'button[aria-label="Close"]',
        'button[aria-label="close"]',
        '[class*="modal"] button[class*="close"]',
      ];
      let dismissed = 0;
      for (const sel of dismissSelectors) {
        try {
          const btn = page.locator(sel).first();
          if (await btn.isVisible({ timeout: 500 })) {
            await btn.click({ timeout: 2000 });
            dismissed++;
            console.log(`[explore] Dismissed: ${sel}`);
            await page.waitForTimeout(1000);
          }
        } catch {}
      }
      if (!dismissed) console.log('[explore] No popups found to dismiss');
      break;
    }

    case 'back':
      console.log('[explore] Going back');
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);
      break;

    case 'evaluate':
      console.log(`[explore] Evaluating: ${cmd.code.substring(0, 60)}`);
      await target.evaluate(`(() => { ${cmd.code} })()`);
      await page.waitForTimeout(1000);
      break;

    default:
      console.log(`[explore] Unknown action: ${cmd.action}`);
  }
}

// ─── Command Polling ─────────────────────────────────────────────────────────

async function waitForCommand(timeoutMs = 600000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(commandFile)) {
      try {
        const raw = fs.readFileSync(commandFile, 'utf-8');
        fs.unlinkSync(commandFile);
        return JSON.parse(raw);
      } catch {
        try { fs.unlinkSync(commandFile); } catch {}
      }
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Pre-flight: encrypt any raw credentials before processing
  try {
    require('child_process').execSync('node scripts/encrypt-env.js', {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..'),
      timeout: 30000,
    });
  } catch {}

  console.log(`[explore] Starting interactive explorer for ${bank}`);
  console.log(`[explore] URL: ${url}`);
  console.log(`[explore] Profile: ${PROFILE_DIR}`);

  // Resolve credentials once at startup (Bitwarden → .env fallback)
  if (usernameEnv && passwordEnv) {
    try {
      const creds = await getCredentials(bank, { usernameEnv, passwordEnv });
      resolvedUsername = creds.username || '';
      resolvedPassword = creds.password || '';
    } catch {
      resolvedUsername = process.env[usernameEnv] || '';
      resolvedPassword = process.env[passwordEnv] || '';
    }
  }

  // Clean old command file
  try { fs.unlinkSync(commandFile); } catch {}

  const explorerDownloads = path.join(__dirname, '..', 'data', 'downloads', 'explorer');
  if (!fs.existsSync(explorerDownloads)) fs.mkdirSync(explorerDownloads, { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 720 },
    args: ['--disable-blink-features=AutomationControlled'],
    acceptDownloads: true,
    downloadsPath: explorerDownloads,
  });

  const page = context.pages()[0] || await context.newPage();

  console.log(`[explore] Navigating to ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  let step = 0;
  const history = [{ step, action: 'start', url }];

  // Initial state capture
  let state = await captureState(page, step);
  let lastElements = [...state.elements, ...state.inputs];

  console.log(`[explore] Ready. Send commands with: node readers/explore-cmd.js ${bank} <action> [args]`);

  // ─── Command loop ───
  while (true) {
    const cmd = await waitForCommand();
    if (!cmd) {
      console.log('[explore] Timeout — no commands for 10 minutes. Closing.');
      break;
    }

    if (cmd.action === 'done') {
      history.push({ step: step + 1, action: 'done' });
      fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));
      console.log(`[explore] Done. ${history.length} steps recorded → ${historyFile}`);
      break;
    }

    // Mark state as processing
    try {
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      s.ready = false;
      writeState(s);
    } catch {}

    try {
      await executeCommand(page, cmd, lastElements);
      step++;

      // Record in history (credentials sanitized)
      const entry = { step, ...cmd };
      if (cmd.action === 'type' && cmd.text && !cmd.text.startsWith('{{')) {
        entry.text = cmd.text.substring(0, 20) + (cmd.text.length > 20 ? '...' : '');
      }
      if (cmd.action === 'click' || cmd.action === 'type') {
        const el = lastElements.find(e => e.n === cmd.element);
        if (el) {
          entry.selector = el.selector;
          entry.elementText = el.text;
          entry.elementTag = el.tag;
        }
      }
      history.push(entry);

      // Recapture state
      state = await captureState(page, step);
      lastElements = [...state.elements, ...state.inputs];

    } catch (err) {
      console.error(`[explore] Error: ${err.message}`);
      step++;
      try {
        state = await captureState(page, step);
        state.error = err.message;
        writeState(state);
        lastElements = [...state.elements, ...state.inputs];
      } catch {}
      history.push({ step, action: cmd.action, error: err.message });
    }

    fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));
  }

  await context.close();
  process.exit(0);
}

main().catch(err => {
  console.error(`[explore] Fatal: ${err.message}`);
  process.exit(1);
});
