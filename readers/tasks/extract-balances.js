/**
 * Task: Extract Balances
 *
 * Captures dashboard page text and saves it for agent-side extraction.
 * The agent harness (Claude Code, etc.) handles LLM extraction — no direct API calls.
 * Receives an authenticated Playwright page (post-login, post-MFA).
 */

/**
 * @param {import('playwright').Page} page - Authenticated page
 * @param {Object} config - Institution config
 * @returns {Promise<{ balances: Array, pendingExtraction: Object }>}
 */
async function run(page, config) {
  const { extractSanitizedText } = require('../sanitize-text');
  const { institution } = config;

  // Navigate to dashboard if not already there
  const url = page.url();
  const dashboardUrl = config.dashboardUrl || config.entryUrl;
  const isOnDashboard = config.login.loggedInPatterns
    ? (await extractSanitizedText(page, { unwrap: true })).length > 300
    : url.includes('dashboard');

  if (!isOnDashboard) {
    console.log(`[${institution}:balances] Navigating to dashboard...`);
    await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);
  }

  // Wait for dashboard content to render
  try {
    await page.waitForFunction(
      () => document.body.innerText.length > 500 && !document.body.innerText.trim().match(/^loading$/i),
      { timeout: 15000 }
    );
  } catch {
    console.warn(`[${institution}:balances] Timeout waiting for dashboard content`);
  }
  await page.waitForTimeout(2000);

  // Capture sanitized page text (Layer 1 strips hidden injections, Layer 2 adds boundary markers)
  const pageText = await extractSanitizedText(page);
  if (pageText.length < 100) {
    throw new Error('Dashboard text too short — page may not have loaded');
  }

  console.log(`[${institution}:balances] Captured ${pageText.length} chars — saved for agent extraction`);

  // Return sanitized text for agent extraction (no API call)
  return {
    balances: [],
    pendingExtraction: {
      balanceText: pageText.substring(0, 8000),
    },
  };
}

module.exports = { run };
