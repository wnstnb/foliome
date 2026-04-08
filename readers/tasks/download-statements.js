/**
 * Task: Download Statement PDFs for Statement Balance Extraction
 *
 * Config-driven module that navigates to an institution's statements page,
 * downloads PDF statements per account, and returns raw PDF text for
 * agent-side extraction of period dates and closing balances.
 *
 * Reads config from `config.statementBalances` — structured per account type
 * (checking, savings, credit, mortgage) as written by /learn-institution Q10-Q15.
 *
 * Each account type with `source: 'pdf'` provides three hooks:
 *   - beforeDownloads(page, accountId) — setup before downloading (expand accordion, etc.)
 *   - download(page, accountId, rowIdx) — download one statement, returns Playwright Download
 *   - afterDownloads(page, accountId) — cleanup after downloading (collapse, purge stale DOM)
 *
 * The generic wrapper handles: navigation, page readiness, iteration over accounts
 * and months, file saving, PDF parsing via LiteParse, and error handling.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { statementPath } = require('./download-path');

const ACCOUNT_TYPES = ['checking', 'savings', 'credit', 'mortgage'];

/**
 * @param {import('playwright').Page} page - Authenticated page (post-login, on dashboard)
 * @param {Object} config - Institution config with statementBalances section
 * @param {Object} options - { months: number } — how many months to download per account
 * @returns {Promise<{ statementBalances: Array, pendingExtraction?: Object }>}
 */
async function run(page, config, options = {}) {
  const { institution } = config;
  const stmtConfig = config.statementBalances;
  const months = options.months || 3;

  if (!stmtConfig) {
    console.log(`[${institution}:statements] No statementBalances config — skipping`);
    return { statementBalances: [] };
  }

  // Check if any account type has a download function
  const hasDownloads = ACCOUNT_TYPES.some(type => stmtConfig[type]?.download);
  if (!hasDownloads) {
    console.log(`[${institution}:statements] No PDF download functions configured — skipping`);
    return { statementBalances: [] };
  }

  console.log(`[${institution}:statements] Downloading up to ${months} months of statement PDFs`);

  // Navigate to statements page
  if (stmtConfig.statementsUrl) {
    console.log(`[${institution}:statements] Navigating to statements page...`);
    await page.goto(stmtConfig.statementsUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(5000);
  } else if (stmtConfig.statementsNavSelector) {
    console.log(`[${institution}:statements] Clicking statements nav...`);
    await page.locator(stmtConfig.statementsNavSelector).first().click({ timeout: 10000 });
    await page.waitForTimeout(5000);
  }

  // Wait for page content with retry
  if (stmtConfig.pageReadyPatterns) {
    for (let retry = 0; retry < 3; retry++) {
      const text = await page.evaluate(() => document.body.innerText);
      if (stmtConfig.pageReadyPatterns.some(p => text.includes(p))) break;
      if (stmtConfig.errorRetry && text.includes(stmtConfig.errorRetry.text)) {
        await page.locator(stmtConfig.errorRetry.selector).click({ timeout: 5000 }).catch(() => {});
      }
      await page.waitForTimeout(3000);
    }
  }

  const results = [];

  for (const type of ACCOUNT_TYPES) {
    const typeConfig = stmtConfig[type];
    if (!typeConfig || !typeConfig.download) continue;

    // Only download for PDF-sourced types
    const source = typeConfig.source || typeConfig.historicalSource;
    if (source !== 'pdf') continue;

    // Get accounts of this type from the institution's account list
    const accountsOfType = (config.accounts || []).filter(a => a.accountType === type);
    if (accountsOfType.length === 0) continue;

    for (const acct of accountsOfType) {
      console.log(`[${institution}:statements] Processing ${acct.accountId} (${type})`);

      // Setup hook (expand accordion, select account, etc.)
      if (typeConfig.beforeDownloads) {
        try {
          await typeConfig.beforeDownloads(page, acct.accountId);
        } catch (e) {
          console.log(`[${institution}:statements]   beforeDownloads failed: ${e.message.substring(0, 60)}`);
          continue;
        }
      }

      // Download up to `months` statements
      for (let rowIdx = 0; rowIdx < months; rowIdx++) {
        const filepath = statementPath(institution, acct.accountId);

        try {
          const dl = await typeConfig.download(page, acct.accountId, rowIdx);
          await dl.saveAs(filepath);

          const size = fs.statSync(filepath).size;
          console.log(`[${institution}:statements]   Downloaded: ${path.basename(filepath)} (${size} bytes)`);

          // Parse PDF via LiteParse
          try {
            const pdfText = execSync(`liteparse parse "${filepath}"`, {
              encoding: 'utf-8',
              timeout: 30000,
              stdio: ['pipe', 'pipe', 'pipe'],
            });
            results.push({
              accountId: acct.accountId,
              accountType: acct.accountType || type,
              fileName: path.basename(filepath),
              text: pdfText,
              source: 'pdf',
            });
          } catch (e) {
            console.log(`[${institution}:statements]   PDF parse failed: ${e.message.substring(0, 60)}`);
          }

          await page.waitForTimeout(500);
        } catch (e) {
          console.log(`[${institution}:statements]   Download failed row ${rowIdx}: ${e.message.substring(0, 80)}`);
          break;
        }
      }

      // Cleanup hook (collapse accordion, purge stale DOM, etc.)
      if (typeConfig.afterDownloads) {
        try {
          await typeConfig.afterDownloads(page, acct.accountId);
        } catch {}
      }
    }
  }

  console.log(`[${institution}:statements] Downloaded ${results.length} statement PDFs total`);

  return {
    statementBalances: [],
    pendingExtraction: results.length > 0 ? { statementPdfs: results } : undefined,
  };
}

module.exports = { run };
