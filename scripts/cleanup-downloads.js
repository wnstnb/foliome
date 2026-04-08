#!/usr/bin/env node
/**
 * Cleanup old download files.
 *
 * Walks data/downloads/ recursively and deletes files older than a threshold.
 * Removes empty directories bottom-up after cleanup.
 *
 * Usage:
 *   node scripts/cleanup-downloads.js           # dry run (default)
 *   node scripts/cleanup-downloads.js --run     # actually delete
 *   node scripts/cleanup-downloads.js --days 15 # custom threshold (default: 30)
 */

const fs = require('fs');
const path = require('path');

const DOWNLOAD_ROOT = path.resolve(path.join(__dirname, '..', 'data', 'downloads'));
const dryRun = !process.argv.includes('--run');
const daysIdx = process.argv.indexOf('--days');
const days = daysIdx !== -1 && process.argv[daysIdx + 1] ? parseInt(process.argv[daysIdx + 1], 10) : 30;
const thresholdMs = days * 24 * 60 * 60 * 1000;
const cutoff = Date.now() - thresholdMs;

if (!fs.existsSync(DOWNLOAD_ROOT)) {
  console.log('No downloads directory found — nothing to clean.');
  process.exit(0);
}

/**
 * Collect all files recursively under a directory.
 */
function walkFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    // Path confinement check
    if (!path.resolve(full).startsWith(DOWNLOAD_ROOT)) continue;
    if (entry.isDirectory()) {
      results.push(...walkFiles(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

/**
 * Collect all directories recursively (deepest first for bottom-up removal).
 */
function walkDirs(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (!path.resolve(full).startsWith(DOWNLOAD_ROOT)) continue;
    if (entry.isDirectory()) {
      results.push(...walkDirs(full));
      results.push(full);
    }
  }
  return results;
}

// Collect old files
const allFiles = walkFiles(DOWNLOAD_ROOT);
const oldFiles = [];
let totalBytes = 0;

for (const file of allFiles) {
  const stat = fs.statSync(file);
  if (stat.mtimeMs < cutoff) {
    oldFiles.push(file);
    totalBytes += stat.size;
  }
}

const mode = dryRun ? 'DRY RUN' : 'DELETING';
console.log(`${mode}: ${oldFiles.length} files older than ${days} days (${(totalBytes / 1024 / 1024).toFixed(1)} MB)\n`);

// Delete files
let deletedFiles = 0;
for (const file of oldFiles) {
  const rel = path.relative(DOWNLOAD_ROOT, file);
  if (dryRun) {
    console.log(`  would delete: ${rel}`);
  } else {
    try {
      fs.unlinkSync(file);
      deletedFiles++;
    } catch (e) {
      console.log(`  failed to delete ${rel}: ${e.message}`);
    }
  }
}

// Remove empty directories (bottom-up)
let removedDirs = 0;
if (!dryRun) {
  const dirs = walkDirs(DOWNLOAD_ROOT);
  for (const dir of dirs) {
    try {
      const entries = fs.readdirSync(dir);
      if (entries.length === 0) {
        fs.rmdirSync(dir);
        removedDirs++;
      }
    } catch {}
  }
}

// Summary
if (dryRun) {
  console.log(`\nDry run complete. ${oldFiles.length} files (${(totalBytes / 1024 / 1024).toFixed(1)} MB) would be deleted.`);
  console.log('Run with --run to actually delete.');
} else {
  console.log(`\nDeleted ${deletedFiles} files (${(totalBytes / 1024 / 1024).toFixed(1)} MB), removed ${removedDirs} empty directories.`);
}
