#!/usr/bin/env node
/**
 * Discover Data Semantics — inspects transaction data to suggest a data-semantics.json entry.
 *
 * Sources (tried in order):
 *   1. CSV files from data/downloads/{institution}/
 *   2. JSON sync-output from data/sync-output/{institution}.json (raw fields)
 *
 * Advisory only — user reviews and adds manually.
 *
 * Usage:
 *   node scripts/discover-semantics.js <institution>
 */

const fs = require('fs');
const path = require('path');

const institution = process.argv[2];
if (!institution) {
  console.error('Usage: node scripts/discover-semantics.js <institution>');
  process.exit(1);
}

const DOWNLOAD_ROOT = path.join(__dirname, '..', 'data', 'downloads');
const SYNC_OUTPUT_DIR = path.join(__dirname, '..', 'data', 'sync-output');

// === CSV source ===

function findCSVs() {
  const csvFiles = [];

  // Structured: data/downloads/{institution}/**/transactions/*.csv
  const structuredDir = path.join(DOWNLOAD_ROOT, institution);
  if (fs.existsSync(structuredDir)) {
    walkForCSVs(structuredDir, csvFiles);
  }

  // Flat (legacy): data/downloads/{institution}-*.csv or {institution}*.csv
  if (fs.existsSync(DOWNLOAD_ROOT)) {
    for (const f of fs.readdirSync(DOWNLOAD_ROOT)) {
      if (f.endsWith('.csv') && f.startsWith(institution)) {
        csvFiles.push(path.join(DOWNLOAD_ROOT, f));
      }
    }
  }

  return csvFiles;
}

function walkForCSVs(dir, results) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkForCSVs(full, results);
    } else if (entry.name.endsWith('.csv')) {
      results.push(full);
    }
  }
}

function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function loadCSVRows(csvPath) {
  const raw = fs.readFileSync(csvPath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length === 0) return null;

  // Find header row (first row with non-numeric first field)
  let headerIdx = 0;
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    const fields = parseCSVLine(lines[i]);
    const first = fields[0].replace(/"/g, '');
    if (isNaN(first) && !first.match(/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/)) {
      headerIdx = i;
      break;
    }
  }

  const headers = parseCSVLine(lines[headerIdx]);
  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => { if (fields[idx] !== undefined) row[h] = fields[idx]; });
    rows.push(row);
  }

  return { headers, rows };
}

// === JSON sync-output source ===

function loadJSONRows() {
  const filePath = path.join(SYNC_OUTPUT_DIR, `${institution}.json`);
  if (!fs.existsSync(filePath)) return null;

  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const transactions = data.transactions || [];
  if (transactions.length === 0) return null;

  // Extract raw objects, skip entries with non-scalar values (nested objects)
  const rawRows = transactions.map(t => t.raw).filter(Boolean);
  if (rawRows.length === 0) return null;

  // Headers from first raw object — only scalar fields
  const headers = Object.keys(rawRows[0]).filter(k => {
    const v = rawRows[0][k];
    return v === null || v === undefined || typeof v !== 'object';
  });

  // Normalize all values to strings (match CSV behavior)
  const rows = rawRows.map(r => {
    const row = {};
    for (const h of headers) {
      row[h] = r[h] !== undefined && r[h] !== null ? String(r[h]) : '';
    }
    return row;
  });

  return { headers, rows };
}

// === Analysis (works on any { headers, rows } source) ===

function analyzeRows(headers, rows, label) {
  console.log(`--- ${label} ---`);
  console.log(`  Headers: ${headers.join(' | ')}`);
  console.log(`  Rows: ${rows.length}\n`);

  // Sample rows
  console.log('  Sample rows:');
  for (const row of rows.slice(0, 5)) {
    console.log(`    ${JSON.stringify(row)}`);
  }

  // Track what we detect for the suggested entry
  const detected = { format: null, typeColumn: null, debitValue: null, creditValue: null, amountColumn: null };

  // Analyze amount columns
  const amountCandidates = headers.filter(h =>
    /amount|debit|credit|total/i.test(h)
  );

  if (amountCandidates.length > 0) {
    console.log(`\n  Amount column candidates: ${amountCandidates.join(', ')}`);

    for (const col of amountCandidates) {
      const values = rows.slice(0, 20)
        .map(r => r[col])
        .filter(Boolean)
        .map(v => Number(String(v).replace(/[$,]/g, '')))
        .filter(n => !isNaN(n));

      const hasPositive = values.some(n => n > 0);
      const hasNegative = values.some(n => n < 0);

      if (hasPositive && hasNegative) {
        console.log(`    "${col}": signed column (has both positive and negative values)`);
        detected.format = 'signed';
        detected.amountColumn = col;
      } else if (hasPositive) {
        console.log(`    "${col}": all positive — likely needs a type indicator column`);
        detected.amountColumn = col;
      } else if (hasNegative) {
        console.log(`    "${col}": all negative`);
        detected.amountColumn = col;
      }
    }
  }

  // Look for type columns (debit/credit indicator)
  const typeCandidates = headers.filter(h =>
    /type|category|class|details/i.test(h) && !/amount/i.test(h)
  );

  if (typeCandidates.length > 0) {
    for (const col of typeCandidates) {
      const values = new Set();
      for (const row of rows.slice(0, 20)) {
        if (row[col]) values.add(String(row[col]).replace(/"/g, ''));
      }
      const uniqueVals = [...values];
      console.log(`    "${col}" values: ${uniqueVals.join(', ')}`);

      // Check if this looks like a debit/credit indicator
      const hasDebit = uniqueVals.some(v => /^debit$/i.test(v));
      const hasCredit = uniqueVals.some(v => /^credit$/i.test(v));
      if (hasDebit && hasCredit) {
        console.log(`    → "${col}" is a debit/credit type indicator`);
        detected.format = 'typed';
        detected.typeColumn = col;
        detected.debitValue = uniqueVals.find(v => /^debit$/i.test(v));
        detected.creditValue = uniqueVals.find(v => /^credit$/i.test(v));
      }
    }
  }

  // If we found all-positive amounts + a type column, confirm typed format
  if (!detected.format && detected.amountColumn && detected.typeColumn) {
    detected.format = 'typed';
  }

  console.log('');
  return detected;
}

// === Main ===

let source = null;
let label = null;

// Try CSV first
const csvFiles = findCSVs();
if (csvFiles.length > 0) {
  console.log(`Found ${csvFiles.length} CSV file(s) for "${institution}" in data/downloads/\n`);
  for (const csvPath of csvFiles.slice(0, 3)) {
    source = loadCSVRows(csvPath);
    label = `CSV: ${path.relative(DOWNLOAD_ROOT, csvPath)}`;
    if (source) break;
  }
}

// Fall back to JSON sync-output
if (!source) {
  source = loadJSONRows();
  if (source) {
    label = `JSON sync-output: data/sync-output/${institution}.json (${source.rows.length} transactions)`;
  }
}

if (!source) {
  console.error(`No transaction data found for "${institution}".`);
  console.error('  Checked: data/downloads/ (CSV) and data/sync-output/ (JSON)');
  process.exit(1);
}

const detected = analyzeRows(source.headers, source.rows, label);

// === Suggested entry ===

console.log('--- Suggested data-semantics.json entry ---');
console.log(`"${institution}": {`);
console.log('  "transactionConvention": {');
if (detected.format === 'typed') {
  console.log(`    "format": "typed",`);
  console.log(`    "typeColumn": "${detected.typeColumn}",`);
  console.log(`    "debitValue": "${detected.debitValue}",`);
  console.log(`    "creditValue": "${detected.creditValue}"`);
} else if (detected.format === 'signed') {
  console.log('    "format": "signed",');
  console.log('    "debit": "negative",    // CHECK: is the raw debit positive or negative?');
  console.log('    "credit": "positive"    // CHECK: is the raw credit positive or negative?');
} else {
  console.log('    "format": "signed",     // or "typed" — could not auto-detect');
  console.log('    "debit": "negative",    // or "positive" (issuer perspective)');
  console.log('    "credit": "positive"    // or "negative" (issuer perspective)');
}
console.log('  },');
console.log('  "balanceConvention": {');
console.log('    "checking": "positive = funds held"');
console.log('  },');
console.log('  "columnMapping": {');

// Suggest column mappings based on detected headers
const dateCol = source.headers.find(h => /date/i.test(h) && /trans/i.test(h))
  || source.headers.find(h => /date/i.test(h));
const descCol = source.headers.find(h => /description/i.test(h))
  || source.headers.find(h => /merchant/i.test(h));
const amountCol = detected.amountColumn || source.headers.find(h => /amount/i.test(h));

console.log(`    "date": "${dateCol || '...'}", `);
console.log(`    "description": "${descCol || '...'}", `);
console.log(`    "amount": "${amountCol || '...'}"`);
console.log('  },');
console.log('  "anchors": [');
console.log('    { "descriptionPattern": "...", "is": "debit", "rawSign": "positive" }');
console.log('  ],');
console.log('  "notes": "...",');
console.log(`  "learnedAt": "${new Date().toISOString().slice(0, 10)}",`);
console.log('  "learnedFrom": "discover-semantics.js analysis"');
console.log('}');
