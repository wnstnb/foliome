/**
 * Credential Resolution Module
 *
 * Fetches bank credentials from Bitwarden vault (preferred) or .env (fallback).
 * Only fetches item IDs explicitly listed in config/credential-map.json — no vault browsing.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CREDENTIAL_MAP_PATH = path.join(__dirname, '..', 'config', 'credential-map.json');

// Session cached for duration of process
let bwSession = null;
let bwAvailable = null; // null = not checked, true/false after check

/**
 * Check if the Bitwarden CLI is installed.
 */
function isBwInstalled() {
  try {
    execSync('bw --version', { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Authenticate with Bitwarden and unlock the vault.
 * Uses API key login + master password unlock.
 * If BW_SESSION is already set (e.g., passed from parent process), skips login/unlock.
 * @returns {string|null} Session token or null on failure
 */
function authenticate() {
  if (bwSession) return bwSession;

  // If parent process pre-authenticated and passed the session token, use it directly
  if (process.env.BW_SESSION) {
    bwSession = process.env.BW_SESSION;
    return bwSession;
  }

  const clientId = process.env.BW_CLIENTID;
  const clientSecret = process.env.BW_CLIENTSECRET;
  const masterPassword = process.env.BW_PASSWORD;

  if (!clientId || !clientSecret || !masterPassword) {
    return null;
  }

  try {
    // Check current status
    const statusRaw = execSync('bw status', { stdio: 'pipe', timeout: 10000, encoding: 'utf-8' });
    const status = JSON.parse(statusRaw);

    if (status.status === 'unauthenticated') {
      // Login with API key
      execSync('bw login --apikey', {
        stdio: 'pipe',
        timeout: 30000,
        env: { ...process.env, BW_CLIENTID: clientId, BW_CLIENTSECRET: clientSecret },
      });
    }

    // Unlock vault — captures session token from stdout
    const unlockOutput = execSync('bw unlock --passwordenv BW_PASSWORD', {
      stdio: 'pipe',
      timeout: 30000,
      encoding: 'utf-8',
      env: { ...process.env, BW_PASSWORD: masterPassword },
    });

    // Extract session token from output: export BW_SESSION="..."
    const sessionMatch = unlockOutput.match(/BW_SESSION="([^"]+)"/);
    if (!sessionMatch) {
      // Try already-unlocked case
      if (status.status === 'unlocked') {
        // Already unlocked — sync to get a session
        const syncOutput = execSync('bw unlock --passwordenv BW_PASSWORD --raw', {
          stdio: 'pipe',
          timeout: 30000,
          encoding: 'utf-8',
          env: { ...process.env, BW_PASSWORD: masterPassword },
        });
        if (syncOutput.trim()) {
          bwSession = syncOutput.trim();
          return bwSession;
        }
      }
      return null;
    }

    bwSession = sessionMatch[1];
    return bwSession;
  } catch (err) {
    console.log(`[credentials] Bitwarden auth failed: ${err.message}`);
    return null;
  }
}

/**
 * Fetch a single item from Bitwarden by ID.
 * @param {string} itemId - Bitwarden vault item UUID
 * @param {string} session - BW_SESSION token
 * @returns {{ username: string, password: string }|null}
 */
function fetchItem(itemId, session) {
  try {
    const raw = execSync(`bw get item ${itemId} --session ${session}`, {
      stdio: 'pipe',
      timeout: 15000,
      encoding: 'utf-8',
    });
    const item = JSON.parse(raw);

    if (item.login) {
      return {
        username: item.login.username || '',
        password: item.login.password || '',
      };
    }
    return null;
  } catch (err) {
    console.log(`[credentials] Failed to fetch item ${itemId}: ${err.message}`);
    return null;
  }
}

/**
 * Get credentials for an institution.
 *
 * Resolution order:
 * 1. Bitwarden vault (if mapped in credential-map.json and bw CLI available)
 * 2. Environment variables (usernameEnv / passwordEnv from institution config)
 *
 * @param {string} institution - Institution slug (e.g., 'chase')
 * @param {{ usernameEnv: string, passwordEnv: string }} credentials - Env var names for fallback
 * @returns {Promise<{ username: string, password: string }>}
 */
async function getCredentials(institution, credentials) {
  // Try Bitwarden first
  if (bwAvailable === null) {
    bwAvailable = isBwInstalled();
    if (!bwAvailable) {
      console.log('[credentials] Bitwarden CLI not found — using .env');
    }
  }

  if (bwAvailable) {
    try {
      const map = JSON.parse(fs.readFileSync(CREDENTIAL_MAP_PATH, 'utf-8'));
      const itemId = map[institution];

      if (itemId) {
        const session = authenticate();
        if (session) {
          const creds = fetchItem(itemId, session);
          if (creds && creds.username && creds.password) {
            console.log(`[credentials] ${institution}: fetched from Bitwarden vault`);
            return creds;
          }
          console.log(`[credentials] ${institution}: Bitwarden fetch failed — falling back to .env`);
        }
      }
    } catch {
      // credential-map.json missing or invalid — fall back silently
    }
  }

  // Fallback: environment variables
  const username = process.env[credentials.usernameEnv];
  const password = process.env[credentials.passwordEnv];

  return { username, password };
}

module.exports = { getCredentials };
