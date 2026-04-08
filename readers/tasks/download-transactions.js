/**
 * Task: Download Transactions
 *
 * Uses the bank's CSV download dialog to get transactions for each account.
 * Handles first-run (all transactions) vs incremental (date range) modes.
 * Parses CSV into canonical transaction schema.
 */

const fs = require('fs');
const path = require('path');
const { matchAccount, addAlias } = require('../account-matcher');
const { transactionPath, statementPath, zipPath, unzipDir } = require('./download-path');

/**
 * @param {import('playwright').Page} page - Authenticated page
 * @param {Object} config - Institution config
 * @param {Object} options
 * @param {string} [options.mode] - 'all' for full history, 'incremental' for date range
 * @param {string} [options.fromDate] - For incremental: start date (YYYY-MM-DD)
 * @param {string} [options.toDate] - For incremental: end date (YYYY-MM-DD)
 * @param {string[]} [options.accountIds] - Specific accounts to download (default: all)
 * @returns {Promise<{ transactions: Array }>}
 */
async function run(page, config, options = {}) {
  const { institution, accounts: accountList } = config;
  const txnConfig = config.transactions;
  const mode = options.mode || 'all';
  const toDate = options.toDate || formatDate(new Date());
  const fromDate = options.fromDate || null;

  if (txnConfig.directExport) {
    return runDirectExport(page, config, options);
  } else if (txnConfig.exportModal) {
    return runExportModal(page, config, options);
  } else if (txnConfig.pdfBased) {
    return runPdfStatements(page, config, options);
  } else if (txnConfig.reportBased) {
    return runReportBased(page, config, options);
  } else if (txnConfig.perAccount) {
    return runPerAccount(page, config, options);
  } else {
    return runCentralDialog(page, config, options);
  }
}

/**
 * Pattern E: Direct export.
 * Navigate to a page, click an export button, CSV downloads immediately.
 * Simplest pattern — no date picker, no account selector, no modal.
 */
async function runDirectExport(page, config, options) {
  const { institution, accounts: accountList } = config;
  const txnConfig = config.transactions;

  // Navigate to the transaction page if needed
  if (txnConfig.navigateToTransactions) {
    // Custom navigation function — for SPAs where locator.click() doesn't trigger React events
    console.log(`[${institution}:txns] Navigating to transaction page (custom)...`);
    await txnConfig.navigateToTransactions(page, options);
    await page.waitForTimeout(5000);
    await dismissPopups(page);
  } else if (txnConfig.navigationSelector) {
    console.log(`[${institution}:txns] Navigating to transaction page...`);
    await page.locator(txnConfig.navigationSelector).first().click({ timeout: 10000 });
    await page.waitForTimeout(5000);
    await dismissPopups(page);
  }

  // Click the export button
  console.log(`[${institution}:txns] Clicking export button...`);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.locator(txnConfig.exportButtonSelector).click(),
  ]);

  const acct = accountList[0] || { accountId: `${institution}-all`, accountType: 'education' };
  const savePath = transactionPath(institution, acct.accountId);
  await download.saveAs(savePath);
  console.log(`[${institution}:txns] Downloaded: ${savePath} (${fs.statSync(savePath).size} bytes)`);

  const transactions = parseCSV(savePath, acct, institution, txnConfig.csvSkipRows || 0);
  console.log(`[${institution}:txns] Parsed ${transactions.length} transactions`);

  return { transactions };
}

/**
 * Pattern D: Export modal with calendar date picker.
 * Navigate to a page, open an export modal, set date range via calendar picker,
 * click export. All interactions via page.evaluate() to bypass backdrop overlays.
 */
async function runExportModal(page, config, options) {
  const { institution, accounts: accountList } = config;
  const txnConfig = config.transactions;
  const mode = options.mode || 'all';

  // Navigate to statements/export page
  if (txnConfig.statementsLinkSelector) {
    console.log(`[${institution}:txns] Navigating to statements...`);
    await page.locator(txnConfig.statementsLinkSelector).first().click({ timeout: 10000 });
    await page.waitForTimeout(3000);
  }

  // Open export modal
  if (txnConfig.exportLinkSelector) {
    console.log(`[${institution}:txns] Opening export modal...`);
    await page.locator(txnConfig.exportLinkSelector).first().click({ timeout: 10000 });
    await page.waitForTimeout(3000);
  }

  // Set start date via calendar picker (if configured)
  if (txnConfig.startDateClickSelector && mode === 'all') {
    console.log(`[${institution}:txns] Setting start date...`);
    // Open the date picker via evaluate (bypass backdrop)
    await page.evaluate((sel) => {
      const rows = document.querySelectorAll('.flexible-row');
      for (const row of rows) {
        if (row.textContent.includes('Start Date')) {
          const btn = row.querySelector('ui-button');
          if (btn) btn.click();
          break;
        }
      }
    });
    await page.waitForTimeout(2000);

    // Navigate back in months
    if (txnConfig.prevMonthSelector) {
      const monthsBack = txnConfig.monthsBack || 14;
      console.log(`[${institution}:txns] Navigating ${monthsBack} months back...`);
      for (let i = 0; i < monthsBack; i++) {
        await page.evaluate((sel) => {
          const btn = document.querySelector(sel);
          if (btn) btn.click();
        }, txnConfig.prevMonthSelector);
        await page.waitForTimeout(300);
      }
      await page.waitForTimeout(1000);

      // Verify month
      const currentMonth = await page.evaluate((sel) => {
        const trigger = document.querySelector(sel);
        return trigger ? trigger.textContent.trim() : 'unknown';
      }, txnConfig.monthYearTriggerSelector || '.month-year-trigger');
      console.log(`[${institution}:txns] Current month: ${currentMonth}`);
    }

    // Click day 1
    if (txnConfig.dayButtonSelector) {
      await page.evaluate((sel) => {
        const btns = document.querySelectorAll(sel);
        for (const btn of btns) {
          if (btn.textContent.trim() === '1') { btn.click(); break; }
        }
      }, txnConfig.dayButtonSelector);
      console.log(`[${institution}:txns] Selected day 1`);
      await page.waitForTimeout(1000);
    }
  }

  // Click export (via evaluate to bypass backdrop)
  console.log(`[${institution}:txns] Clicking export...`);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.evaluate((sel) => {
      const buttons = document.querySelectorAll('ui-button, button');
      for (const btn of buttons) {
        if (btn.textContent.trim() === 'Export' && btn.classList.contains('primary')) {
          btn.click();
          return true;
        }
      }
      // Fallback
      const el = document.querySelector(sel);
      if (el) { el.click(); return true; }
      return false;
    }, txnConfig.exportButtonSelector || 'ui-button:has-text("Export")'),
  ]);

  const acct = accountList[0] || { accountId: `${institution}-all`, accountType: 'credit' };
  const savePath = transactionPath(institution, acct.accountId);
  await download.saveAs(savePath);
  console.log(`[${institution}:txns] Downloaded: ${savePath} (${fs.statSync(savePath).size} bytes)`);

  const transactions = parseCSV(savePath, acct, institution);
  console.log(`[${institution}:txns] Parsed ${transactions.length} transactions`);

  return { transactions };
}

/**
 * Pattern A: Central download dialog.
 * One dialog with an account dropdown — cycle through accounts without leaving the page.
 */
async function runCentralDialog(page, config, options) {
  const { institution, accounts: accountList } = config;
  const txnConfig = config.transactions;
  const mode = options.mode || 'all';
  const toDate = options.toDate || formatDate(new Date());
  const fromDate = options.fromDate || null;

  // Navigate to an account page to access the download button
  console.log(`[${institution}:txns] Navigating to first account page...`);
  await navigateToAccountPage(page, config);

  // Click the download button to open the dialog (or navigate to download page)
  console.log(`[${institution}:txns] Opening download dialog...`);
  await page.locator(txnConfig.downloadButtonSelector).click({ timeout: 5000 });
  await page.waitForTimeout(txnConfig.postNavigateWaitMs || 2000);

  // Get all accounts listed in the dropdown
  const dropdownAccounts = await getDropdownOptions(page, txnConfig.accountDropdownButton);
  console.log(`[${institution}:txns] Found ${dropdownAccounts.length} accounts in dropdown:`);
  dropdownAccounts.forEach(a => console.log(`[${institution}:txns]   - "${a}"`));

  const allTransactions = [];

  for (const dropdownEntry of dropdownAccounts) {
    const match = matchAccount(dropdownEntry, accountList);
    if (!match) {
      console.log(`[${institution}:txns] Skipping unrecognized account: "${dropdownEntry}"`);
      continue;
    }
    if (options.accountIds && !options.accountIds.includes(match.account.accountId)) continue;

    const acct = match.account;
    console.log(`[${institution}:txns] Downloading ${acct.accountId} ("${dropdownEntry}")...`);
    addAlias(institution, acct.accountId, dropdownEntry);

    await selectDropdownOption(page, txnConfig.accountDropdownButton, dropdownEntry);

    // Select file format: dropdown (Chase) or custom function (Wells Fargo radio buttons)
    if (txnConfig.selectFileFormat) {
      await txnConfig.selectFileFormat(page);
    } else if (txnConfig.fileTypeDropdownButton) {
      await selectDropdownOption(page, txnConfig.fileTypeDropdownButton, txnConfig.fileTypeLabel || 'Spreadsheet (Excel, CSV)');
    }

    // Set date range: activity dropdown (Chase) or direct date inputs (Wells Fargo)
    if (txnConfig.activityDropdownButton) {
      if (mode === 'all') {
        await selectDropdownOption(page, txnConfig.activityDropdownButton, txnConfig.allTransactionsLabel || 'All transactions');
      } else {
        await selectDropdownOption(page, txnConfig.activityDropdownButton, txnConfig.dateRangeLabel || 'Choose a date range');
        await page.waitForTimeout(1000);
        const from = fromDate || subtractDays(toDate, 30);
        await fillDateInput(page, txnConfig.fromDateSelector, formatDateMDY(from));
        await fillDateInput(page, txnConfig.toDateSelector, formatDateMDY(toDate));
        await page.waitForTimeout(500);
      }
    } else if (txnConfig.fillDateInputs) {
      // Custom date input handler (e.g., for readonly inputs that need JS value setting)
      const maxMonths = txnConfig.maxHistoryMonths || 18;
      const from = fromDate || (mode === 'all' ? subtractDays(toDate, maxMonths * 30) : subtractDays(toDate, 30));
      await txnConfig.fillDateInputs(page, formatDateMDY(from), formatDateMDY(toDate));
    } else if (txnConfig.fromDateSelector) {
      // Direct date inputs (no activity dropdown) — always fill dates
      const maxMonths = txnConfig.maxHistoryMonths || 18;
      const from = fromDate || (mode === 'all' ? subtractDays(toDate, maxMonths * 30) : subtractDays(toDate, 30));
      await fillDateInput(page, txnConfig.fromDateSelector, formatDateMDY(from));
      await fillDateInput(page, txnConfig.toDateSelector, formatDateMDY(toDate));
      await page.waitForTimeout(500);
    }

    const csvPath = await downloadCSV(page, txnConfig.downloadSubmitSelector, acct.accountId, institution);
    if (csvPath) {
      const transactions = parseCSV(csvPath, acct, institution, 0, txnConfig.csvColumns);
      console.log(`[${institution}:txns] Parsed ${transactions.length} transactions for ${acct.accountId}`);
      allTransactions.push(...transactions);
    } else {
      console.warn(`[${institution}:txns] No file downloaded for ${acct.accountId}`);
    }

    // Handle confirmation page (Pattern A: "Download other activity" or similar)
    await page.waitForTimeout(1000);
    try {
      const downloadOther = page.locator('button:has-text("Download other activity")');
      if (await downloadOther.isVisible({ timeout: 3000 })) {
        await downloadOther.click();
        console.log(`[${institution}:txns] Clicked "Download other activity"`);
        await page.waitForTimeout(2000);
      }
    } catch {}
  }

  try {
    await page.locator('button:has-text("Cancel")').click({ timeout: 3000 });
  } catch {}

  console.log(`[${institution}:txns] Total: ${allTransactions.length} transactions across ${dropdownAccounts.length} accounts`);
  return { transactions: allTransactions };
}

/**
 * Pattern B: Per-account download.
 * Navigate to each account page individually, click download, get CSV, go back.
 */
async function runPerAccount(page, config, options) {
  const { institution, accounts: accountList } = config;
  const txnConfig = config.transactions;
  const mode = options.mode || 'all';
  const toDate = options.toDate || formatDate(new Date());
  const fromDate = options.fromDate || null;
  const allTransactions = [];

  // Start from the dashboard
  const dashboardUrl = page.url();
  console.log(`[${institution}:txns] Starting per-account downloads from dashboard`);

  for (const acct of accountList) {
    if (options.accountIds && !options.accountIds.includes(acct.accountId)) continue;

    console.log(`[${institution}:txns] Navigating to ${acct.accountId} (${acct.bankName} ...${acct.last4})...`);

    // Navigate to this account's page
    // Pattern B: tiles may have the last-4 in a div (id="number_...XXXX") and
    // a "View Account" button (id="summary-<hash>") in the same tile container.
    // Strategy: find the tile containing the last-4, then click its View Account button.
    let clicked = false;

    if (acct.last4) {
      try {
        // Find the account tile that contains this last-4
        const tile = page.locator(`.account-tile:has(#number_\\.\\.\\.${acct.last4}), .tiles-layout__tile:has-text("...${acct.last4}")`).first();
        const viewBtn = tile.locator('button:has-text("View Account")');
        await viewBtn.click({ timeout: 5000 });
        clicked = true;
      } catch {
        // Fallback: try clicking any element containing the last4
        try {
          await page.locator(`text=...${acct.last4}`).first().click({ timeout: 3000 });
          clicked = true;
        } catch {}
      }
    }

    // Try by bank name
    if (!clicked) {
      try {
        const tile = page.locator(`.tiles-layout__tile:has-text("${acct.bankName}")`).first();
        const viewBtn = tile.locator('button:has-text("View Account")');
        await viewBtn.click({ timeout: 5000 });
        clicked = true;
      } catch {}
    }

    if (!clicked) {
      console.warn(`[${institution}:txns] Could not navigate to ${acct.accountId}, skipping`);
      continue;
    }

    await page.waitForTimeout(3000);

    // Dismiss any popups on the account page
    await dismissPopups(page);

    // Click "Download Transactions" link
    try {
      await page.locator(txnConfig.downloadLinkSelector).click({ timeout: 5000 });
      await page.waitForTimeout(2000);
    } catch (e) {
      console.warn(`[${institution}:txns] Download link not found for ${acct.accountId}: ${e.message}`);
      await goBack(page, txnConfig);
      continue;
    }

    // Select time period
    if (mode === 'all') {
      // Try selecting "Year-to-Date" or equivalent
      const allLabel = txnConfig.timePeriodOptions?.all || 'Year-to-Date';
      await selectTimePeriod(page, allLabel);
    } else {
      const customLabel = txnConfig.timePeriodOptions?.custom || 'Custom Date Range';
      await selectTimePeriod(page, customLabel);
      await page.waitForTimeout(1000);

      const from = fromDate || subtractDays(toDate, 30);
      await fillDateInput(page, txnConfig.fromDateSelector, formatDateMDY(from));
      await fillDateInput(page, txnConfig.toDateSelector, formatDateMDY(toDate));
      // Click inside the modal (not outside) to blur the date input and trigger validation.
      // Capital One's Angular form only enables the Download button after blur.
      const modalTitle = page.locator('.cdk-overlay-container h2, .cdk-overlay-container [class*="dialog-title"], .cdk-overlay-container [class*="header"]').first();
      if (await modalTitle.count() > 0) {
        await modalTitle.click({ timeout: 2000 }).catch(() => {});
      }
      await page.waitForTimeout(2000);
    }

    // Download
    const csvPath = await downloadCSV(page, txnConfig.downloadSubmitSelector, acct.accountId, institution);
    if (csvPath) {
      const transactions = parseCSV(csvPath, acct, institution);
      console.log(`[${institution}:txns] Parsed ${transactions.length} transactions for ${acct.accountId}`);
      allTransactions.push(...transactions);
    } else {
      console.warn(`[${institution}:txns] No file downloaded for ${acct.accountId}`);
    }

    // Dismiss "Download Started" modal
    await page.waitForTimeout(1000);
    await dismissPostDownload(page, txnConfig);

    // Go back to dashboard for next account
    // May need multiple backs (download page → account page → dashboard)
    // Safest: navigate directly to dashboard URL
    console.log(`[${institution}:txns] Returning to dashboard...`);
    await page.goto(config.entryUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(3000);
    await dismissPopups(page);
  }

  console.log(`[${institution}:txns] Total: ${allTransactions.length} transactions across ${accountList.length} accounts`);
  return { transactions: allTransactions };
}

/**
 * Pattern C: PDF statement download.
 * Two sub-patterns:
 *   - Yearly accordion ZIPs with "Download all" buttons
 *   - Native account dropdown with per-month Download buttons
 *
 * Detects which sub-pattern based on config keys:
 *   - accountDropdownSelector → per-account selection flow
 *   - otherwise → yearly ZIP flow
 */
async function runPdfStatements(page, config, options) {
  const { institution, accounts: accountList } = config;
  const txnConfig = config.transactions;
  const mode = options.mode || 'all';
  const { execSync } = require('child_process');

  const allTransactions = [];
  const allPendingPdfs = [];

  // Navigate to statements page
  if (txnConfig.statementsNavSelector) {
    console.log(`[${institution}:txns] Clicking statements nav...`);
    await page.locator(txnConfig.statementsNavSelector).first().click({ timeout: 10000 });
    await page.waitForTimeout(5000);
  } else {
    const statementsUrl = txnConfig.statementsUrl;
    if (!statementsUrl) throw new Error(`[${institution}] Pattern C requires statementsUrl in config`);
    console.log(`[${institution}:txns] Navigating to statements page...`);
    await page.goto(statementsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);
  }
  await dismissPopups(page);

  // Sub-pattern: per-account statement selection (Pattern C variant)
  if (txnConfig.accountDropdownSelector) {
    return runPerAccountStatements(page, config, options, allTransactions);
  }

  // Find all "Download all" buttons (one per year)
  const dlAllButtons = page.locator('button:has-text("Download all")');
  const yearCount = await dlAllButtons.count();
  console.log(`[${institution}:txns] Found ${yearCount} years of statements`);

  // Determine how many years to download — cap at 24 months (current year + previous year)
  const currentYear = new Date().getFullYear();
  let yearsToDownload = 1; // incremental: just current year
  if (mode === 'all') {
    yearsToDownload = Math.min(yearCount, 2); // current year + last year = 24 months max
  }

  for (let i = 0; i < yearsToDownload; i++) {
    console.log(`[${institution}:txns] Downloading year ${i + 1} of ${yearsToDownload}...`);

    // Expand the accordion if collapsed (aria-expanded="false")
    try {
      const accordion = page.locator(`button[id="statements-accordian-row${i}"]`);
      if (await accordion.count() > 0) {
        const expanded = await accordion.getAttribute('aria-expanded');
        if (expanded === 'false') {
          console.log(`[${institution}:txns] Expanding year accordion ${i}...`);
          await accordion.click();
          await page.waitForTimeout(1000);
        }
      }
    } catch {}

    try {
      // Scroll the button into view and click
      await dlAllButtons.nth(i).scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);

      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 30000 }),
        dlAllButtons.nth(i).click(),
      ]);

      const zPath = zipPath(institution);
      await download.saveAs(zPath);
      console.log(`[${institution}:txns] Downloaded: ${zPath} (${fs.statSync(zPath).size} bytes)`);

      // Unzip
      const uzDir = unzipDir(institution);

      try {
        execSync(`unzip -o "${zPath}" -d "${uzDir}"`, { encoding: 'utf-8' });
      } catch {
        // On Windows, try PowerShell
        try {
          execSync(`powershell -Command "Expand-Archive -Path '${zPath}' -DestinationPath '${uzDir}' -Force"`, { encoding: 'utf-8' });
        } catch (e) {
          console.error(`[${institution}:txns] Unzip failed: ${e.message}`);
          continue;
        }
      }

      // Find all PDFs in the unzipped directory
      const pdfFiles = fs.readdirSync(uzDir).filter(f => f.toLowerCase().endsWith('.pdf'));
      console.log(`[${institution}:txns] Found ${pdfFiles.length} PDFs in ZIP`);

      // Parse each PDF with LiteParse — raw text saved for agent extraction
      if (!allPendingPdfs) allPendingPdfs = [];
      for (const pdfFile of pdfFiles) {
        const pdfPath = path.join(uzDir, pdfFile);
        console.log(`[${institution}:txns] Extracting text from ${pdfFile}...`);

        try {
          const result = await parsePdfStatement(pdfPath, institution, accountList);
          if (result._isPendingPdf) {
            allPendingPdfs.push(result);
            console.log(`[${institution}:txns]   Text captured from ${pdfFile} — pending agent extraction`);
          } else {
            allTransactions.push(...result);
          }
        } catch (e) {
          console.error(`[${institution}:txns]   Failed to parse ${pdfFile}: ${e.message}`);
        }
      }

    } catch (e) {
      console.error(`[${institution}:txns] Download failed for year ${i + 1}: ${e.message}`);
    }

    await page.waitForTimeout(1000);
  }

  console.log(`[${institution}:txns] Total: ${allTransactions.length} transactions from ${yearsToDownload} year(s)`);
  const result = { transactions: allTransactions };
  if (allPendingPdfs && allPendingPdfs.length > 0) {
    result.pendingExtraction = { pdfTexts: allPendingPdfs };
    console.log(`[${institution}:txns] ${allPendingPdfs.length} PDFs pending agent extraction`);
  }
  return result;
}

/**
 * Pattern C variant: Per-account PDF statements.
 * Select each account from a native <select>, download per-month PDFs, extract text with LiteParse.
 */
async function runPerAccountStatements(page, config, options, allTransactions) {
  const { institution, accounts: accountList } = config;
  const txnConfig = config.transactions;
  const maxStatements = 3; // per account, recent months
  const allPendingPdfs = [];

  // Get account options from the dropdown
  const accountOptions = await page.$$eval(`${txnConfig.accountDropdownSelector} option`, opts =>
    opts.map(o => o.text.trim()).filter(t => t && !t.toLowerCase().includes('choose'))
  );
  console.log(`[${institution}:txns] Found ${accountOptions.length} accounts: ${accountOptions.join(', ')}`);

  for (const acctLabel of accountOptions) {
    // Match to known account
    const match = matchAccount(acctLabel, accountList);
    const acct = match ? match.account : { accountId: `${institution}-unknown`, accountType: 'checking' };
    console.log(`[${institution}:txns] Selecting ${acctLabel} → ${acct.accountId}`);

    await page.locator(txnConfig.accountDropdownSelector).selectOption({ label: acctLabel });
    await page.waitForTimeout(5000);

    // Find download buttons
    const dlButtons = page.locator(txnConfig.downloadButtonSelector || 'button[aria-label*="Download"]');
    const count = await dlButtons.count();
    console.log(`[${institution}:txns]   ${count} statements available`);

    const toDownload = Math.min(count, maxStatements);
    for (let i = 0; i < toDownload; i++) {
      const btn = dlButtons.nth(i);
      const label = await btn.getAttribute('aria-label').catch(() => `Statement ${i + 1}`);
      console.log(`[${institution}:txns]   Downloading: ${label}`);

      try {
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 15000 }),
          btn.click(),
        ]);
        const savePath = statementPath(institution, acct.accountId);
        await download.saveAs(savePath);

        const result = await parsePdfStatement(savePath, institution, [acct]);
        if (result._isPendingPdf) {
          if (!allPendingPdfs) allPendingPdfs = [];
          allPendingPdfs.push(result);
          console.log(`[${institution}:txns]   Text captured — pending agent extraction`);
        } else {
          console.log(`[${institution}:txns]   Extracted ${result.length} transactions`);
          allTransactions.push(...result);
        }
      } catch (e) {
        console.log(`[${institution}:txns]   Download/parse failed: ${e.message.substring(0, 80)}`);
      }
      await page.waitForTimeout(1000);
    }
  }

  console.log(`[${institution}:txns] Total: ${allTransactions.length} transactions`);
  const result = { transactions: allTransactions };
  if (allPendingPdfs && allPendingPdfs.length > 0) {
    result.pendingExtraction = { pdfTexts: allPendingPdfs };
    console.log(`[${institution}:txns] ${allPendingPdfs.length} PDFs pending agent extraction`);
  }
  return result;
}

async function parsePdfStatement(pdfPath, institution, accountList) {
  const { execSync } = require('child_process');

  // LiteParse extracts layout-aware text — raw text saved for agent extraction
  let pdfText;
  try {
    const raw = execSync(`lit parse "${pdfPath}" --format text`, { encoding: 'utf-8', timeout: 30000 });
    // Strip processing log lines
    pdfText = raw.split('\n')
      .filter(l => !l.startsWith('Processing') && !l.startsWith('Loaded') && !l.startsWith('Warning') && !l.startsWith('Running'))
      .join('\n')
      .trim();
  } catch (e) {
    throw new Error(`LiteParse failed: ${e.message}`);
  }

  if (pdfText.length < 50) {
    throw new Error('LiteParse produced too little text');
  }

  // Raw text saved for agent-side extraction (no API call)
  const acct = accountList[0] || { accountId: `${institution}-all`, accountType: 'checking' };
  console.log(`[pdf-parse] ${pdfText.length} chars extracted from ${path.basename(pdfPath)} — saved for agent extraction`);

  // Return raw text as a pending extraction marker
  return {
    _isPendingPdf: true,
    institution,
    accountId: acct.accountId,
    accountType: acct.accountType,
    fileName: path.basename(pdfPath),
    text: pdfText.substring(0, 12000),
  };
}

/**
 * Report-based download pattern.
 * Navigate to a reports page, configure the report (type, date range, format),
 * create it, wait for generation, then download the file from a results table.
 */
async function runReportBased(page, config, options) {
  const { institution, accounts: accountList } = config;
  const txnConfig = config.transactions;
  const mode = options.mode || 'all';
  const toDate = options.toDate || formatDate(new Date());
  const fromDate = options.fromDate || null;

  // Navigate to the reports page
  console.log(`[${institution}:txns] Navigating to reports page: ${txnConfig.reportUrl}`);
  await page.goto(txnConfig.reportUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(5000);
  await dismissPopups(page);

  // Set transaction type
  if (txnConfig.transactionTypeSelector) {
    try {
      await page.locator(txnConfig.transactionTypeSelector).selectOption(txnConfig.transactionTypeValue || 'Balance affecting');
      console.log(`[${institution}:txns] Set transaction type: ${txnConfig.transactionTypeValue}`);
      await page.waitForTimeout(500);
    } catch {
      // May be a custom dropdown — try clicking
      try {
        const btn = page.locator(`button[id*="Transactiontype"]`);
        await btn.click();
        await page.waitForTimeout(500);
        await page.locator(`text=${txnConfig.transactionTypeValue}`).first().click();
        await page.waitForTimeout(500);
      } catch (e) {
        console.log(`[${institution}:txns] Could not set transaction type: ${e.message}`);
      }
    }
  }

  // Set date range
  if (txnConfig.dateRangeSelector) {
    try {
      const dateInput = page.locator(txnConfig.dateRangeSelector);
      await dateInput.click();
      await page.waitForTimeout(1000);

      // The date range picker may show preset options or custom date inputs
      // Try to find and set a custom range or a preset
      if (mode === 'all') {
        // Look for a "Last year" or wide-range preset, or set custom dates
        // Some institutions allow up to 12 months, so set from 1 year ago to today
        const from = subtractDays(toDate, 365);
        await setDateRange(page, txnConfig, from, toDate);
      } else {
        const from = fromDate || subtractDays(toDate, 30);
        await setDateRange(page, txnConfig, from, toDate);
      }
    } catch (e) {
      console.log(`[${institution}:txns] Date range setting failed: ${e.message}`);
    }
  }

  // Set format to CSV
  if (txnConfig.formatSelector) {
    try {
      await page.locator(txnConfig.formatSelector).selectOption(txnConfig.formatValue || 'CSV');
      console.log(`[${institution}:txns] Set format: ${txnConfig.formatValue || 'CSV'}`);
      await page.waitForTimeout(500);
    } catch {
      try {
        const btn = page.locator(`button[id*="Format"]`);
        await btn.click();
        await page.waitForTimeout(500);
        await page.locator(`text=${txnConfig.formatValue || 'CSV'}`).first().click();
        await page.waitForTimeout(500);
      } catch (e) {
        console.log(`[${institution}:txns] Could not set format: ${e.message}`);
      }
    }
  }

  // Click Create Report
  console.log(`[${institution}:txns] Creating report...`);
  await page.locator(txnConfig.createReportSelector).click();
  await page.waitForTimeout(3000);

  // Wait for the report to generate — poll the table for a download link
  console.log(`[${institution}:txns] Waiting for report to generate...`);
  let downloaded = false;

  for (let attempt = 0; attempt < 12; attempt++) {
    // Click refresh if available
    if (txnConfig.refreshSelector) {
      try {
        await page.locator(txnConfig.refreshSelector).click({ timeout: 2000 });
        await page.waitForTimeout(2000);
      } catch {}
    } else {
      await page.waitForTimeout(5000);
    }

    // Look for a download link in the results table
    const dlLink = page.locator(txnConfig.downloadLinkSelector || 'a:has-text("Download")');
    if (await dlLink.count() > 0) {
      try {
        const firstDl = dlLink.first();
        if (await firstDl.isVisible({ timeout: 1000 })) {
          console.log(`[${institution}:txns] Report ready — downloading...`);

          // Capture the download
          const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 15000 }),
            firstDl.click(),
          ]);

          const acct = accountList[0] || { accountId: `${institution}-all`, accountType: 'checking' };
          const savePath = transactionPath(institution, acct.accountId);
          await download.saveAs(savePath);
          console.log(`[download] Saved: ${savePath}`);

          // Parse — report covers all accounts
          const transactions = parseCSV(savePath, acct, institution);
          console.log(`[${institution}:txns] Parsed ${transactions.length} transactions`);

          downloaded = true;

          return { transactions };
        }
      } catch (e) {
        console.log(`[${institution}:txns] Download attempt failed: ${e.message}`);
      }
    }

    console.log(`[${institution}:txns] Report not ready yet... (${(attempt + 1) * 5}s)`);
  }

  if (!downloaded) {
    // Dump current state for debugging
    const text = await page.evaluate(() => document.body.innerText);
    const reportLines = text.split('\n').filter(l => l.trim()).filter(l =>
      l.toLowerCase().includes('report') || l.toLowerCase().includes('download') || l.toLowerCase().includes('action')
    );
    if (reportLines.length) {
      console.log(`[${institution}:txns] Report-related text on page:`);
      reportLines.forEach(l => console.log(`  | ${l.trim().substring(0, 150)}`));
    }

    throw new Error(`Report generation timed out after 60s`);
  }
}

/**
 * Set date range for report-based downloads.
 * Some institutions use a date range input that may be a text field or date picker.
 */
async function setDateRange(page, txnConfig, fromDate, toDate) {
  const dateInput = page.locator(txnConfig.dateRangeSelector);

  // Click to open date picker
  await dateInput.click();
  await page.waitForTimeout(1000);

  // Look for start/end date inputs that appeared
  const fromInput = page.locator(txnConfig.fromDateSelector || 'input[placeholder*="Start"], input[name*="start"], input[id*="start"]').first();
  const toInput = page.locator(txnConfig.toDateSelector || 'input[placeholder*="End"], input[name*="end"], input[id*="end"]').first();

  if (await fromInput.isVisible({ timeout: 2000 }).catch(() => false)) {
    await fromInput.fill('');
    await fromInput.type(formatDateMDY(fromDate), { delay: 50 });
    await toInput.fill('');
    await toInput.type(formatDateMDY(toDate), { delay: 50 });
    console.log(`[download] Set date range: ${fromDate} to ${toDate}`);

    // Look for an Apply/Done button
    for (const sel of ['button:has-text("Apply")', 'button:has-text("Done")', 'button:has-text("OK")']) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1000 })) {
          await btn.click();
          await page.waitForTimeout(500);
          break;
        }
      } catch {}
    }
  } else {
    // May be a simple text input — try typing the range directly
    await dateInput.fill('');
    await dateInput.type(`${formatDateMDY(fromDate)} - ${formatDateMDY(toDate)}`, { delay: 30 });
    console.log(`[download] Typed date range: ${fromDate} to ${toDate}`);
    // Press Enter or Tab to confirm
    await dateInput.press('Tab');
    await page.waitForTimeout(500);
  }
}

/**
 * Dismiss popups on a page (bank promos, CreditWise, etc.)
 */
async function dismissPopups(page) {
  const dismissSelectors = [
    'button:has-text("Dismiss for now")',
    'button:has-text("Dismiss")',
    'button:has-text("No thanks")',
    'button:has-text("Not now")',
    'button:has-text("Maybe later")',
    'button[aria-label="Close"]',
    'button[aria-label="close"]',
  ];
  for (const sel of dismissSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 500 })) {
        await el.click({ timeout: 2000 });
        await page.waitForTimeout(500);
      }
    } catch {}
  }
}

/**
 * Select a time period in a download dialog with custom dropdown components.
 * Handles custom elements (e.g., shadow DOM selects) — click to open, then click the option.
 */
async function selectTimePeriod(page, label) {
  // Try clicking visible dropdown-like elements that might contain the time period
  // Some banks use custom select components that render as a button + listbox
  const selectButtons = page.locator('c1-ease-select button, [class*="select"] button');
  const count = await selectButtons.count();

  for (let i = 0; i < count; i++) {
    try {
      const btn = selectButtons.nth(i);
      if (!await btn.isVisible({ timeout: 500 })) continue;
      const text = await btn.textContent();
      // Find the time period dropdown (not the file type one)
      if (text && (text.includes('Days') || text.includes('Date') || text.includes('Year'))) {
        await btn.click();
        await page.waitForTimeout(500);
        // Now click the option
        const option = page.locator(`[role="option"]:visible:has-text("${label}")`);
        if (await option.count() > 0) {
          await option.first().click();
          await page.waitForTimeout(500);
          return true;
        }
        // Close if option not found
        await btn.click().catch(() => {});
      }
    } catch {}
  }

  // Fallback: try generic role="option" approach
  try {
    await selectDropdownOption(page, 'c1-ease-select:nth-of-type(2) button', label);
    return true;
  } catch {}

  console.warn(`[download] Could not select time period: "${label}"`);
  return false;
}

/**
 * Dismiss post-download confirmation modal.
 */
async function dismissPostDownload(page, txnConfig) {
  const selectors = txnConfig.postDownloadDismiss || [
    'button[aria-label="Close"]',
    'button:has-text("×")',
  ];
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 })) {
        await el.click({ timeout: 2000 });
        console.log(`[download] Dismissed post-download modal`);
        await page.waitForTimeout(1000);
        return;
      }
    } catch {}
  }
}

/**
 * Navigate back to the dashboard.
 */
async function goBack(page, txnConfig) {
  if (txnConfig.backButtonSelector) {
    try {
      await page.locator(txnConfig.backButtonSelector).click({ timeout: 3000 });
      return;
    } catch {}
  }
  // Fallback: browser back
  await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
}

/**
 * Navigate to an account page so the download button is accessible.
 */
async function navigateToAccountPage(page, config) {
  const url = page.url();
  // If already on an account page, stay there
  if (url.includes('/summary/') || url.includes('/Bank/')) return;

  // Click the first bank account to get to an account page
  const firstAccount = config.accounts[0];
  const keyword = firstAccount.bankName || firstAccount.accountId;

  try {
    await page.locator(`button:has-text("${keyword}")`).first().click({ timeout: 5000 });
    await page.waitForTimeout(3000);
  } catch {
    // Try by last4
    if (firstAccount.last4) {
      await page.locator(`button:has-text("${firstAccount.last4}")`).first().click({ timeout: 5000 });
      await page.waitForTimeout(3000);
    }
  }
}

/**
 * Get all option labels from a custom shadow DOM dropdown.
 * Some banks use custom select elements (e.g., <mds-select>) with <div role="option"> children.
 * Must click the button to reveal options, then read them.
 */
async function getDropdownOptions(page, buttonSelector) {
  // Click the dropdown button to open it
  await page.locator(buttonSelector).click();
  await page.waitForTimeout(500);

  // Read all visible options from the listbox
  const options = await page.$$eval('[role="option"]', els =>
    els.filter(el => el.offsetParent !== null)
      .map(el => el.textContent.trim().replace(/(.+)\1/, '$1')) // dedupe doubled text
  );

  // Close the dropdown by clicking the button again
  await page.locator(buttonSelector).click();
  await page.waitForTimeout(300);

  return options;
}

/**
 * Select an option in a custom MDS dropdown by clicking the button then the option.
 */
async function selectDropdownOption(page, buttonSelector, optionText) {
  // Open the dropdown
  await page.locator(buttonSelector).click();
  await page.waitForTimeout(500);

  // Click the option that matches
  const options = page.locator('[role="option"]:visible');
  const count = await options.count();
  for (let i = 0; i < count; i++) {
    const text = await options.nth(i).textContent();
    const cleaned = text.trim().replace(/(.+)\1/, '$1'); // dedupe doubled text
    if (cleaned === optionText || cleaned.includes(optionText) || optionText.includes(cleaned)) {
      await options.nth(i).click();
      await page.waitForTimeout(500);
      return true;
    }
  }

  // If exact match failed, try partial
  for (let i = 0; i < count; i++) {
    const text = await options.nth(i).textContent();
    const cleaned = text.trim().toLowerCase();
    if (cleaned.includes(optionText.toLowerCase())) {
      await options.nth(i).click();
      await page.waitForTimeout(500);
      return true;
    }
  }

  console.warn(`[download] Could not find option "${optionText}" in dropdown`);
  // Close the dropdown
  await page.locator(buttonSelector).click().catch(() => {});
  return false;
}

/**
 * Fill a date input field (mm/dd/yyyy format).
 */
async function fillDateInput(page, selector, dateStr) {
  const input = page.locator(selector);
  await input.click();
  await input.fill('');
  await input.type(dateStr, { delay: 50 });
}

/**
 * Click download and capture the downloaded file.
 */
async function downloadCSV(page, submitSelector, accountId, institution) {
  try {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }),
      page.locator(submitSelector).click(),
    ]);

    const savePath = transactionPath(institution, accountId);
    await download.saveAs(savePath);
    console.log(`[download] Saved: ${savePath}`);
    return savePath;
  } catch (e) {
    console.error(`[download] Failed: ${e.message}`);
    return null;
  }
}

/**
 * Parse a bank CSV file into raw transaction objects.
 * Schema-agnostic — preserves all columns from the CSV as-is.
 * Each row becomes an object with the original column names as keys,
 * plus accountId and institution for identification.
 */
function parseCSV(csvPath, account, institution, csvSkipRows = 0, csvColumns = null) {
  const raw = fs.readFileSync(csvPath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());
  // Skip metadata rows (e.g., NetBenefits has "Plan name:" and "Date Range" before header)
  const dataLines = lines.slice(csvSkipRows);

  // Headerless CSV: if csvColumns provided, use those as header names and treat all lines as data
  let header, dataStartIdx;
  if (csvColumns) {
    header = csvColumns;
    dataStartIdx = 0;
    if (dataLines.length < 1) return [];
  } else {
    header = parseCSVLine(dataLines[0]).map(h => h.trim());
    dataStartIdx = 1;
    if (dataLines.length < 2) return [];
  }

  const transactions = [];

  for (let i = dataStartIdx; i < dataLines.length; i++) {
    const cols = parseCSVLine(dataLines[i]);
    if (cols.length < 2) continue;

    // Build raw record preserving all columns
    const record = {};
    header.forEach((col, idx) => {
      if (col && idx < cols.length) {
        record[col] = cols[idx].trim();
      }
    });

    // Skip empty rows
    const hasContent = Object.values(record).some(v => v.length > 0);
    if (!hasContent) continue;

    transactions.push({
      institution,
      accountId: account.accountId,
      accountType: account.accountType,
      raw: record,
    });
  }

  return transactions;
}

/**
 * Simple CSV line parser that handles quoted fields.
 */
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// Date helpers
function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

function formatDateMDY(dateStr) {
  // YYYY-MM-DD → MM/DD/YYYY
  const [y, m, d] = dateStr.split('-');
  return `${m}/${d}/${y}`;
}

function subtractDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() - days);
  return formatDate(d);
}

module.exports = { run };
