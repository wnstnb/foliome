/**
 * Template: Multi-Step Login + WebAuthn Bypass + PDF Statements (Pattern C)
 *
 * Login: Adaptive single/multi-step — shows single-step on return visits (cached session),
 *   multi-step on first visit (email → Next → password → Submit).
 *   Passkey enrollment interstitial after login — handled two ways:
 *     1. CDP virtual authenticator absorbs the OS passkey dialog (disableWebAuthn: true)
 *        — activated AFTER login+MFA completes to avoid interfering with device-based 2FA
 *     2. Interstitial skip navigates to dashboard if enrollment URL is detected
 * MFA: SMS and email. No push.
 * Transactions: PDF statements via yearly ZIP downloads. Each year has a "Download all"
 *   button → ZIP of monthly PDFs → unzip → LiteParse → agent extraction.
 *
 * Use this template when:
 *   - The bank shows passkey/WebAuthn enrollment that blocks automation
 *   - Login is adaptive (single-step on return, multi-step on first visit)
 *   - Transaction download is yearly ZIPs of PDF statements
 *   - The bank has custom cookie banner selectors outside standard consent frameworks
 */

module.exports = {
  institution: 'example-bank',  // Replace with your institution slug
  entryUrl: 'https://www.example.com/signin',
  dashboardUrl: 'https://www.example.com/myaccount/summary',

  // Custom cookie banner selectors (outside standard consent frameworks)
  popupDismissSelectors: [
    '#gdprCookieBanner button:has-text("Accept")',
    'button[id*="cookie"]:has-text("Accept")',
    '#ccpaCookieBanner button:has-text("Accept")',
    'button:has-text("Accept Cookies")',
  ],

  security: {
    expectedDomain: 'www.example.com',
    requireHttps: true,
  },

  credentials: {
    usernameEnv: 'EXAMPLEBANK_USERNAME',
    passwordEnv: 'EXAMPLEBANK_PASSWORD',
  },

  login: {
    iframePattern: null,
    iframeSelector: null,
    // Adaptive: shows single-step on return visits, multi-step on first visit.
    // browser-reader handles both: if password is visible → single-step, else multi-step.
    disableWebAuthn: true,  // Absorbs OS-level passkey enrollment dialog (activated post-auth, safe with MFA)
    usernameSelector: '#email',
    passwordSelector: '#password',
    submitSelector: '#btnLogin',
    multiStep: true,
    nextButtonSelector: '#btnNext',
    postLoginWaitMs: 5000,
    loggedInPatterns: ['summary', 'available balance', 'recent activity', 'wallet'],
    // Post-login interstitial: passkey enrollment page
    // Skip by navigating directly to dashboard
    interstitials: [
      {
        urlPattern: 'activate-web-authn',
        action: 'skip',
        targetUrl: 'https://www.example.com/myaccount/summary',
      },
    ],
  },

  mfa: {
    sms: true,
    email: true,
    push: false,
    bankEmailSender: null,
    bankEmailSubject: null,
    smsPatterns: ['sent a code', 'text message', 'we sent', 'enter the code', 'security code', 'one-time code'],
    emailPatterns: ['check your email', 'emailed', 'sent to your email', 'verification email'],
    pushPatterns: [],
    codeInputSelectors: [
      'input[type="tel"]',
      'input[type="text"]',
      'input[id*="otp"]',
      'input[id*="code"]',
    ],
    codeSubmitSelector: 'button[type="submit"]',
    trustDevicePatterns: ['remember this device', 'trust this device'],
  },

  transactions: {
    // Pattern C: PDF statements via yearly ZIP downloads
    // Navigate to statements page → "Download all" per year → ZIP → unzip → LiteParse → agent
    pdfBased: true,
    statementsUrl: 'https://www.example.com/myaccount/statements/monthly',
    // Each year has a "Download all" button → ZIP of monthly PDFs
    // For "all" mode: download each year's ZIP (capped at 2 years)
    // For incremental: download just current year's ZIP
  },

  // Statement balances — Pattern S-B: HTML statement list
  // Navigate: Wallet → account → "See statements"
  // Page shows all statement periods with closing balances inline.
  // No PDF parsing needed for balances — data is in the page text.
  // PDF statements at /statements/monthly do NOT contain balance summaries
  // (only transactions). The credit card statements page has the balances.
  statementBalances: {
    credit: {
      source: 'html-statements-page',
      closingBalanceLabel: 'Balance',
      periodFormat: 'Mon DD - Mon DD',
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
