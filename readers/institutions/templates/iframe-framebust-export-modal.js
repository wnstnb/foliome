/**
 * Template: Iframe Login + Frame-Busting MFA + Shadow DOM Nav + Export Modal
 *
 * Login: Login form inside an iframe. After credential submission, the iframe
 *   "frame-busts" — navigates the parent page to the MFA/auth flow. The login
 *   iframe is no longer available after submission. The browser-reader detects
 *   this automatically and falls back to the main page for MFA code entry.
 *
 * MFA: Multi-step SMS with intermediate modal (phone number selection).
 *   Uses `mfaSteps` to handle steps between clicking the initiation button
 *   and the code input appearing. Also supports push notifications.
 *
 * Navigation: Post-login pages use shadow DOM web components (e.g.,
 *   <responsive-meganav>) for navigation. The interactive explorer can't
 *   annotate elements inside shadow roots — use page.locator() which pierces
 *   shadow DOM automatically, or reach in via element.shadowRoot in evaluate().
 *
 * Transactions: Central page with account selector dropdown + native <select>
 *   date range + export button that opens a format modal (CSV/JSON/XML).
 *   Pattern A variant — all accounts accessible from one page.
 *
 * Statements: PDF statements per account per month on a statements page.
 *   Same account selector as transactions. Direct PDF download buttons.
 *
 * Use this template when:
 *   - Login form is in an iframe that frame-busts (navigates parent page) for MFA
 *   - Post-login navigation uses shadow DOM web components
 *   - Transaction export uses a modal with format selection
 */

module.exports = {
  institution: 'example-bank',  // Replace with your institution slug
  entryUrl: 'https://www.example.com/login',
  dashboardUrl: 'https://client.example.com/app/accounts/summary/',

  security: {
    expectedDomain: 'client.example.com',
    requireHttps: true,
  },

  credentials: {
    usernameEnv: 'EXAMPLEBROKERAGE_USERNAME',  // Set in .env or map in credential-map.json
    passwordEnv: 'EXAMPLEBROKERAGE_PASSWORD',
  },

  login: {
    // Iframe login: form is inside a third-party auth iframe
    // After login submission, the iframe "frame-busts" — navigates the parent page
    // to the MFA flow. The browser-reader detects the detached frame automatically.
    iframePattern: 'auth-gateway.example.com',      // Substring match on iframe src URL
    iframeSelector: 'iframe[src*="auth-gateway"]',   // CSS selector for the iframe element
    usernameSelector: '#loginIdInput',
    passwordSelector: '#passwordInput',
    submitSelector: '#btnLogin',
    postLoginWaitMs: 8000,  // Brokerage SPAs often take longer to load after MFA
    loggedInPatterns: ['Account Summary', 'Total Value', 'Positions', 'Day Change'],
  },

  mfa: {
    sms: true,
    push: true,
    smsPatterns: ['Text me', 'security code', 'send you a security code'],
    pushPatterns: ['Send a mobile notification', 'Confirm Your Identity', 'verify your identity'],
    // Click the SMS method tile to start SMS flow
    mfaInitiationSelector: '#otp_sms',
    // Multi-step MFA: after initiation, a phone selection modal may appear.
    // mfaSteps handles intermediate actions before the code input shows up.
    // Each step: { action: 'click'|'waitFor'|'check', selector, first?, timeout?, waitAfter? }
    mfaSteps: [
      { action: 'click', selector: 'input[name="sameInputGroup"]', first: true, waitAfter: 500 },
      { action: 'click', selector: '#btnContinue' },
      { action: 'waitFor', selector: '#securityCode', timeout: 15000 },
    ],
    codeInputSelectors: ['#securityCode'],
    codeSubmitSelector: '#continueButton',
    trustDevicePatterns: ['Trust this device and skip this step in the future'],
  },

  // Transaction History — Pattern A (Central Dialog) with shadow DOM navigation
  // Shadow DOM: post-login navigation is inside web components (e.g., <responsive-meganav>).
  // The explorer can't annotate shadow DOM elements — discover selectors by:
  //   1. evaluate() to find shadow hosts: document.querySelector('responsive-meganav').shadowRoot.querySelectorAll('a')
  //   2. Or use page.locator('text=Transaction History') which pierces shadow DOM automatically
  //
  // NOTE: This template uses Pattern A (runCentralDialog). The export button on the
  // Transaction History page opens a dialog/modal where you select account + format + dates,
  // then click a submit button to download. Pattern A iterates accounts within that dialog.
  // If the bank's export is a single-click download with no dialog, use Pattern E instead.
  transactions: {
    // Entry point: button that opens the download dialog (or navigates to the download page).
    // Pattern A clicks this to reveal account/format/date selectors.
    // If the export page is reached via shadow DOM navigation, navigate there first
    // (e.g., via a beforeTask hook or custom navigateToTransactions in a Pattern E config),
    // then this selector targets the "Export" or "Download" button on that page.
    downloadButtonSelector: '#history-header-utility-bar-export-button',

    // Account selector — dropdown with all accounts
    accountDropdownButton: '#account-selector',

    // File format: export modal has format choices (CSV, JSON, XML).
    // If CSV is selected by default, provide fileTypeDropdownButton: null or omit it.
    // If a custom selection flow is needed (e.g., radio buttons), use selectFileFormat instead.
    // fileTypeDropdownButton: '#format-selector',
    // fileTypeLabel: 'CSV',

    // Date range: use activityDropdownButton if the dialog has a dropdown (e.g., "All transactions"),
    // or fromDateSelector/toDateSelector for direct date inputs,
    // or fillDateInputs for readonly date inputs that need JS value setting.
    // activityDropdownButton: '#activity-dropdown',
    // allTransactionsLabel: 'All transactions',

    // Submit button — clicks to trigger the CSV download after account/format/dates are set
    downloadSubmitSelector: 'button:has-text("Export")',

    // CSV columns (brokerage): Date, Action, Symbol, Description, Quantity, Price, Fees & Comm, Amount
  },

  // Statement balances — brokerage/IRA accounts have monthly PDF statements
  // Navigate via shadow DOM: page.locator('text=Statements & Tax Forms')
  // Same account selector as transactions, same date range dropdown
  // Statements page has document type filter chips (Statements, Tax Forms, etc.)
  // PDF download via [aria-label="Click to Download PDF"] buttons
  statementBalances: {
    statementsNavSelector: 'text=Statements & Tax Forms',

    // Brokerage accounts — monthly statements with account value
    brokerage: {
      source: 'pdf',
      openingBalancePattern: 'Beginning Account Value',
      closingBalancePattern: 'Ending Account Value',
      beforeDownloads: async (page, accountId) => {
        // Navigate to Statements & Tax Forms via shadow DOM
        await page.locator('text=Statements & Tax Forms').first().click({ timeout: 10000 });
        await page.waitForTimeout(3000);
        // Activate Statements filter chip
        await page.locator('#chips-wrapper-chip-aria-statements-chip').click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(1000);
        // Select account from dropdown — match by last-4
        await page.locator('#account-selector').click({ timeout: 5000 });
        await page.waitForTimeout(1000);
        const options = await page.locator('[id^="account-selector-header-0-account-"]').all();
        for (const opt of options) {
          const text = await opt.textContent();
          const last4 = accountId.split('-').pop();
          if (text.includes(last4)) {
            await opt.click();
            break;
          }
        }
        await page.waitForTimeout(2000);
      },
      download: async (page, accountId, rowIdx) => {
        const pdfButtons = page.locator('[aria-label="Click to Download PDF"]');
        const [dl] = await Promise.all([
          page.waitForEvent('download', { timeout: 15000 }),
          pdfButtons.nth(rowIdx).click({ timeout: 5000 }),
        ]);
        return dl;
      },
    },

    // Retirement/IRA accounts — same statement format and download flow as brokerage
    retirement: {
      source: 'pdf',
      openingBalancePattern: 'Beginning Account Value',
      closingBalancePattern: 'Ending Account Value',
      beforeDownloads: async (page, accountId) => {
        await page.locator('text=Statements & Tax Forms').first().click({ timeout: 10000 });
        await page.waitForTimeout(3000);
        await page.locator('#chips-wrapper-chip-aria-statements-chip').click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(1000);
        await page.locator('#account-selector').click({ timeout: 5000 });
        await page.waitForTimeout(1000);
        const options = await page.locator('[id^="account-selector-header-0-account-"]').all();
        for (const opt of options) {
          const text = await opt.textContent();
          const last4 = accountId.split('-').pop();
          if (text.includes(last4)) {
            await opt.click();
            break;
          }
        }
        await page.waitForTimeout(2000);
      },
      download: async (page, accountId, rowIdx) => {
        const pdfButtons = page.locator('[aria-label="Click to Download PDF"]');
        const [dl] = await Promise.all([
          page.waitForEvent('download', { timeout: 15000 }),
          pdfButtons.nth(rowIdx).click({ timeout: 5000 }),
        ]);
        return dl;
      },
    },
  },

  // Populated by /learn-institution — matched by last-4 digits
  accounts: [],

  extraction: async (page, accountList) => {
    const pageText = await page.evaluate(() => document.body.innerText);
    if (pageText.length < 100) {
      throw new Error('Dashboard page text too short — page may not have loaded');
    }
    return {
      balances: [],
      transactions: [],
      holdings: [],
      pendingExtraction: { balanceText: pageText.substring(0, 8000) },
    };
  },
};
