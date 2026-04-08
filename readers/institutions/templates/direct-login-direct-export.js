/**
 * Template: Direct Login + Direct Single-Button Export (Pattern E)
 *
 * Login: Direct on main page (no iframe). Single-step.
 *   Fields use name attributes (no IDs) — use input[name="..."] selectors.
 * MFA: SMS only — requires clicking an initiation button ("Text me") to trigger
 *   code delivery, then entering the code in a text input.
 * Transactions: Navigate to a transaction page, click a single export button.
 *   Simplest download pattern — no date picker, no account selector, no modal.
 *
 * Use this template when:
 *   - Login fields have no IDs (match by name or type attribute)
 *   - MFA requires clicking a button to initiate SMS delivery
 *   - Transaction export is a single button click (no configuration needed)
 */

module.exports = {
  institution: 'example-bank',  // Replace with your institution slug
  entryUrl: 'https://portal.example.com/login',
  dashboardUrl: 'https://portal.example.com/dashboard',

  security: {
    expectedDomain: 'portal.example.com',
    requireHttps: true,
  },

  credentials: {
    usernameEnv: 'EXAMPLEBANK_USERNAME',
    passwordEnv: 'EXAMPLEBANK_PASSWORD',
  },

  login: {
    iframePattern: null,
    iframeSelector: null,
    // Fields have no IDs — use name attribute
    usernameSelector: 'input[name="username"]',
    passwordSelector: 'input[name="password"]',
    submitSelector: 'button[type="submit"]',
    multiStep: false,
    postLoginWaitMs: 5000,
    loggedInPatterns: ['account balances', 'beneficiary', 'rate of return', 'transaction history'],
  },

  mfa: {
    sms: true,
    email: false,
    push: false,
    bankEmailSender: null,
    bankEmailSubject: null,
    smsPatterns: ['multi-factor authentication', 'text me', 'verification code', 'call me'],
    emailPatterns: [],
    pushPatterns: [],
    // Click this button to initiate SMS delivery (code isn't sent automatically)
    mfaInitiationSelector: 'button:has-text("Text me")',
    codeInputSelectors: [
      'input[type="text"]',
    ],
    codeSubmitSelector: 'button:has-text("Next")',
    trustDevicePatterns: [],
  },

  transactions: {
    // Pattern E: Direct export — navigate to page, click one button, CSV downloads
    directExport: true,
    navigationSelector: 'text=Transaction History',
    exportButtonSelector: 'button:has-text("Export Table")',
  },

  // Statement balances — determine pattern during /learn-institution Q10-Q15
  // Simple accounts (education 529, etc.) may not have statement closing balances.
  // If the CSV includes a Balance column, use Pattern S-E (csv-balance-column).
  // Otherwise, likely S-D (not available).
  statementBalances: null, // Set during /learn-institution

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
