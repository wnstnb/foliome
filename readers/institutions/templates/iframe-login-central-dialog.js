/**
 * Template: Iframe Login + Central Download Dialog (Pattern A)
 *
 * Login: Login form inside an iframe — browser-reader uses frameLocator for all
 *   credential fields. Single-step (username + password visible simultaneously).
 * MFA: SMS, email, and push — all three supported. Code entered in single input field.
 * Transactions: Central download dialog with account dropdown — cycle through accounts
 *   without leaving the page. Uses custom dropdown components (not native <select>).
 *
 * Use this template when:
 *   - The bank's login form is inside an iframe (check DevTools → Elements for <iframe>)
 *   - Transaction download uses a single dialog with an account selector dropdown
 *   - The bank uses custom UI components for dropdowns (shadow DOM, web components)
 */

module.exports = {
  institution: 'example-bank',  // Replace with your institution slug
  entryUrl: 'https://secure.example.com',

  security: {
    expectedDomain: 'secure.example.com',
    requireHttps: true,
  },

  credentials: {
    usernameEnv: 'EXAMPLEBANK_USERNAME',  // Set in .env
    passwordEnv: 'EXAMPLEBANK_PASSWORD',  // Set in .env
  },

  login: {
    // Iframe login: the login form lives inside an iframe, not the main page
    iframePattern: '/auth/',           // Substring match on iframe src URL
    iframeSelector: 'iframe#logonbox', // CSS selector for the iframe element
    usernameSelector: 'input[name="username"]',
    passwordSelector: 'input[name="password"]',
    submitSelector: '#signin-button',
    postLoginWaitMs: 5000,
    loggedInPatterns: ['account summary', 'good morning', 'good afternoon', 'good evening'],
  },

  mfa: {
    sms: true,
    email: true,
    push: true,
    bankEmailSender: 'no-reply@alerts.example.com',  // For Gmail auto-poll
    bankEmailSubject: 'verification code',
    smsPatterns: ['sent a code', 'check your phone', 'text message', 'we sent'],
    emailPatterns: ['sent to y', 'check your email', 'emailed you'],
    pushPatterns: ['confirm using our mobile app', 'push notification to your device', 'confirm your identity'],
    codeInputSelectors: [
      'input[type="tel"]',
      'input[name="otpcode"]',
      'input[id*="otp"]',
      'input[id*="code"]',
    ],
    codeSubmitSelector: 'button[type="submit"]',
    trustDevicePatterns: ['remember this device', 'trust this browser', 'don\'t ask again'],
  },

  transactions: {
    // Pattern A: Central download dialog
    // One dialog with an account dropdown — cycle through accounts without leaving the page.
    // Works with custom web component dropdowns (click button → role="option" list).
    downloadButtonSelector: '#download-activity-button',
    accountDropdownButton: '#select-account-selector',
    fileTypeDropdownButton: '#select-file-type',
    activityDropdownButton: '#select-activity-range',
    fileTypeLabel: 'Spreadsheet (Excel, CSV)',
    allTransactionsLabel: 'All transactions',
    dateRangeLabel: 'Choose a date range',
    fromDateSelector: 'input[placeholder="mm/dd/yyyy"]:first-of-type',
    toDateSelector: 'input[placeholder="mm/dd/yyyy"]:last-of-type',
    downloadSubmitSelector: 'button[aria-labelledby="download-label"]',
  },

  // Statement balances — per account type, as discovered by /learn-institution Q10-Q15
  // Each type with source 'pdf' provides download hooks for download-statements.js:
  //   beforeDownloads(page, accountId) — setup (expand section, select account)
  //   download(page, accountId, rowIdx) — download one PDF, return Playwright Download object
  //   afterDownloads(page, accountId) — cleanup (collapse section, purge stale DOM)
  // The generic wrapper handles navigation, iteration, file saving, and PDF parsing.
  statementBalances: {
    statementsUrl: 'https://secure.example.com/statements',
    // statementsNavSelector: 'text=Statements & documents',  // alternative: click nav element
    pageReadyPatterns: ['Account Name 1', 'Account Name 2'],  // wait for these before downloading
    errorRetry: { text: "isn't working right now", selector: 'text=Try again' },  // optional

    checking: {
      source: 'pdf',
      openingBalancePattern: 'Beginning Balance',  // exact text from parsed PDF
      closingBalancePattern: 'Ending Balance',
      // Agent writes these during Q13 — the Playwright click sequence discovered via explorer
      beforeDownloads: async (page, accountId) => {
        // Example: expand an accordion section, click an account tab, etc.
        await page.locator('#account-section-checking').click({ timeout: 5000 });
        await page.waitForTimeout(2000);
      },
      download: async (page, accountId, rowIdx) => {
        // Example: click the download link for row N, return the Download object
        const link = page.locator(`#statement-download-row-${rowIdx}`);
        const [dl] = await Promise.all([
          page.waitForEvent('download', { timeout: 15000 }),
          link.click({ timeout: 5000 }),
        ]);
        return dl;
      },
      afterDownloads: async (page, accountId) => {
        // Example: collapse section, purge stale DOM elements
      },
    },

    credit: {
      currentSource: 'dashboard',  // "Last statement balance" label on dashboard
      dashboardLabels: {
        'example-card-1': 'Last statement balance',
      },
      historicalSource: 'pdf',     // older periods from PDF statements
      closingBalancePattern: 'New Balance',
      // download hooks — accountId distinguishes between multiple cards
      download: async (page, accountId, rowIdx) => {
        // Agent maps accountId to the correct section/tab/accordion
        const link = page.locator(`#card-statement-${rowIdx}`);
        const [dl] = await Promise.all([
          page.waitForEvent('download', { timeout: 15000 }),
          link.click({ timeout: 5000 }),
        ]);
        return dl;
      },
    },

    brokerage: { source: 'not-available' },
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
