#!/usr/bin/env node
/**
 * Discover Data Semantics — inspects CSV files to suggest a data-semantics.json entry.
 *
 * Reads CSV files from data/downloads/{institution}/ (structured) or falls back to
 * data/downloads/ (flat, legacy) matching the institution slug, parses headers and
 * sample rows, and prints a suggested entry.
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

// Find CSVs — try structured path first, then flat
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

const csvFiles = findCSVs();
if (csvFiles.length === 0) {
  console.log(`No CSV files found for "${institution}" in data/downloads/`);
  process.exit(1);
}

console.log(`Found ${csvFiles.length} CSV file(s) for "${institution}":\n`);

for (const csvPath of csvFiles.slice(0, 3)) {
  console.log(`--- ${path.relative(DOWNLOAD_ROOT, csvPath)} ---`);
  const raw = fs.readFileSync(csvPath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());

  if (lines.length === 0) {
    console.log('  (empty file)\n');
    continue;
  }

  // Try to find the header row (first row with non-numeric first field)
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
  console.log(`  Headers (row ${headerIdx}): ${headers.join(' | ')}\n`);

  // Show sample rows
  const sampleStart = headerIdx + 1;
  const sampleEnd = Math.min(sampleStart + 5, lines.length);
  console.log('  Sample rows:');
  for (let i = sampleStart; i < sampleEnd; i++) {
    const fields = parseCSVLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => { if (fields[idx] !== undefined) row[h] = fields[idx]; });
    console.log(`    ${JSON.stringify(row)}`);
  }

  // Analyze amount column
  const amountCandidates = headers.filter(h =>
    /amount|debit|credit|total/i.test(h)
  );

  if (amountCandidates.length > 0) {
    console.log(`\n  Amount column candidates: ${amountCandidates.join(', ')}`);

    for (const col of amountCandidates) {
      const colIdx = headers.indexOf(col);
      const values = [];
      for (let i = sampleStart; i < Math.min(sampleStart + 20, lines.length); i++) {
        const fields = parseCSVLine(lines[i]);
        if (fields[colIdx]) values.push(fields[colIdx].replace(/[,$"]/g, ''));
      }

      const nums = values.map(Number).filter(n => !isNaN(n));
      const hasPositive = nums.some(n => n > 0);
      const hasNegative = nums.some(n => n < 0);

      if (hasPositive && hasNegative) {
        console.log(`    "${col}": signed column (has both positive and negative values)`);
      } else if (hasPositive) {
        console.log(`    "${col}": all positive — may need a type indicator column`);
      } else if (hasNegative) {
        console.log(`    "${col}": all negative`);
      }
    }
  }

  // Look for type columns (debit/credit indicator)
  const typeCandidates = headers.filter(h =>
    /type|category|class/i.test(h) && !/amount/i.test(h)
  );
  if (typeCandidates.length > 0) {
    for (const col of typeCandidates) {
      const colIdx = headers.indexOf(col);
      const values = new Set();
      for (let i = sampleStart; i < Math.min(sampleStart + 20, lines.length); i++) {
        const fields = parseCSVLine(lines[i]);
        if (fields[colIdx]) values.add(fields[colIdx].replace(/"/g, ''));
      }
      console.log(`    "${col}" values: ${[...values].join(', ')}`);
    }
  }

  console.log('');
}

// Suggest entry
console.log('--- Suggested data-semantics.json entry ---');
console.log(`"${institution}": {`);
console.log('  "transactionConvention": {');
console.log('    "format": "signed",     // or "typed"');
console.log('    "debit": "negative",    // or "positive" (issuer perspective)');
console.log('    "credit": "positive"    // or "negative" (issuer perspective)');
console.log('  },');
console.log('  "balanceConvention": {');
console.log('    "checking": "positive = funds held"');
console.log('  },');
console.log('  "columnMapping": {');
console.log('    "date": "...",');
console.log('    "description": "...",');
console.log('    "amount": "..."');
console.log('  },');
console.log('  "anchors": [');
console.log('    { "descriptionPattern": "...", "is": "debit", "rawSign": "negative" }');
console.log('  ],');
console.log('  "notes": "...",');
console.log(`  "learnedAt": "${new Date().toISOString().slice(0, 10)}",`);
console.log('  "learnedFrom": "discover-semantics.js analysis"');
console.log('}');
