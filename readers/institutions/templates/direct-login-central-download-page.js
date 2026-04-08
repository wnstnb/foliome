/**
 * Template: Direct Login + Central Download Page (Pattern A variant)
 *
 * Login: Direct on main page (no iframe). Single-step with username + password.
 * MFA: SMS — phone number selection page appears after login. Requires evaluate-based
 *   JS click (standard Playwright click triggers logout on some banks). Uses mfaSteps
 *   with `evaluateClick` action.
 * Transactions: Separate download PAGE (not a dialog overlay). Navigate from account
 *   detail page. Account combobox dropdown + readonly date inputs + radio file format.
 *   CSV is headerless — column names must be provided manually via `csvColumns`.
 * Interstitials: Post-login prompts (contact review, enrollment) — dismiss with
 *   secondary button.
 *
 * Use this template when:
 *   - Login form is directly on the page (no iframe)
 *   - MFA phone selection buttons cause logout when clicked via Playwright (use evaluateClick)
 *   - Transaction download is on a SEPARATE PAGE (not a modal/dialog on the account page)
 *   - Date inputs are `readonly` and require JS value setting with native event dispatch
 *   - File format uses radio buttons instead of a dropdown
 *   - Downloaded CSV has no header row
 *
 * Key differences from Pattern A (Central Dialog):
 *   - Download opens a full page, not a dialog overlay
 *   - Uses `postNavigateWaitMs` (longer wait for page navigation vs dialog open)
 *   - `selectFileFormat` function for radio buttons (vs `fileTypeDropdownButton`)
 *   - `fillDateInputs` function for readonly inputs (vs `fromDateSelector`/`toDateSelector`)
 *   - `csvColumns` for headerless CSV (vs parsing first line as header)
 */

module.exports = {
  institution: 'example-bank',  // Replace with your institution slug
  entryUrl: 'https://www.example.com/auth/login',
  dashboardUrl: 'https://www.example.com/accounts/home',

  // Post-login interstitial dismiss buttons
  popupDismissSelectors: [
    'button:has-text("Remind me later")',
    '[data-testid="button-secondary"]',
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
    usernameSelector: '#j_username',
    passwordSelector: '#j_password',
    submitSelector: '[data-testid="signon-button"]',
    postLoginWaitMs: 8000,
    loggedInPatterns: ['account summary', 'available balance', 'checking', 'savings'],
    interstitials: [
      {
        urlPattern: 'contactinformation',  // URL substring that identifies the interstitial
        action: 'dismiss',
        dismissSelector: '[data-testid="button-secondary"]',  // "Remind me later" / "Skip"
      },
    ],
  },

  mfa: {
    sms: true,
    email: false,
    push: false,
    bankEmailSender: null,
    bankEmailSubject: null,
    smsPatterns: ['make sure it\'s you', 'one-time code', 'verify your identity', 'enter code'],
    emailPatterns: [],
    pushPatterns: [],
    // No single initiation button — phone selection page appears after login.
    // mfaSteps handles the multi-step flow: select phone → wait → code input appears.
    mfaInitiationSelector: null,
    mfaSteps: [
      {
        // evaluateClick: use JS document.querySelector().click() instead of Playwright click.
        // Some banks log out when Playwright dispatches a trusted click on MFA buttons —
        // likely due to event listeners that detect automated interaction on the MFA modal.
        // JS evaluate click bypasses this by firing an untrusted click from page context.
        selector: 'button:has-text("Mobile")',  // Playwright locator (for logging)
        action: 'evaluateClick',
        evaluateSelector: 'button.Button__button___Jo8E3:not([data-testid])',  // CSS selector for querySelector
        waitAfter: 3000,
      },
    ],
    codeInputSelectors: ['#otp'],
    codeSubmitSelector: 'button:has-text("Continue")',
    trustDevicePatterns: [],
  },

  transactions: {
    // Central download PAGE — not a dialog on the current page.
    // Navigated from account detail page via a link/button that opens a new page.
    // The page has its own account dropdown, date range, format selection, and download button.
    downloadButtonSelector: '[data-testid="download-account-activity-link"]',

    // Longer wait since this navigates to a new page (not opening a dialog)
    postNavigateWaitMs: 5000,

    // Account dropdown: custom combobox with role="combobox" and role="option" items.
    // getDropdownOptions() and selectDropdownOption() handle this via [role="option"] query.
    accountDropdownButton: '[role="combobox"][data-testid="control"]',

    // File format: radio button, not a dropdown.
    // selectFileFormat replaces the fileTypeDropdownButton pattern.
    // Check aria-checked to avoid re-clicking if already selected.
    selectFileFormat: async (page) => {
      const radio = page.locator('[data-testid="radio-fileFormat-commaDelimited"]');
      if (await radio.getAttribute('aria-checked') !== 'true') {
        await radio.click();
        await page.waitForTimeout(500);
      }
    },

    // Date inputs: readonly attribute prevents Playwright fill().
    // fillDateInputs replaces the fromDateSelector/toDateSelector pattern.
    // Must: remove readonly → set value via native setter → dispatch input+change events.
    // The native setter trick is needed because React/Angular intercept standard assignment.
    fillDateInputs: async (page, fromDate, toDate) => {
      await page.evaluate(({ from, to }) => {
        function setReadonlyInput(selector, value) {
          const input = document.querySelector(selector);
          if (!input) return;
          input.removeAttribute('readonly');
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          ).set;
          nativeInputValueSetter.call(input, value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        setReadonlyInput('#fromDate', from);
        setReadonlyInput('#toDate', to);
      }, { from: fromDate, to: toDate });
      await page.waitForTimeout(500);
    },

    // Maximum history available (used for --all mode to calculate from date)
    maxHistoryMonths: 18,

    // Download button — dynamic ID, stable data-testid
    downloadSubmitSelector: '[data-testid="download-button"]',

    // Headerless CSV: bank CSV has no header row.
    // Provide column names manually — parseCSV uses these instead of reading line 0 as header.
    csvColumns: ['Date', 'Amount', 'Star', 'Check', 'Description'],
  },

  // Statement balances — Pattern S-A: PDF statements
  // Navigate to statements page via "View Statements" on account detail page.
  // PDF download hooks would go here (beforeDownloads, download, afterDownloads).
  statementBalances: {
    statementsNavSelector: 'button:has-text("View Statements")',
    source: 'pdf',
    checking: { source: 'pdf' },
    savings: { source: 'pdf' },
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
