/**
 * Shared download path helper.
 *
 * Provides structured paths for all downloaded files:
 *   data/downloads/{institution}/{accountId}/transactions/{YYYY-MM-DD}--{timestamp}.csv
 *   data/downloads/{institution}/{accountId}/statements/{YYYY-MM}--{timestamp}.pdf
 *   data/downloads/{institution}/zips/{timestamp}.zip
 *   data/downloads/{institution}/zips/unzipped-{timestamp}/
 *
 * Each function ensures the directory exists via mkdirSync({ recursive: true }).
 */

const fs = require('fs');
const path = require('path');

const DOWNLOAD_ROOT = path.join(__dirname, '..', '..', 'data', 'downloads');

function timestamp() {
  return Date.now();
}

function dateStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function monthStr() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

/**
 * Path for a transaction CSV download.
 * @param {string} institution - Institution slug
 * @param {string} accountId - Account identifier
 * @param {string} [date] - Date string (YYYY-MM-DD), defaults to today
 * @returns {string} Full file path
 */
function transactionPath(institution, accountId, date) {
  const dir = path.join(DOWNLOAD_ROOT, institution, accountId, 'transactions');
  fs.mkdirSync(dir, { recursive: true });
  const d = date || dateStr();
  return path.join(dir, `${d}--${timestamp()}.csv`);
}

/**
 * Path for a statement PDF download.
 * @param {string} institution - Institution slug
 * @param {string} accountId - Account identifier
 * @param {string} [month] - Month string (YYYY-MM), defaults to current month
 * @returns {string} Full file path
 */
function statementPath(institution, accountId, month) {
  const dir = path.join(DOWNLOAD_ROOT, institution, accountId, 'statements');
  fs.mkdirSync(dir, { recursive: true });
  const m = month || monthStr();
  return path.join(dir, `${m}--${timestamp()}.pdf`);
}

/**
 * Path for a ZIP archive download.
 * @param {string} institution - Institution slug
 * @returns {string} Full file path
 */
function zipPath(institution) {
  const dir = path.join(DOWNLOAD_ROOT, institution, 'zips');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${timestamp()}.zip`);
}

/**
 * Path for an unzipped directory.
 * @param {string} institution - Institution slug
 * @returns {string} Full directory path (created)
 */
function unzipDir(institution) {
  const dir = path.join(DOWNLOAD_ROOT, institution, 'zips', `unzipped-${timestamp()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { transactionPath, statementPath, zipPath, unzipDir, DOWNLOAD_ROOT };
