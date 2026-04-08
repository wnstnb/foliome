#!/usr/bin/env node
/**
 * Pre-flight Encryption — ensures sensitive credentials in .env are encrypted.
 *
 * Scans .env for unencrypted sensitive values (bank credentials, Bitwarden secrets)
 * and encrypts them via dotenvx. Already-encrypted values are left untouched.
 *
 * Usage:
 *   node scripts/encrypt-env.js          # encrypt any raw sensitive values
 *   node scripts/encrypt-env.js --check  # check only, don't encrypt (exit 1 if raw found)
 *
 * Called automatically before sync and other operations.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');
const CHECK_ONLY = process.argv.includes('--check');

// Patterns for sensitive env var names that MUST be encrypted
const SENSITIVE_PATTERNS = [
  /_USERNAME$/,
  /_PASSWORD$/,
  /^BW_PASSWORD$/,
  /^BW_CLIENTID$/,
  /^BW_CLIENTSECRET$/,
];

function isSensitive(key) {
  return SENSITIVE_PATTERNS.some(p => p.test(key));
}

/**
 * Parse .env file manually to handle quoted values and special characters correctly.
 * Returns array of { key, value, encrypted, line, quoted }
 */
function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, 'utf-8');
  const entries = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('/')) continue;

    // Match KEY=VALUE or KEY="VALUE"
    const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;

    const key = match[1];
    let value = match[2];
    let quoted = false;

    // Handle quoted values
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
      quoted = true;
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
      quoted = true;
    }

    const encrypted = value.startsWith('encrypted:');

    entries.push({ key, value, encrypted, line: trimmed, quoted });
  }

  return entries;
}

/**
 * Enforce single-quoting on all unencrypted sensitive values in .env.
 * Single quotes prevent $, #, backtick, and whitespace from being interpreted.
 * Rewrites the file in place before encryption runs.
 */
function enforceSingleQuotes(filePath, entries) {
  const sensitiveUnquoted = entries.filter(e => isSensitive(e.key) && !e.encrypted && !e.quoted);
  if (sensitiveUnquoted.length === 0) return false;

  let content = fs.readFileSync(filePath, 'utf-8');

  for (const entry of sensitiveUnquoted) {
    // Replace the raw line with single-quoted version
    // Match the key= and everything after it on that line
    const rawPattern = new RegExp(`^(${entry.key}=)(.+)$`, 'm');
    content = content.replace(rawPattern, (match, prefix, val) => {
      // Strip any existing quotes (single or double) that might be malformed
      let clean = val.trim();
      if ((clean.startsWith('"') && clean.endsWith('"')) ||
          (clean.startsWith("'") && clean.endsWith("'"))) {
        clean = clean.slice(1, -1);
      }
      return `${prefix}'${clean}'`;
    });
    console.log(`[encrypt-env] Single-quoted: ${entry.key}`);
  }

  fs.writeFileSync(filePath, content, 'utf-8');
  return true;
}

function main() {
  if (!fs.existsSync(ENV_PATH)) {
    console.log('[encrypt-env] No .env file found — nothing to encrypt');
    return;
  }

  // dotenvx is required — credentials must be encrypted before any operation
  try {
    require.resolve('@dotenvx/dotenvx');
  } catch {
    console.error('[encrypt-env] FATAL: @dotenvx/dotenvx is not installed.');
    console.error('  Run: npm install @dotenvx/dotenvx --save');
    process.exit(1);
  }

  let entries = parseEnvFile(ENV_PATH);
  let sensitiveEntries = entries.filter(e => isSensitive(e.key));

  if (sensitiveEntries.length === 0) {
    console.log('[encrypt-env] No sensitive keys found in .env');
    return;
  }

  // Enforce single-quoting on all unencrypted sensitive values before encryption.
  // This prevents # truncation, $ interpolation, and backtick expansion.
  if (enforceSingleQuotes(ENV_PATH, entries)) {
    // Re-parse after rewriting
    entries = parseEnvFile(ENV_PATH);
    sensitiveEntries = entries.filter(e => isSensitive(e.key));
  }

  const unencrypted = sensitiveEntries.filter(e => !e.encrypted);
  const alreadyEncrypted = sensitiveEntries.filter(e => e.encrypted);

  if (alreadyEncrypted.length > 0) {
    console.log(`[encrypt-env] ${alreadyEncrypted.length} sensitive key(s) already encrypted`);
  }

  if (unencrypted.length === 0) {
    console.log('[encrypt-env] All sensitive values are encrypted');
    return;
  }

  if (CHECK_ONLY) {
    console.log(`[encrypt-env] ${unencrypted.length} unencrypted sensitive key(s) found:`);
    for (const entry of unencrypted) {
      console.log(`  ${entry.key}`);
    }
    process.exit(1);
  }

  // Encrypt each unencrypted sensitive key
  console.log(`[encrypt-env] Encrypting ${unencrypted.length} sensitive key(s)...`);

  for (const entry of unencrypted) {
    try {
      execSync(`node_modules/.bin/dotenvx encrypt -k ${entry.key} -f "${ENV_PATH}"`, {
        stdio: 'pipe',
        timeout: 15000,
        cwd: path.join(__dirname, '..'),
      });
      console.log(`[encrypt-env] Encrypted: ${entry.key}`);
    } catch (err) {
      console.error(`[encrypt-env] Failed to encrypt ${entry.key}: ${err.message}`);
      process.exit(1);
    }
  }

  console.log('[encrypt-env] All sensitive values encrypted');
}

module.exports = { parseEnvFile, isSensitive, SENSITIVE_PATTERNS };

if (require.main === module) {
  main();
}
