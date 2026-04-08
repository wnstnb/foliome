/**
 * Template: Direct Login + Brokerage/Retirement Account
 *
 * Login: Direct on main page (no iframe). Single-step.
 *   Cookie consent banner (OneTrust) must be dismissed before login.
 * MFA: SMS — requires clicking an initiation button to send the code,
 *   then entering code in a dedicated OTP input field.
 * Transactions: Not yet configured — retirement/brokerage accounts often have
 *   a "Transaction History" page with time period selectors. May also have
 *   Statements page with downloadable PDFs.
 *
 * Use this template when:
 *   - The institution is a brokerage, retirement plan, or 401(k) provider
 *   - Login has a cookie consent banner (OneTrust, CookieBot, etc.)
 *   - MFA requires an explicit "send code" button click
 *   - Transaction download needs further exploration (common for retirement accounts)
 */

module.exports = {
  institution: 'example-bank',  // Replace with your institution slug
  entryUrl: 'https://retirement.example.com/',
  dashboardUrl: 'https://services.example.com/mybenefits/navigation',

  security: {
    expectedDomain: 'retirement.example.com',
    requireHttps: true,
  },

  credentials: {
    usernameEnv: 'EXAMPLEBANK_USERNAME',
    passwordEnv: 'EXAMPLEBANK_PASSWORD',
  },

  login: {
    iframePattern: null,
    iframeSelector: null,
    usernameSelector: '#dom-username-input',
    passwordSelector: '#dom-pswd-input',
    submitSelector: '#dom-login-button',
    multiStep: false,
    postLoginWaitMs: 5000,
    loggedInPatterns: ['your portfolio', 'accounts & benefits', '401(k)'],
  },

  mfa: {
    sms: true,
    email: false,
    push: false,
    bankEmailSender: null,
    bankEmailSubject: null,
    smsPatterns: ['text me the code', 'call me with the code', 'send a temporary code', 'verification code'],
    emailPatterns: [],
    pushPatterns: [],
    // Click this button to initiate SMS delivery
    mfaInitiationSelector: '#dom-channel-list-primary-button',
    codeInputSelectors: [
      '#dom-otp-code-input',
      'input[type="text"]',
    ],
    codeSubmitSelector: 'button:has-text("Submit")',
    trustDevicePatterns: [],
  },

  // Transaction download not yet configured for this pattern.
  // Retirement/brokerage accounts commonly have:
  //   - Transaction History page with time period selector
  //   - Statements page with quarterly/annual PDFs
  // Run /learn-institution to explore and configure.
  transactions: null,

  // Statement balances — determine pattern during /learn-institution Q10-Q15
  // Retirement/brokerage accounts commonly have:
  //   - S-B on-demand: Statements page with time period selector (Monthly/Quarterly/YTD)
  //   - S-D: Not available (balance = NAV × shares, changes daily)
  // Use the interactive explorer to check the Statements page for balance data.
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
