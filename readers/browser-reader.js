/**
 * Browser Reader Primitive
 *
 * Config-driven Playwright automation for bank login + data extraction.
 * Each institution provides a config object with selectors and an extraction function.
 * Credentials resolved via Bitwarden vault (preferred) or .env (fallback).
 */

require('@dotenvx/dotenvx').config({ path: require('path').join(__dirname, '..', '.env') });
const { chromium } = require('playwright');
const { getCredentials } = require('../scripts/credentials');
const fs = require('fs');
const path = require('path');
const { runSecurityGate } = require('../sync-engine/security-gate');
const { extractSanitizedText, extractSanitizedTextWithFrames } = require('./sanitize-text');

const PROFILE_DIR = path.join(__dirname, '..', 'data', 'chrome-profile');
const OUTPUT_DIR = path.join(__dirname, '..', 'data', 'sync-output');

// Ensure directories exist
if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

/**
 * @typedef {Object} MfaSignal
 * @property {'sms'|'email'|'push'} type
 * @property {string} message - Human-readable prompt for the user
 * @property {string} [emailSender] - For email MFA: sender to poll for
 * @property {string} [emailSubject] - For email MFA: subject keyword
 */

/**
 * @typedef {Object} ReaderSession
 * @property {function(string): Promise<void>} enterMfaCode - Enter MFA code and submit
 * @property {function(): Promise<boolean>} checkMfaCleared - Check if push MFA cleared
 * @property {function(): Promise<void>} trustDevice - Click "remember this device" if shown
 * @property {function(): Promise<Object>} extract - Run the extraction function
 * @property {function(): Promise<void>} close - Close the browser page (keeps profile)
 */

class BrowserReader {
  constructor(config) {
    this.config = config;
    this.context = null;
    this.page = null;
    this.loginFrame = null;
  }

  /**
   * Launch browser with persistent profile and navigate to the bank.
   * Returns the page state: 'logged-in', 'login', or 'mfa'.
   */
  async start() {
    const profilePath = path.join(PROFILE_DIR, this.config.institution);
    if (!fs.existsSync(profilePath)) fs.mkdirSync(profilePath, { recursive: true });

    const launchOptions = {
      headless: false,
      viewport: { width: 1280, height: 720 },
      args: ['--disable-blink-features=AutomationControlled'],
    };

    // Prefer system Chrome over Playwright's Chromium — real browser binary
    // defeats bot detection (captchas, PayPal, etc.). Uses executablePath (not
    // channel) to avoid Playwright's "Chrome for Testing" which crashes on older
    // macOS and still has automation fingerprints.
    const chromePaths = {
      darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      win32: [
        process.env.PROGRAMFILES + '\\Google\\Chrome\\Application\\chrome.exe',
        process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
        process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
      ],
      linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'],
    };

    const platform = process.platform;
    let chromePath = null;
    if (platform === 'darwin') {
      if (fs.existsSync(chromePaths.darwin)) chromePath = chromePaths.darwin;
    } else {
      const candidates = chromePaths[platform] || [];
      for (const p of candidates) {
        if (p && fs.existsSync(p)) { chromePath = p; break; }
      }
    }

    if (chromePath) {
      launchOptions.executablePath = chromePath;
      console.log(`[${this.config.institution}] Using system Chrome: ${chromePath}`);
    }

    this.context = await chromium.launchPersistentContext(profilePath, launchOptions);

    // Stealth patches — hide automation signals before any page code runs.
    // Prevents captchas from PayPal, Chase, and other bot-detection-heavy sites.
    await this.context.addInitScript(() => {
      // 1. navigator.webdriver = false (the #1 bot detection signal)
      Object.defineProperty(navigator, 'webdriver', { get: () => false });

      // 2. Hide Playwright's runtime markers
      delete window.__playwright;
      delete window.__pw_manual;

      // 3. Fake plugins array (real Chrome has at least 3-5 plugins)
      Object.defineProperty(navigator, 'plugins', {
        get: () => [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
        ],
      });

      // 4. Fake languages (automation browsers often have empty arrays)
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

      // 5. Chrome runtime object (present in real Chrome, missing in Playwright)
      if (!window.chrome) window.chrome = {};
      if (!window.chrome.runtime) window.chrome.runtime = { id: undefined };

      // 6. Permissions API — real Chrome returns 'prompt', automation returns 'denied'
      const originalQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
      if (originalQuery) {
        window.navigator.permissions.query = (params) =>
          params.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery(params);
      }
    });

    this.page = this.context.pages()[0] || await this.context.newPage();

    // WebAuthn virtual authenticator is deferred to post-authentication.
    // Activating it during login/MFA interferes with device-based 2FA flows
    // (e.g., Apple ID push codes get cancelled when the virtual authenticator
    // responds to WebAuthn probes). Passkey enrollment interstitials only appear
    // after authentication, so deferring is safe for all institutions.
    // Call activateWebAuthnGuard() after login+MFA completes.

    console.log(`[${this.config.institution}] Navigating to ${this.config.entryUrl}`);
    await this.page.goto(this.config.entryUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Security gate
    const gate = runSecurityGate(this.page.url(), this.config.security);
    if (!gate.passed) {
      throw new Error(`Security gate failed: ${gate.reason}`);
    }
    console.log(`[${this.config.institution}] Security gate passed`);

    // Wait for page to settle
    await this.page.waitForTimeout(3000);

    // Dismiss cookie banners and popups BEFORE attempting login
    await this.dismissPopups();

    // Landing page login: some banks show a marketing page first — click "Sign In" to reveal the form
    if (this.config.login.landingPage) {
      const signInSel = this.config.login.signInSelector || 'text=Sign In';
      console.log(`[${this.config.institution}] Landing page — clicking Sign In...`);
      await this.page.locator(signInSel).first().click({ timeout: 10000 });
      await this.page.waitForTimeout(5000);
    }

    return this._detectState();
  }

  /**
   * Dismiss any modal pop-ups, promotional overlays, or interstitial dialogs.
   * Banks love showing ads, CreditWise promos, trusted contact reminders, etc.
   * Call this after login and before starting any task.
   */
  async dismissPopups() {
    // Tier 1: Known cookie consent framework IDs — always safe, globally unique
    const frameworkSelectors = [
      '#onetrust-accept-btn-handler',       // OneTrust
      '#onetrust-banner-sdk button#accept',  // OneTrust variant
      '#acceptAllButton',                    // Generic consent banner ID
      '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', // CookieBot
      '#truste-consent-button',             // TrustArc
      '#bannerDeclineButton',
      '#bannerCloseButton',
    ];

    // Tier 2: Text matching scoped to cookie/consent/banner containers only
    // These are safe because the container guarantees we're in a consent UI, not a bank action
    const scopedConsentSelectors = [
      '[class*="cookie"] button:has-text("Accept")',
      '[class*="consent"] button:has-text("Accept")',
      '[id*="cookie"] button:has-text("Accept")',
      '[id*="consent"] button:has-text("Accept")',
      '[class*="cookie-banner"] button',
      '[class*="gdpr"] button:has-text("Accept")',
      '[class*="privacy"] button:has-text("Accept")',
    ];

    // Tier 3: Modal/dialog-scoped dismissals — safe because modals are overlays, not main page actions
    const modalSelectors = [
      '[role="dialog"] button:has-text("Dismiss for now")',
      '[role="dialog"] button:has-text("Dismiss")',
      '[role="dialog"] button:has-text("No thanks")',
      '[role="dialog"] button:has-text("Not now")',
      '[role="dialog"] button:has-text("Maybe later")',
      '[role="dialog"] button:has-text("Close")',
      '[class*="modal"] button[class*="close"]',
      '[class*="dialog"] button[class*="close"]',
      'button[aria-label="Close dialog"]',
    ];

    // Tier 4: Institution-specific popup selectors from config
    const institutionSelectors = this.config.popupDismissSelectors || [];

    const dismissSelectors = [
      ...frameworkSelectors,
      ...scopedConsentSelectors,
      ...modalSelectors,
      ...institutionSelectors,
    ];

    let dismissed = 0;
    for (const sel of dismissSelectors) {
      try {
        const el = this.page.locator(sel).first();
        if (await el.isVisible({ timeout: 500 })) {
          await el.click({ timeout: 2000 });
          dismissed++;
          console.log(`[${this.config.institution}] Dismissed popup: ${sel}`);
          await this.page.waitForTimeout(1000);
        }
      } catch { /* not visible or not clickable */ }
    }

    if (dismissed > 0) {
      await this.page.waitForTimeout(1000);
    }

    return dismissed;
  }

  /**
   * Activate CDP virtual authenticator to absorb passkey enrollment dialogs.
   * Called AFTER login+MFA completes — never during authentication.
   * Passkey enrollment interstitials only appear post-auth, so deferring is safe.
   * During login/MFA, a virtual authenticator can interfere with device-based 2FA
   * (e.g., Apple ID cancels push codes when the authenticator responds to WebAuthn probes).
   */
  async activateWebAuthnGuard() {
    if (!this.config.login.disableWebAuthn) return;
    try {
      const cdp = await this.page.context().newCDPSession(this.page);
      await cdp.send('WebAuthn.enable');
      await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
      });
      await cdp.detach();
      console.log(`[${this.config.institution}] WebAuthn guard activated (post-auth)`);
    } catch (err) {
      console.log(`[${this.config.institution}] WebAuthn guard failed (non-fatal): ${err.message}`);
    }
  }

  /**
   * Detect whether we're logged in, at the login page, facing MFA, or in an unknown state.
   * @param {string} context — 'initial' (first load) or 'post-login' (after credentials submitted)
   */
  async _detectState(context = 'initial') {
    // Gather sanitized text from both main page and iframes (unwrapped for internal logic)
    let pageText = await extractSanitizedText(this.page, { unwrap: true });
    if (this.config.login.iframePattern) {
      for (const frame of this.page.frames()) {
        if (frame.url().includes(this.config.login.iframePattern)) {
          try {
            const frameText = await extractSanitizedText(frame, { unwrap: true });
            pageText += '\n' + frameText;
          } catch { /* frame may not be accessible */ }
        }
      }
    }
    const textLower = pageText.toLowerCase();

    // Check for MFA patterns first (may be in iframe text gathered above)
    const mfaSignal = this._detectMfa(textLower);
    if (mfaSignal) return { state: 'mfa', mfa: mfaSignal };

    // Check for login form — a visible password field is the strongest signal
    const hasPasswordField = await this.page.$('input[type="password"]:visible').then(el => !!el).catch(() => false);

    // Check if already logged in — dashboard content visible AND no actual login form
    // Use the password field (not text like "Sign in" which appears in nav/footer on dashboards)
    const { loggedInPatterns } = this.config.login;
    if (loggedInPatterns && loggedInPatterns.some(p => textLower.includes(p.toLowerCase())) && pageText.length > 300 && !hasPasswordField) {
      console.log(`[${this.config.institution}] Already logged in`);
      return { state: 'logged-in' };
    }

    if (hasPasswordField && !this.config.login.iframePattern) {
      this.loginFrame = null;
      return { state: 'login' };
    }

    // Check for login form in iframes — only if the iframe actually has a password field
    // (Chase's MFA page keeps the auth iframe in the DOM but without a password field)
    if (this.config.login.iframePattern) {
      const frames = this.page.frames();
      for (const frame of frames) {
        if (frame.url().includes(this.config.login.iframePattern)) {
          try {
            const hasIframePw = await frame.$('input[type="password"]');
            if (hasIframePw) {
              this.loginFrame = frame;
              console.log(`[${this.config.institution}] Found login iframe`);
              return { state: 'login' };
            }
          } catch { /* frame may not be accessible during navigation */ }
        }
      }
    }

    // Post-login: unrecognized page — try navigating to dashboard URL before giving up
    if (context === 'post-login' && pageText.length > 100) {
      if (this.config.dashboardUrl && !this._dashboardRecoveryAttempted) {
        this._dashboardRecoveryAttempted = true;
        console.log(`[${this.config.institution}] Unknown page state — attempting dashboard navigation recovery`);
        try {
          await this.page.goto(this.config.dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await this.page.waitForTimeout(3000);
          await this.dismissPopups();
          return this._detectState('post-login');
        } catch (err) {
          console.log(`[${this.config.institution}] Dashboard recovery failed: ${err.message}`);
        }
      }
      console.log(`[${this.config.institution}] Unknown page state (${pageText.length} chars) — adaptive bridge may handle`);
      return { state: 'unknown', pageText };
    }

    // Initial navigation: substantial content → probably logged in (cached session)
    if (pageText.length > 1000) {
      return { state: 'logged-in' };
    }

    // No password field, no MFA, no loggedInPatterns match, text is short.
    // If there's no login form on the page, don't assume it's a login page —
    // the SPA may still be rendering after a redirect (e.g., /login → /dashboard).
    // Wait for content to appear and re-check before defaulting.
    if (!hasPasswordField && !this._initialRetryAttempted) {
      this._initialRetryAttempted = true;
      console.log(`[${this.config.institution}] Page has no login form (${pageText.length} chars) — waiting for SPA to render`);
      await this.page.waitForTimeout(5000);
      return this._detectState(context);
    }

    return { state: 'login' };
  }

  /**
   * Detect MFA challenge from page text.
   * @returns {MfaSignal|null}
   */
  _detectMfa(textLower) {
    const { mfa } = this.config;
    if (!mfa) return null;

    if (mfa.sms && mfa.smsPatterns) {
      for (const pattern of mfa.smsPatterns) {
        if (textLower.includes(pattern.toLowerCase())) {
          return {
            type: 'sms',
            message: `${this.config.institution.toUpperCase()} MFA — enter the code sent to your phone`,
          };
        }
      }
    }

    if (mfa.email && mfa.emailPatterns) {
      for (const pattern of mfa.emailPatterns) {
        if (textLower.includes(pattern.toLowerCase())) {
          return {
            type: 'email',
            message: `${this.config.institution.toUpperCase()} MFA — checking email automatically...`,
            emailSender: mfa.bankEmailSender,
            emailSubject: mfa.bankEmailSubject,
          };
        }
      }
    }

    if (mfa.push && mfa.pushPatterns) {
      for (const pattern of mfa.pushPatterns) {
        if (textLower.includes(pattern.toLowerCase())) {
          return {
            type: 'push',
            message: `${this.config.institution.toUpperCase()} MFA — approve the push notification on your phone`,
          };
        }
      }
    }

    return null;
  }

  /**
   * Log in using credentials from Bitwarden vault or .env.
   * @returns {{ state: string, mfa?: MfaSignal }}
   */
  async login() {
    const { credentials, login } = this.config;

    const { username, password } = await getCredentials(this.config.institution, credentials);

    if (!username || !password) {
      throw new Error(`Missing credentials for ${this.config.institution}: not found in Bitwarden or .env (${credentials.usernameEnv} / ${credentials.passwordEnv})`);
    }

    // Use frameLocator for iframes — stays live across navigations unlike page.frames()
    let usernameLocator, passwordLocator, submitLocator;

    if (login.iframeSelector || login.iframePattern) {
      const iframeSel = login.iframeSelector || 'iframe#logonbox';
      console.log(`[${this.config.institution}] Using frameLocator: ${iframeSel}`);
      const frame = this.page.frameLocator(iframeSel);
      usernameLocator = frame.locator(login.usernameSelector);
      passwordLocator = frame.locator(login.passwordSelector);
      submitLocator = frame.locator(login.submitSelector);
    } else {
      usernameLocator = this.page.locator(login.usernameSelector);
      passwordLocator = this.page.locator(login.passwordSelector);
      submitLocator = this.page.locator(login.submitSelector);
    }

    // Wait for username field to be visible
    console.log(`[${this.config.institution}] Waiting for login form fields...`);
    await usernameLocator.waitFor({ state: 'visible', timeout: 15000 });

    // Check if password is already visible (adaptive: some banks show single-step on return visits)
    // NOTE: Some banks report password as vis:true in DOM even when hidden behind another view.
    // For banks with method selection, always treat as multi-step.
    const passwordAlreadyVisible = login.methodSelectionSelector
      ? false  // Force multi-step when method selection is configured
      : await passwordLocator.isVisible({ timeout: 1000 }).catch(() => false);

    if (login.multiStep && !passwordAlreadyVisible) {
      // Multi-step: fill username → click next → (optional method selection) → fill password → submit
      const frameTarget = (login.iframeSelector || login.iframePattern)
        ? this.page.frameLocator(login.iframeSelector || 'iframe')
        : null;
      const nextLocator = frameTarget
        ? frameTarget.locator(login.nextButtonSelector)
        : this.page.locator(login.nextButtonSelector);

      await usernameLocator.fill(username);
      console.log(`[${this.config.institution}] Step 1: entered username, clicking Next...`);
      await nextLocator.click();
      await this.page.waitForTimeout(3000);

      // Method selection: some banks show "Continue with Password" / "Sign in with iPhone"
      if (login.methodSelectionSelector) {
        const methodLocator = frameTarget
          ? frameTarget.locator(login.methodSelectionSelector)
          : this.page.locator(login.methodSelectionSelector);
        try {
          if (await methodLocator.isVisible({ timeout: 3000 })) {
            await methodLocator.click();
            console.log(`[${this.config.institution}] Clicked method selection`);
            await this.page.waitForTimeout(3000);
          }
        } catch { /* method selection not shown — password may appear directly */ }
      }

      await passwordLocator.waitFor({ state: 'visible', timeout: 10000 });
      await passwordLocator.fill(password);

      // Check "remember me" before submitting
      await this._checkRememberMe(login, frameTarget);

      console.log(`[${this.config.institution}] Step 2: entered password, clicking submit...`);
      await submitLocator.click();
    } else {
      // Single-step: fill both and submit
      await usernameLocator.fill(username);
      await passwordLocator.fill(password);

      // Check "remember me" / "remember login ID" before submitting
      await this._checkRememberMe(login, login.iframeSelector || login.iframePattern
        ? this.page.frameLocator(login.iframeSelector || 'iframe') : null);

      await submitLocator.click();
    }

    console.log(`[${this.config.institution}] Login submitted, waiting for response...`);

    // Wait for navigation or page change
    try {
      await this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch {
      // Navigation may not trigger if it's a SPA
    }

    // Check for interstitials IMMEDIATELY — some (like passkey enrollment)
    // trigger OS-level dialogs just by loading the page
    await this._handleInterstitials();

    await this.page.waitForTimeout(login.postLoginWaitMs || 5000);

    // Dismiss any post-login popups (promos, CreditWise, etc.) before detecting state
    await this.dismissPopups();

    return this._detectState('post-login');
  }

  /**
   * Handle post-login interstitial pages that block the dashboard.
   * Configured in login.interstitials array.
   */
  async _handleInterstitials() {
    const { login } = this.config;
    if (!login.interstitials || !login.interstitials.length) return;

    for (const interstitial of login.interstitials) {
      const url = this.page.url();
      if (!url.includes(interstitial.urlPattern)) continue;

      console.log(`[${this.config.institution}] Interstitial detected: ${interstitial.urlPattern}`);

      if (interstitial.action === 'skip') {
        // Skip the interstitial by navigating directly to the target URL
        // Used for optional enrollment pages (passkeys, promos) that don't need to be completed
        console.log(`[${this.config.institution}] Skipping interstitial — navigating to ${interstitial.targetUrl}`);
        await this.page.goto(interstitial.targetUrl, {
          waitUntil: 'domcontentloaded', timeout: 15000,
        }).catch(() => {});
        await this.page.waitForTimeout(3000);
      } else if (interstitial.action === 'dismiss') {
        try {
          await this.page.locator(interstitial.buttonSelector).click({ timeout: 5000 });
          await this.page.waitForTimeout(2000);
        } catch {}
      } else if (interstitial.action === 'navigate') {
        await this.page.goto(interstitial.targetUrl, {
          waitUntil: 'domcontentloaded', timeout: 15000,
        }).catch(() => {});
        await this.page.waitForTimeout(3000);
      }
    }
  }

  /**
   * Enter an MFA code and submit.
   */
  async enterMfaCode(code) {
    const { mfa, login } = this.config;

    // Determine where MFA inputs are — could be in an iframe, or the iframe may have
    // frame-busted (navigated the parent page) so MFA is now on the main page
    let target = this.page;
    let frameTarget = null;
    if (this.loginFrame) {
      try {
        // Test if the iframe is still alive
        await this.loginFrame.title();
        target = this.loginFrame;
        frameTarget = (login.iframeSelector || login.iframePattern)
          ? this.page.frameLocator(login.iframeSelector || 'iframe')
          : null;
      } catch {
        // Frame detached (frame-busted) — MFA is on the main page
        console.log(`[${this.config.institution}] Login iframe detached — MFA on main page`);
      }
    }

    // Check for individual digit inputs (6 separate input[type="tel"] fields)
    if (mfa.individualDigitInputs) {
      const digitInputs = frameTarget
        ? frameTarget.locator('input[type="tel"]:visible')
        : this.page.locator('input[type="tel"]:visible');
      const count = await digitInputs.count();

      if (count >= 4) {
        // Click first input then press each digit — press() triggers auto-advance
        // between fields in cross-origin iframes where type() may not
        await digitInputs.first().click();
        await this.page.waitForTimeout(200);
        for (const digit of code) {
          await this.page.keyboard.press(digit);
          await this.page.waitForTimeout(150);
        }
        console.log(`[${this.config.institution}] MFA code entered (${count} digit inputs)`);

        // Wait for dashboard to load — use _detectState for reliable detection
        for (let i = 0; i < 15; i++) {
          await this.page.waitForTimeout(3000);
          const result = await this._detectState('post-login');
          if (result.state === 'logged-in') {
            console.log(`[${this.config.institution}] Dashboard loaded after ${(i + 1) * 3}s`);
            break;
          }
        }

        await this.trustDevice();
        return this._detectState('post-login');
      }
    }

    // Standard: single code input field
    let codeField = null;
    for (const selector of mfa.codeInputSelectors) {
      codeField = await target.$(selector);
      if (codeField) break;
    }
    if (!codeField) {
      codeField = await target.$('input[type="tel"]:visible') ||
                  await target.$('input[type="text"]:visible');
    }
    if (!codeField) throw new Error('MFA code input field not found');

    await codeField.fill(code);

    // Check trust device BEFORE submitting — some banks only honor it pre-submit
    await this.trustDevice();

    // Find and click submit — use page.locator for Playwright selector syntax support
    if (mfa.codeSubmitSelector) {
      try {
        await this.page.locator(mfa.codeSubmitSelector).first().click({ timeout: 5000 });
      } catch {
        // Fallback to generic submit
        try { await this.page.locator('button[type="submit"]').first().click({ timeout: 3000 }); } catch {}
      }
    }

    console.log(`[${this.config.institution}] MFA code submitted`);
    await this.page.waitForTimeout(5000);

    // Check for trust device prompt
    await this.trustDevice();

    return this._detectState('post-login');
  }

  /**
   * Initiate push MFA by clicking the push option if available.
   */
  async initiatePushMfa() {
    // Try clicking "Confirm using our mobile app" or similar push option
    const pushSelectors = [
      'text=Confirm using our mobile app',
      'text=Send push notification',
      '[aria-label*="mobile app"]',
      '[aria-label*="push"]',
    ];

    // Try clicking on main page first, then iframe
    const allTargets = [{ label: 'page', target: this.page }];
    if (this.config.login.iframeSelector) {
      allTargets.push({ label: 'iframe', target: this.page.frameLocator(this.config.login.iframeSelector) });
    }

    for (const { label, target } of allTargets) {
      for (const sel of pushSelectors) {
        try {
          await target.locator(sel).first().click({ timeout: 3000 });
          console.log(`[${this.config.institution}] Clicked push MFA option (${label})`);
          await this.page.waitForTimeout(3000);
          break;
        } catch { continue; }
      }
    }

    // Some banks have a two-step flow: select push method, then click "Next"
    const confirmSelectors = [
      'button:has-text("Next")',
      'text=Next',
      'button:has-text("Continue")',
      'button:has-text("Send")',
    ];

    for (const { label, target } of allTargets) {
      for (const sel of confirmSelectors) {
        try {
          await target.locator(sel).first().click({ timeout: 3000 });
          console.log(`[${this.config.institution}] Clicked confirmation button (${label})`);
          await this.page.waitForTimeout(3000);
          return;
        } catch { continue; }
      }
    }

    console.log(`[${this.config.institution}] No additional confirmation button found — push may already be sent`);
  }

  /**
   * Check if push MFA has cleared.
   */
  async checkMfaCleared() {
    await this.page.waitForTimeout(2000);
    const result = await this._detectState();
    return result.state !== 'mfa';
  }

  /**
   * Check "remember me" / "remember login ID" checkbox on the login page before submitting.
   * Generic: looks for common checkbox patterns near the login form.
   * @param {Object} login - login config
   * @param {Object|null} frameLocator - frameLocator if login is in an iframe
   */
  async _checkRememberMe(login, frameLocator) {
    const rememberSelectors = [
      'input[id*="remember"][type="checkbox"]',
      'input[name*="remember"][type="checkbox"]',
      'input[id*="RememberMe"][type="checkbox"]',
      'label:has-text("Remember") input[type="checkbox"]',
    ];
    const target = frameLocator || this.page;
    for (const sel of rememberSelectors) {
      try {
        const cb = target.locator(sel).first();
        if (await cb.isVisible({ timeout: 1000 })) {
          const checked = await cb.isChecked();
          if (!checked) {
            await cb.check({ timeout: 2000 });
            console.log(`[${this.config.institution}] Checked "Remember me" checkbox`);
          }
          return;
        }
      } catch {}
    }
  }

  /**
   * Check "trust this device" / "remember this device" checkbox.
   * Called BEFORE MFA code submission so the trust persists in the Chrome profile.
   * Also called after submission as a fallback (some banks show it post-submit).
   */
  async trustDevice() {
    const { mfa } = this.config;
    if (!mfa || !mfa.trustDevicePatterns) return;

    const pageText = (await extractSanitizedText(this.page, { unwrap: true })).toLowerCase();

    for (const pattern of mfa.trustDevicePatterns) {
      if (pageText.includes(pattern.toLowerCase())) {
        // Try trust-specific checkboxes first (more reliable than generic)
        const trustCheckboxes = [
          'input[id*="remember"][type="checkbox"]',
          'input[id*="trust"][type="checkbox"]',
          'input[name*="remember"][type="checkbox"]',
          'input[name*="trust"][type="checkbox"]',
          'label:has-text("Trust") input[type="checkbox"]',
          'label:has-text("Remember") input[type="checkbox"]',
        ];
        for (const sel of trustCheckboxes) {
          try {
            const cb = this.page.locator(sel).first();
            if (await cb.isVisible({ timeout: 1000 })) {
              const checked = await cb.isChecked();
              if (!checked) {
                await cb.check({ timeout: 2000 });
                console.log(`[${this.config.institution}] Checked "Trust device" checkbox`);
              }
              return;
            }
          } catch {}
        }

        // Fallback: trust button (some banks use a button instead of checkbox)
        const trustButtons = [
          'button:has-text("Yes")',
          'button:has-text("Remember")',
          'button:has-text("Trust")',
          'button:has-text("Don\'t ask again")',
        ];
        for (const sel of trustButtons) {
          try {
            const btn = this.page.locator(sel).first();
            if (await btn.isVisible({ timeout: 1000 })) {
              await btn.click({ timeout: 2000 });
              console.log(`[${this.config.institution}] Clicked trust device button`);
              await this.page.waitForTimeout(2000);
              return;
            }
          } catch {}
        }
        break;
      }
    }
  }

  /**
   * Check if the current page is a maintenance/unavailable page.
   * @returns {Promise<boolean>}
   */
  async isMaintenancePage() {
    try {
      const text = await extractSanitizedText(this.page, { unwrap: true });
      const textLower = text.toLowerCase();
      const keywords = [
        'scheduled maintenance', 'temporarily unavailable', 'system upgrade',
        'under maintenance', 'planned maintenance', 'service unavailable',
        'we\'re currently updating', 'site is temporarily down',
        'performing maintenance', 'try again later',
        'experiencing technical difficulties',
      ];
      return keywords.some(kw => textLower.includes(kw));
    } catch {
      return false;
    }
  }

  /**
   * Check if the browser has left the expected bank domain (session expired/redirected).
   * @returns {boolean}
   */
  isSessionExpired() {
    try {
      const currentUrl = new URL(this.page.url());
      const expectedDomain = this.config.security?.expectedDomain;
      if (!expectedDomain) return false;
      return !currentUrl.hostname.endsWith(expectedDomain);
    } catch {
      return false;
    }
  }

  /**
   * Run the institution-specific extraction function.
   * @returns {{ balances: Array, transactions: Array, holdings: Array }}
   */
  async extract() {
    // Wait for dashboard content to render
    if (this.config.login.loggedInPatterns) {
      try {
        await this.page.waitForFunction(
          (patterns) => {
            const text = document.body.innerText.toLowerCase();
            return patterns.some(p => text.includes(p.toLowerCase())) && text.length > 500;
          },
          this.config.login.loggedInPatterns,
          { timeout: 15000 }
        );
      } catch {
        console.warn(`[${this.config.institution}] Timeout waiting for dashboard content`);
      }
    }

    await this.page.waitForTimeout(2000);

    console.log(`[${this.config.institution}] Extracting data...`);
    return this.config.extraction(this.page, this.config.accounts);
  }

  /**
   * Write canonical output JSON.
   */
  writeOutput(data) {
    const outputFile = path.join(OUTPUT_DIR, `${this.config.institution}.json`);

    // Load existing data for sanity checks
    let existing = null;
    try {
      if (fs.existsSync(outputFile)) {
        existing = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
      }
    } catch {}

    const output = {
      institution: this.config.institution,
      syncedAt: new Date().toISOString(),
      previousSyncedAt: existing?.syncedAt || null,
      balances: data.balances || [],
      transactions: data.transactions || [],
      holdings: data.holdings || [],
    };

    // Pass through pending extraction data for agent processing
    if (data.pendingExtraction) {
      output.pendingExtraction = data.pendingExtraction;
    }

    // Sanity check: warn if balance changed dramatically (>50%) from last sync
    if (existing?.balances?.length > 0 && output.balances.length > 0) {
      for (const newBal of output.balances) {
        const oldBal = existing.balances.find(b => b.accountId === newBal.accountId);
        if (oldBal && oldBal.balance !== 0) {
          const pctChange = Math.abs((newBal.balance - oldBal.balance) / oldBal.balance);
          if (pctChange > 0.5) {
            console.warn(`[${this.config.institution}] ⚠ Large balance change for ${newBal.accountId}: $${oldBal.balance} → $${newBal.balance} (${(pctChange * 100).toFixed(0)}%)`);
          }
        }
      }
    }

    // Never write fewer balances than we had (unless we had zero)
    if (existing?.balances?.length > 0 && output.balances.length === 0) {
      console.warn(`[${this.config.institution}] ⚠ New sync has 0 balances but previous had ${existing.balances.length} — keeping previous data`);
      output.balances = existing.balances;
      output.balancesStale = true;
    }

    fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
    console.log(`[${this.config.institution}] Output written to ${outputFile}`);
    return outputFile;
  }

  /**
   * Write error output JSON — preserves existing good data.
   */
  writeError(error) {
    const outputFile = path.join(OUTPUT_DIR, `${this.config.institution}.json`);

    // Don't overwrite existing good data on error
    if (fs.existsSync(outputFile)) {
      console.error(`[${this.config.institution}] Error: ${error.message || error} — keeping existing output`);
      return outputFile;
    }

    // Only write error output if no previous data exists
    const errOutput = {
      institution: this.config.institution,
      syncedAt: new Date().toISOString(),
      error: error.message || String(error),
      balances: [],
      transactions: [],
      holdings: [],
    };

    fs.writeFileSync(outputFile, JSON.stringify(errOutput, null, 2));
    console.error(`[${this.config.institution}] Error: ${error.message || error}`);
    return outputFile;
  }

  /**
   * Close the page but keep the persistent profile alive.
   */
  async close() {
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
      this.page = null;
      this.loginFrame = null;
    }
  }
}

module.exports = BrowserReader;
