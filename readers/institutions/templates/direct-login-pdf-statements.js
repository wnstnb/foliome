/**
 * Template: Direct Login + PDF Statement Download (Pattern C)
 *
 * Login: Direct on main page (no iframe). Single-step.
 * MFA: None observed (session may persist via Chrome profile).
 * Transactions: Navigate to Statements page, select account from native <select>,
 *   download per-month PDF statements. PDFs parsed by LiteParse, then the agent
 *   extracts structured transactions from the text.
 *
 * Use this template when:
 *   - The bank provides PDF statements (not CSV)
 *   - Statements page has a native account dropdown
 *   - Each month has its own download button
 */

module.exports = {
  institution: 'example-bank',  // Replace with your institution slug
  entryUrl: 'https://www.example.com/index.html',
  dashboardUrl: 'https://onlinebanking.example.com/dashboard',

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
    usernameSelector: '#input_personal-id',
    passwordSelector: '#input_password',
    submitSelector: '#login-button-continue',
    multiStep: false,
    postLoginWaitMs: 8000,
    loggedInPatterns: ['welcome back', 'checking and savings', 'dashboard'],
  },

  mfa: {
    sms: false,
    email: false,
    push: false,
    bankEmailSender: null,
    bankEmailSubject: null,
    smsPatterns: [],
    emailPatterns: [],
    pushPatterns: [],
    codeInputSelectors: [],
    codeSubmitSelector: null,
    trustDevicePatterns: [],
  },

  transactions: {
    // Pattern C: PDF statements with per-account native dropdown
    // Navigate to Statements page → select account → download per-month PDFs
    // PDFs → LiteParse → raw text → agent extraction → structured transactions
    pdfBased: true,
    statementsUrl: 'https://onlinebanking.example.com/statements',
    statementsNavSelector: 'button:has-text("Statements")',
    // Native <select> for account selection
    accountDropdownSelector: '#select_accountsList',
    // Download buttons with aria-label for each month
    downloadButtonSelector: 'button[aria-label*="Download"]',
  },

  // Statement balances — Pattern S-A: PDF statements (same PDFs used for transactions)
  // Checking PDFs typically have: "Beginning Balance" / "Ending Balance"
  // Mortgage PDFs typically have: "Principal Balance (Not a Payoff Amount)"
  // Parse balance fields from the same PDFs downloaded for transactions.
  // IMPORTANT for SPA sites: if multiple accounts use accordion-based download menus,
  // purge stale dropdown DOM elements (el.remove()) between accounts to prevent
  // Playwright strict mode violations from duplicate IDs.
  statementBalances: {
    checking: {
      source: 'pdf',
      openingBalancePattern: 'Beginning Balance',
      closingBalancePattern: 'Ending Balance',
    },
    mortgage: {
      source: 'pdf',
      closingBalancePattern: 'Principal Balance',
      signConvention: 'negative', // liability — store as negative
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
