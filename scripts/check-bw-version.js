#!/usr/bin/env node
/**
 * Bitwarden CLI version safety check.
 *
 * Hard-blocks invocation if the installed bw is on the known-compromised list.
 * Matched versions exit(1) — the runtime must NOT silently fall back to .env,
 * because the bw binary itself is poisoned and any further invocation could
 * exfiltrate the master password to the attacker.
 *
 * Usage:
 *   node scripts/check-bw-version.js   # CLI: print installed version + status
 *   const { checkBwVersion } = require('./check-bw-version'); // module
 */

const { execSync } = require('child_process');

// Known-compromised Bitwarden CLI versions. Add entries as new incidents emerge.
const BLOCKED_BW_VERSIONS = new Set([
  // Shai-Hulud "Third Coming" supply chain compromise. Malicious package
  // distributed via npm for ~1.5 hours on 2026-04-22 (5:57–7:30 PM ET).
  // Payload (bw1.js) steals SSH keys, cloud secrets, AI tool credentials,
  // and self-propagates as an npm worm. Bitwarden CI/CD publish pipeline
  // was compromised; vault data itself was not breached.
  // Ref: https://community.bitwarden.com/t/bitwarden-statement-on-checkmarx-supply-chain-incident/96127
  '2026.4.0',
]);

let cachedVersion = null;
let checked = false;

/**
 * Check the installed bw version against the blocklist.
 * @returns {string|null} version string if installed and safe; null if bw is not installed.
 *                        Calls process.exit(1) if installed and blocked.
 */
function checkBwVersion() {
  if (checked) return cachedVersion;
  checked = true;

  let version;
  try {
    version = execSync('bw --version', { stdio: 'pipe', timeout: 5000, encoding: 'utf-8' }).trim();
  } catch {
    cachedVersion = null;
    return null;
  }

  if (BLOCKED_BW_VERSIONS.has(version)) {
    console.error('');
    console.error('═══════════════════════════════════════════════════════════════');
    console.error('  SECURITY: Bitwarden CLI version on known-compromised list');
    console.error('═══════════════════════════════════════════════════════════════');
    console.error(`  Installed: @bitwarden/cli@${version}`);
    console.error('  This version contains supply-chain malware that would');
    console.error('  exfiltrate your master password and vault contents on the');
    console.error('  next bw invocation.');
    console.error('');
    console.error('  Remediation:');
    console.error('    1. npm uninstall -g @bitwarden/cli');
    console.error('    2. Install a verified clean version per Bitwarden\'s advisory');
    console.error('    3. Rotate any credentials that touched this machine');
    console.error('');
    console.error('  Advisory: https://community.bitwarden.com/t/bitwarden-statement-on-checkmarx-supply-chain-incident/96127');
    console.error('  Refusing to run bw. Exiting.');
    console.error('═══════════════════════════════════════════════════════════════');
    console.error('');
    process.exit(1);
  }

  cachedVersion = version;
  return version;
}

if (require.main === module) {
  const v = checkBwVersion();
  if (v === null) {
    console.log('Bitwarden CLI: not installed');
  } else {
    console.log(`Bitwarden CLI: v${v} (not on blocklist)`);
    console.log(`Blocklist size: ${BLOCKED_BW_VERSIONS.size}`);
  }
}

module.exports = { checkBwVersion, BLOCKED_BW_VERSIONS };
