/**
 * MFA Bridge — file-based MFA code exchange between background scripts and the user.
 *
 * When a script needs an MFA code:
 *   1. Call requestCode(institution, message) — writes a request file
 *   2. Call waitForCode(institution, timeoutMs) — polls for the response file
 *   3. The orchestrator (Claude Code, Telegram, or human) writes the code to the response file
 *   4. The script reads it and continues
 *
 * File protocol:
 *   data/mfa-pending/<institution>.request.json  — script creates this (contains message, timestamp)
 *   data/mfa-pending/<institution>.code           — orchestrator writes the code here
 *   Both files are cleaned up after the code is consumed.
 */

const fs = require('fs');
const path = require('path');

const MFA_DIR = path.join(__dirname, '..', 'data', 'mfa-pending');
if (!fs.existsSync(MFA_DIR)) fs.mkdirSync(MFA_DIR, { recursive: true });

/**
 * Request an MFA code. Creates a request file that signals "I need a code."
 * @param {string} institution
 * @param {string} message — human-readable prompt (e.g., "BankName 2FA — enter the 6-digit code sent to your device")
 */
function requestCode(institution, message) {
  const requestFile = path.join(MFA_DIR, `${institution}.request.json`);
  const payload = {
    institution,
    message,
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(requestFile, JSON.stringify(payload, null, 2));
  console.log(`[mfa-bridge] Code requested for ${institution}: ${message}`);
}

/**
 * Poll for the MFA code. Blocks until the code file appears or timeout.
 * @param {string} institution
 * @param {number} timeoutMs — how long to wait (default: 5 minutes)
 * @returns {Promise<string|null>} the code, or null on timeout
 */
async function waitForCode(institution, timeoutMs = 300000) {
  const codeFile = path.join(MFA_DIR, `${institution}.code`);
  const requestFile = path.join(MFA_DIR, `${institution}.request.json`);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (fs.existsSync(codeFile)) {
      const code = fs.readFileSync(codeFile, 'utf-8').trim();
      // Clean up
      try { fs.unlinkSync(codeFile); } catch {}
      try { fs.unlinkSync(requestFile); } catch {}
      console.log(`[mfa-bridge] Code received for ${institution}`);
      return code;
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  // Clean up on timeout
  try { fs.unlinkSync(requestFile); } catch {}
  console.log(`[mfa-bridge] Timeout waiting for code (${institution})`);
  return null;
}

/**
 * Submit an MFA code (called by the orchestrator/user).
 * @param {string} institution
 * @param {string} code
 */
function submitCode(institution, code) {
  const codeFile = path.join(MFA_DIR, `${institution}.code`);
  fs.writeFileSync(codeFile, code.trim());
  console.log(`[mfa-bridge] Code submitted for ${institution}`);
}

/**
 * Check if any institution is waiting for an MFA code.
 * @returns {Array<{institution: string, message: string, timestamp: string}>}
 */
function getPendingRequests() {
  const pending = [];
  try {
    const files = fs.readdirSync(MFA_DIR).filter(f => f.endsWith('.request.json'));
    for (const file of files) {
      const data = JSON.parse(fs.readFileSync(path.join(MFA_DIR, file), 'utf-8'));
      pending.push(data);
    }
  } catch {}
  return pending;
}

module.exports = { requestCode, waitForCode, submitCode, getPendingRequests };
