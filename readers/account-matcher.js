/**
 * Account Matcher — matches display names from bank pages to canonical accounts.
 *
 * Matching priority:
 *   1. Last-4 digits (strongest — unique per account, never changes)
 *   2. Exact alias match
 *   3. Substring match against aliases and bankName
 *
 * Also handles enriching accounts.json with newly discovered display names.
 */

const fs = require('fs');
const path = require('path');

const ACCOUNTS_PATH = path.join(__dirname, '..', 'config', 'accounts.json');

/**
 * Match a display name (e.g., "TOTAL CHECKING (...1234)") to a known account.
 *
 * @param {string} displayName - The name shown on the bank's page
 * @param {Array} accountList - Accounts from accounts.json for this institution
 * @returns {{ account: Object, confidence: string }|null}
 */
function matchAccount(displayName, accountList) {
  if (!displayName || !accountList) return null;

  const nameUpper = displayName.toUpperCase().trim();

  // Extract last-4 from the display name if present
  const last4Match = displayName.match(/\(?\.{0,3}(\d{4})\)?/);
  const displayLast4 = last4Match ? last4Match[1] : null;

  // Priority 1: Match by last-4 digits
  if (displayLast4) {
    const byLast4 = accountList.find(a => a.last4 === displayLast4);
    if (byLast4) return { account: byLast4, confidence: 'last4' };
  }

  // Priority 2: Exact alias match
  for (const acct of accountList) {
    if (acct.aliases && acct.aliases.some(a => a.toUpperCase() === nameUpper)) {
      return { account: acct, confidence: 'exact-alias' };
    }
  }

  // Priority 3: Substring match against bankName and aliases
  for (const acct of accountList) {
    const bankUpper = acct.bankName.toUpperCase();
    if (nameUpper.includes(bankUpper) || bankUpper.includes(nameUpper)) {
      return { account: acct, confidence: 'substring' };
    }
    if (acct.aliases) {
      for (const alias of acct.aliases) {
        const aliasUpper = alias.toUpperCase();
        if (nameUpper.includes(aliasUpper) || aliasUpper.includes(nameUpper)) {
          return { account: acct, confidence: 'substring-alias' };
        }
      }
    }
  }

  return null;
}

/**
 * Add a new alias to an account if not already known.
 * Persists the change back to accounts.json.
 *
 * @param {string} institution - Institution slug
 * @param {string} accountId - Canonical account ID
 * @param {string} newAlias - New display name to add
 * @returns {boolean} Whether a new alias was added
 */
function addAlias(institution, accountId, newAlias) {
  if (!newAlias || !newAlias.trim()) return false;

  const allAccounts = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf-8'));
  const instAccounts = allAccounts[institution];
  if (!instAccounts) return false;

  const account = instAccounts.accounts.find(a => a.accountId === accountId);
  if (!account) return false;

  if (!account.aliases) account.aliases = [];

  const trimmed = newAlias.trim();
  const alreadyKnown = account.aliases.some(a => a.toUpperCase() === trimmed.toUpperCase());

  if (!alreadyKnown) {
    account.aliases.push(trimmed);
    fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(allAccounts, null, 2) + '\n');
    console.log(`[account-matcher] Added alias "${trimmed}" to ${accountId}`);
    return true;
  }

  return false;
}

/**
 * Update or set the last-4 digits for an account.
 *
 * @param {string} institution
 * @param {string} accountId
 * @param {string} last4
 */
function setLast4(institution, accountId, last4) {
  const allAccounts = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf-8'));
  const account = allAccounts[institution]?.accounts?.find(a => a.accountId === accountId);
  if (!account) return;

  if (account.last4 !== last4) {
    account.last4 = last4;
    fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(allAccounts, null, 2) + '\n');
    console.log(`[account-matcher] Set last4 "${last4}" for ${accountId}`);
  }
}

module.exports = { matchAccount, addAlias, setLast4 };
