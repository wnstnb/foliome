/**
 * Graduated Error Recovery for Browser Reader
 *
 * 4-level recovery system for task-phase failures (balances, transactions):
 *   Level 1: Retry — wait + retry (3 attempts, 2s/5s/10s backoff)
 *   Level 2: Self-recover — dismiss popups, navigate to dashboard, retry
 *   Level 3: Adaptive bridge — screenshot + context → agent decides
 *   Level 4: Skip + notify — preserve partial data, screenshot, Telegram notification
 *
 * Maintenance pages and session expiration skip directly to Level 4.
 */

const fs = require('fs');
const path = require('path');
const { extractSanitizedText } = require('./sanitize-text');

const SCREENSHOT_DIR = path.join(__dirname, '..', 'data', 'adaptive-pending');
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const MAINTENANCE_KEYWORDS = [
  'scheduled maintenance',
  'temporarily unavailable',
  'system upgrade',
  'under maintenance',
  'planned maintenance',
  'service unavailable',
  'we\'re currently updating',
  'site is temporarily down',
  'performing maintenance',
  'back shortly',
  'try again later',
  'experiencing technical difficulties',
];

/**
 * Classify an error to determine recovery strategy.
 * @param {Error} error
 * @param {import('playwright').Page} page
 * @param {Object} reader - BrowserReader instance
 * @returns {Promise<{ category: string, isTransient: boolean, failedSelector: string|null }>}
 */
async function classifyError(error, page, reader) {
  const msg = error.message || String(error);
  const name = error.name || '';

  // Extract failed selector from Playwright error messages
  const selectorMatch = msg.match(/waiting for locator\(['"](.+?)['"]\)/);
  const failedSelector = selectorMatch ? selectorMatch[1] : null;

  // Check maintenance page
  try {
    if (await reader.isMaintenancePage()) {
      return { category: 'maintenance', isTransient: false, failedSelector };
    }
  } catch { /* page may not be accessible */ }

  // Check session expiration
  try {
    if (reader.isSessionExpired()) {
      return { category: 'session-expired', isTransient: false, failedSelector };
    }
  } catch { /* page may not be accessible */ }

  // Timeout errors — transient if page still has content
  if (name === 'TimeoutError' || msg.includes('TimeoutError') || msg.includes('Timeout') || msg.includes('timeout')) {
    let hasContent = false;
    try {
      const text = await extractSanitizedText(page, { unwrap: true });
      hasContent = text.length > 100;
    } catch { /* page gone */ }

    if (hasContent) {
      return { category: 'timeout', isTransient: true, failedSelector };
    }
    return { category: 'navigation', isTransient: false, failedSelector };
  }

  // Navigation errors
  if (msg.includes('net::ERR_') || msg.includes('Navigation') || msg.includes('navigating') || msg.includes('ERR_CONNECTION')) {
    return { category: 'navigation', isTransient: false, failedSelector };
  }

  // Selector not found
  if (msg.includes('waiting for locator') || msg.includes('not found') || msg.includes('strict mode violation')) {
    return { category: 'selector-not-found', isTransient: false, failedSelector };
  }

  return { category: 'unknown', isTransient: false, failedSelector };
}

/**
 * Capture structured error context for Level 3/4 diagnostics.
 * @param {import('playwright').Page} page
 * @param {Object} config - Institution config
 * @param {Object} taskContext - { task, step, selector?, partialResults? }
 * @param {Error} error
 * @param {Object} classification - from classifyError()
 * @returns {Promise<Object>}
 */
async function captureErrorContext(page, config, taskContext, error, classification) {
  const institution = config.institution;
  let screenshot = null;
  let url = null;
  let textSnippet = null;
  let elements = [];

  try {
    url = page.url();
  } catch { /* page gone */ }

  try {
    const ssPath = path.join(SCREENSHOT_DIR, `${institution}-task-error.png`);
    await page.screenshot({ path: ssPath, fullPage: false });
    screenshot = ssPath;
  } catch { /* screenshot failed */ }

  try {
    const text = await extractSanitizedText(page, { unwrap: true });
    textSnippet = text.substring(0, 2000);
  } catch { /* page gone */ }

  try {
    const { annotateElements } = require('./annotate');
    elements = await annotateElements(page, page);
  } catch { /* annotation failed */ }

  return {
    type: 'task-error',
    institution,
    task: taskContext.task,
    step: taskContext.step,
    failedSelector: classification.failedSelector || taskContext.selector || null,
    error: {
      message: (error.message || String(error)).substring(0, 500),
      category: classification.category,
    },
    page: {
      url,
      textSnippet,
    },
    screenshot,
    elements: elements.slice(0, 50),
    recoveryAttempts: taskContext._recoveryAttempts || 0,
  };
}

/**
 * Execute an action with graduated recovery.
 * @param {import('playwright').Page} page
 * @param {Object} config - Institution config
 * @param {Object} reader - BrowserReader instance
 * @param {Object} taskContext - { task, step, selector?, partialResults? }
 * @param {function} action - async () => result
 * @returns {Promise<Object|null>} result or null (caller preserves partial data)
 */
async function withRecovery(page, config, reader, taskContext, action) {
  const institution = config.institution;
  taskContext._recoveryAttempts = 0;

  // First attempt
  try {
    return await action();
  } catch (error) {
    console.log(`[${institution}:recovery] Task "${taskContext.task}" failed at step "${taskContext.step}": ${error.message.substring(0, 120)}`);

    const classification = await classifyError(error, page, reader);
    console.log(`[${institution}:recovery] Error classified as: ${classification.category} (transient: ${classification.isTransient})`);

    // Maintenance and session expiration → skip to Level 4
    if (classification.category === 'maintenance') {
      console.log(`[${institution}:recovery] Maintenance page detected — skipping to Level 4`);
      return await level4Skip(page, config, reader, taskContext, error, classification);
    }
    if (classification.category === 'session-expired') {
      console.log(`[${institution}:recovery] Session expired — skipping to Level 4`);
      return await level4Skip(page, config, reader, taskContext, error, classification);
    }

    // Level 1: Retry with backoff (transient errors)
    if (classification.isTransient) {
      const retryResult = await level1Retry(page, config, reader, taskContext, action);
      if (retryResult !== null) return retryResult;
    }

    // Level 2: Self-recover (dismiss popups, navigate to dashboard, retry)
    if (classification.category !== 'unknown') {
      const recoverResult = await level2SelfRecover(page, config, reader, taskContext, action);
      if (recoverResult !== null) return recoverResult;
    }

    // Level 3: Adaptive bridge (screenshot + context → agent decides)
    const adaptiveResult = await level3AdaptiveBridge(page, config, reader, taskContext, action, error, classification);
    if (adaptiveResult !== null) return adaptiveResult;

    // Level 4: Skip + notify
    return await level4Skip(page, config, reader, taskContext, error, classification);
  }
}

/**
 * Level 1: Retry with exponential backoff.
 */
async function level1Retry(page, config, reader, taskContext, action) {
  const institution = config.institution;
  const delays = [2000, 5000, 10000];

  for (let i = 0; i < delays.length; i++) {
    taskContext._recoveryAttempts++;
    console.log(`[${institution}:recovery] Level 1 — retry ${i + 1}/3 (waiting ${delays[i] / 1000}s)...`);
    await new Promise(r => setTimeout(r, delays[i]));

    try {
      const result = await action();
      console.log(`[${institution}:recovery] Level 1 — retry ${i + 1} succeeded`);
      return result;
    } catch (retryError) {
      console.log(`[${institution}:recovery] Level 1 — retry ${i + 1} failed: ${retryError.message.substring(0, 80)}`);
    }
  }

  console.log(`[${institution}:recovery] Level 1 exhausted — escalating`);
  return null;
}

/**
 * Level 2: Self-recover — dismiss popups, navigate to dashboard, retry once.
 */
async function level2SelfRecover(page, config, reader, taskContext, action) {
  const institution = config.institution;
  taskContext._recoveryAttempts++;

  console.log(`[${institution}:recovery] Level 2 — attempting self-recovery...`);

  try {
    // Dismiss any popups/modals that may be blocking
    await reader.dismissPopups();
    await page.waitForTimeout(1000);

    // Navigate back to dashboard if we have a URL
    if (config.dashboardUrl) {
      console.log(`[${institution}:recovery] Level 2 — navigating to dashboard: ${config.dashboardUrl}`);
      await page.goto(config.dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(3000);
      await reader.dismissPopups();
    }

    // Retry the action
    const result = await action();
    console.log(`[${institution}:recovery] Level 2 — self-recovery succeeded`);
    return result;
  } catch (error) {
    console.log(`[${institution}:recovery] Level 2 — self-recovery failed: ${error.message.substring(0, 80)}`);
    return null;
  }
}

/**
 * Level 3: Adaptive bridge — take screenshot, write task-error request, wait for agent instruction.
 */
async function level3AdaptiveBridge(page, config, reader, taskContext, action, error, classification) {
  const institution = config.institution;
  taskContext._recoveryAttempts++;

  console.log(`[${institution}:recovery] Level 3 — requesting adaptive help...`);

  try {
    const errorContext = await captureErrorContext(page, config, taskContext, error, classification);
    const { requestTaskErrorHelp, waitForInstruction } = require('./adaptive-bridge');

    requestTaskErrorHelp(institution, errorContext);

    // Wait for agent instruction (60s timeout — faster than login adaptive's 300s)
    const instruction = await waitForInstruction(institution, 60000);
    if (!instruction) {
      console.log(`[${institution}:recovery] Level 3 — no instruction received (60s timeout)`);
      return null;
    }

    // Execute agent instructions
    console.log(`[${institution}:recovery] Level 3 — executing ${(instruction.actions || []).length} agent actions...`);
    for (const act of (instruction.actions || [])) {
      try {
        if (act.action === 'click' && act.selector) {
          await page.locator(act.selector).first().click({ timeout: 5000 });
        } else if (act.action === 'type' && act.selector && act.text) {
          await page.locator(act.selector).first().fill(act.text, { timeout: 5000 });
        } else if (act.action === 'evaluate' && act.code) {
          await page.evaluate(`(() => { ${act.code} })()`);
        } else if (act.action === 'wait') {
          await page.waitForTimeout(act.ms || 3000);
        } else if (act.action === 'navigate' && act.url) {
          await page.goto(act.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        } else if (act.action === 'key') {
          await page.keyboard.press(act.key || 'Enter');
        }
        await page.waitForTimeout(500);
      } catch (e) {
        console.log(`[${institution}:recovery] Level 3 action error: ${e.message.substring(0, 60)}`);
      }
    }

    // Clean up adaptive files
    const adaptive = require('./adaptive-bridge');
    adaptive.cleanup(institution);

    // Retry the action after agent intervention
    await page.waitForTimeout(2000);
    const result = await action();
    console.log(`[${institution}:recovery] Level 3 — adaptive recovery succeeded`);
    return result;
  } catch (adaptiveError) {
    console.log(`[${institution}:recovery] Level 3 — adaptive recovery failed: ${adaptiveError.message.substring(0, 80)}`);
    try { require('./adaptive-bridge').cleanup(institution); } catch {}
    return null;
  }
}

/**
 * Level 4: Skip + notify — screenshot, structured error, Telegram notification, return null.
 */
async function level4Skip(page, config, reader, taskContext, error, classification) {
  const institution = config.institution;

  console.log(`[${institution}:recovery] Level 4 — skipping task "${taskContext.task}" with notification`);

  // Capture diagnostic context
  let errorContext;
  try {
    errorContext = await captureErrorContext(page, config, taskContext, error, classification);
  } catch {
    errorContext = {
      type: 'task-error',
      institution,
      task: taskContext.task,
      step: taskContext.step,
      error: { message: error.message, category: classification.category },
    };
  }

  // Send Telegram notification
  try {
    const telegram = require('../scripts/telegram-notify');
    const name = institution.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const msg = `⚠️ ${name} — task "${taskContext.task}" failed\nStep: ${taskContext.step}\nError: ${classification.category}\n${(error.message || '').substring(0, 200)}`;
    await telegram.sendMessage(msg).catch(() => {});
  } catch { /* telegram not configured */ }

  // Store error info for result file
  taskContext._error = {
    task: taskContext.task,
    step: taskContext.step,
    category: classification.category,
    message: (error.message || String(error)).substring(0, 300),
    screenshot: errorContext.screenshot || null,
  };

  return null;
}

module.exports = { classifyError, captureErrorContext, withRecovery };
