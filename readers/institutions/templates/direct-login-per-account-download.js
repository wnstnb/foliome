/**
 * Template: Direct Login + Per-Account CSV Download (Pattern B)
 *
 * Login: Direct on main page (no iframe). Single-step with username + password fields.
 *   Bank may show promotional popups after login that need dismissing.
 * MFA: SMS, email, and push — all three supported.
 * Transactions: Navigate to each account page individually, click download, get CSV,
 *   return to dashboard. Uses custom dropdown components for time period selection.
 *
 * Use this template when:
 *   - Login form is directly on the page (no iframe)
 *   - Each account has its own page with a separate download button
 *   - The bank shows promotional modals/popups after login (configure popupDismissSelectors)
 */

module.exports = {
  institution: 'example-bank',  // Replace with your institution slug
  entryUrl: 'https://myaccounts.example.com',
  dashboardUrl: 'https://myaccounts.example.com/accountSummary',

  // Institution-specific popup selectors (promos, enrollment reminders, etc.)
  popupDismissSelectors: [
    'button:has-text("Dismiss for now")',
    'button:has-text("Not now")',
    'button:has-text("No thanks")',
  ],

  security: {
    expectedDomain: 'verified.example.com',  // May differ from entryUrl domain
    requireHttps: true,
  },

  credentials: {
    usernameEnv: 'EXAMPLEBANK_USERNAME',
    passwordEnv: 'EXAMPLEBANK_PASSWORD',
  },

  login: {
    iframePattern: null,
    iframeSelector: null,
    usernameSelector: '#usernameInputField',
    passwordSelector: '#pwInputField',
    submitSelector: 'button[type="submit"]:has-text("Sign in")',
    postLoginWaitMs: 5000,
    loggedInPatterns: ['account summary', 'available balance', 'recent transactions', 'your accounts'],
  },

  mfa: {
    sms: true,
    email: true,
    push: true,
    bankEmailSender: null,
    bankEmailSubject: null,
    smsPatterns: ['sent a code', 'text message', 'we sent', 'enter the code', 'verify your identity'],
    emailPatterns: ['sent to your email', 'check your email', 'emailed'],
    pushPatterns: ['push notification', 'confirm on your device', 'approve', 'verify using the app'],
    codeInputSelectors: [
      'input[type="tel"]',
      'input[type="text"]',
      'input[id*="otp"]',
      'input[id*="code"]',
    ],
    codeSubmitSelector: 'button[type="submit"]',
    trustDevicePatterns: ['remember this device', 'trust this device', 'don\'t ask again'],
  },

  transactions: {
    // Pattern B: Per-account download
    // Navigate to each account page individually, click download link, get CSV, go back.
    // If the bank uses custom dropdown components, use timePeriodOptions to map labels.
    // Some banks require clicking inside the modal to blur before the download button enables.
    perAccount: true,
    downloadLinkSelector: '#downloadStatementTransactions',
    timePeriodOptions: {
      all: 'Year-to-Date',
      last30: 'Last 30 Days',
      last60: 'Last 60 Days',
      last90: 'Last 90 Days',
      custom: 'Custom Date Range',
    },
    fromDateSelector: 'input[placeholder="mm/dd/yyyy"]:first-of-type',
    toDateSelector: 'input[placeholder="mm/dd/yyyy"]:last-of-type',
    downloadSubmitSelector: '#downloadTransactionsSubmitBtn',
    postDownloadDismiss: [
      'button[aria-label="Close"]',
      'button:has-text("×")',
      'button[class*="close"]',
    ],
    backButtonSelector: 'button[aria-label="Click here to go back"]',
  },

  // Statement balances — Pattern S-E: CSV balance column (if available)
  // If the downloaded CSVs include a running "Balance" column, month-end balances
  // can be derived from natural anchor transactions (e.g., "Monthly Interest Paid"
  // on the last day of each month). No separate statements page needed.
  // If no Balance column, check for a Statements page (Pattern S-A or S-B).
  statementBalances: {
    source: 'csv-balance-column',  // or 'pdf' or 'html-statements-page'
    anchorDescription: 'Monthly Interest Paid',  // natural month-end anchor
    anchorDatePattern: 'last-day-of-month',
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
