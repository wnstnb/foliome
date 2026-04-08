/**
 * Template: Iframe Multi-Step Login + Export Modal with Calendar (Pattern D)
 *
 * Login: Landing page → click "Sign In" → login form appears in iframe.
 *   Multi-step: email → Continue → method selection ("Continue with Password") →
 *   password → Continue. Device code MFA (6 individual digit inputs).
 * MFA: Device code — 6 separate input[type="tel"] fields, auto-advances.
 *   No submit button — auto-submits after last digit.
 * Transactions: Export modal on statements page with calendar date picker.
 *   Navigate months with prev arrow, click day to select. Export via evaluate()
 *   to bypass backdrop overlays.
 *
 * Use this template when:
 *   - Login requires clicking "Sign In" on a marketing/landing page first
 *   - Login form is in an iframe and has a method selection step
 *   - MFA uses individual digit input fields (not a single text input)
 *   - Transaction export uses a modal with a calendar date picker
 *   - The bank uses backdrop overlays that block normal click() calls
 */

module.exports = {
  institution: 'example-bank',  // Replace with your institution slug
  entryUrl: 'https://card.example.com',

  security: {
    expectedDomain: 'card.example.com',
    requireHttps: true,
  },

  credentials: {
    usernameEnv: 'EXAMPLEBANK_USERNAME',
    passwordEnv: 'EXAMPLEBANK_PASSWORD',
  },

  login: {
    // Landing page: click "Sign In" to reveal login form
    landingPage: true,
    signInSelector: 'text=Sign In',
    // Login form in iframe from auth domain
    iframePattern: 'auth.example.com',
    iframeSelector: 'iframe#auth-widget-iFrame',
    usernameSelector: '#account_name_text_field',
    passwordSelector: '#password_text_field',
    submitSelector: '#sign-in',
    // Multi-step: email → Continue → method selection → password → Continue
    multiStep: true,
    nextButtonSelector: '#sign-in',  // Same button serves as "Continue" for email step
    methodSelectionSelector: 'button:has-text("Continue with Password")',
    postLoginWaitMs: 5000,
    loggedInPatterns: ['card balance', 'manage autopay', 'upcoming payment'],
  },

  mfa: {
    sms: true,
    email: false,
    push: false,
    bankEmailSender: null,
    bankEmailSubject: null,
    smsPatterns: ['two-factor authentication', 'verification code sent to your', 'enter the code'],
    emailPatterns: [],
    pushPatterns: [],
    codeInputSelectors: [
      'input[type="tel"]',  // 6 individual digit inputs
    ],
    codeSubmitSelector: null,  // Auto-submits after all digits entered
    trustDevicePatterns: ['trust this browser'],
    // Individual digit inputs — type one digit at a time, auto-advances
    individualDigitInputs: true,
  },

  transactions: {
    // Pattern D: Export modal with calendar date picker
    // Navigate to statements page → open export modal → set date range via calendar
    exportModal: true,
    statementsLinkSelector: 'a:has-text("Statements")',
    exportLinkSelector: 'text=Export Transactions',
    // Calendar date picker for start date
    startDateClickSelector: '.flexible-row ui-button',
    prevMonthSelector: 'ui-button[aria-label="Previous month"]',
    monthYearTriggerSelector: '.month-year-trigger',
    dayButtonSelector: 'ui-button.day-button',
    monthsBack: 14,  // Navigate back ~14 months for full history
    // Export button — use page.evaluate() to bypass backdrop overlays
    exportButtonSelector: 'ui-button:has-text("Export")',
  },

  // Statement balances — Pattern S-B: HTML statement list
  // The Statements page shows all monthly periods with closing balances inline.
  // Navigate: left nav → Statements tab
  // Each row shows: month name, date range, and closing balance amount.
  // Also available: Balance Details modal on main page shows "[Month] Balance: $X".
  statementBalances: {
    credit: {
      source: 'html-statements-page',
      closingBalanceInline: true,  // balance shown next to each period
      periodFormat: 'Mon D - Mon D, YYYY',
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
