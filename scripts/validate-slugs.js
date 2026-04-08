#!/usr/bin/env node
/**
 * Slug Immutability Checker
 *
 * Validates that institution slugs are consistent across all config surfaces:
 *   1. readers/institutions/{slug}.js — `institution` property === slug
 *   2. data/sync-output/{slug}.json — `institution` field === slug (if exists)
 *   3. config/accounts.json — top-level key === slug (if exists)
 *   4. config/data-semantics.json — institution key === slug (if exists)
 *   5. config/credential-map.json — key === slug (if exists)
 *
 * Also detects orphaned sync output files with no matching institution config.
 *
 * Usage:
 *   node scripts/validate-slugs.js                  # full audit (all slugs)
 *   node scripts/validate-slugs.js <institution>    # single slug
 *
 * Importable:
 *   const { validateSlug, validateAllSlugs } = require('./scripts/validate-slugs');
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INSTITUTIONS_DIR = path.join(ROOT, 'readers', 'institutions');
const CONNECTORS_DIR = path.join(ROOT, 'connectors');
const SYNC_OUTPUT_DIR = path.join(ROOT, 'data', 'sync-output');
const ACCOUNTS_PATH = path.join(ROOT, 'config', 'accounts.json');
const SEMANTICS_PATH = path.join(ROOT, 'config', 'data-semantics.json');
const CREDENTIAL_MAP_PATH = path.join(ROOT, 'config', 'credential-map.json');

function loadJSON(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch { return null; }
}

/**
 * Validate a single institution slug across all config surfaces.
 * @param {string} slug - Institution slug (e.g., 'chase', 'capital-one')
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateSlug(slug) {
  const errors = [];

  // 1. Config file institution property (browser reader or API connector)
  const readerPath = path.join(INSTITUTIONS_DIR, `${slug}.js`);
  const connectorPath = path.join(CONNECTORS_DIR, `${slug}.js`);
  if (fs.existsSync(readerPath)) {
    try {
      const config = require(readerPath);
      if (config.institution !== slug) {
        errors.push(`readers/institutions/${slug}.js: institution property is "${config.institution}", expected "${slug}"`);
      }
    } catch (e) {
      errors.push(`readers/institutions/${slug}.js: failed to load — ${e.message}`);
    }
  } else if (fs.existsSync(connectorPath)) {
    // API connector — no institution property to check, just existence is sufficient
  } else {
    errors.push(`No config found for "${slug}" in readers/institutions/ or connectors/`);
  }

  // 2. Sync output institution field
  const syncPath = path.join(SYNC_OUTPUT_DIR, `${slug}.json`);
  if (fs.existsSync(syncPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(syncPath, 'utf-8'));
      if (data.institution && data.institution !== slug) {
        errors.push(`data/sync-output/${slug}.json: institution field is "${data.institution}", expected "${slug}"`);
      }
    } catch (e) {
      errors.push(`data/sync-output/${slug}.json: failed to parse — ${e.message}`);
    }
  }

  // 3. Accounts registry
  const accounts = loadJSON(ACCOUNTS_PATH);
  if (accounts && accounts[slug] !== undefined) {
    // Key matches — ok (there's no nested institution field to check)
  }

  // 4. Data semantics — check that if an entry exists, the key matches the slug
  const semantics = loadJSON(SEMANTICS_PATH);
  if (semantics?.institutions) {
    // Check for the slug key — also flag if a variant (no hyphens) exists instead
    const slugNormalized = slug.replace(/-/g, '');
    for (const key of Object.keys(semantics.institutions)) {
      if (key !== slug && key === slugNormalized) {
        errors.push(`config/data-semantics.json: key "${key}" should be "${slug}" (slug uses hyphens)`);
      }
    }
  }

  // 5. Credential map
  const credMap = loadJSON(CREDENTIAL_MAP_PATH);
  if (credMap && credMap[slug] !== undefined) {
    // Key matches — ok
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Validate all institution slugs and detect orphaned sync output files.
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateAllSlugs() {
  const allErrors = [];

  // Discover all institution slugs from config files + connectors
  const configFiles = fs.readdirSync(INSTITUTIONS_DIR)
    .filter(f => f.endsWith('.js') && !fs.statSync(path.join(INSTITUTIONS_DIR, f)).isDirectory());
  const connectorFiles = fs.existsSync(CONNECTORS_DIR)
    ? fs.readdirSync(CONNECTORS_DIR).filter(f => f.endsWith('.js'))
    : [];
  const slugs = [...new Set([
    ...configFiles.map(f => f.replace('.js', '')),
    ...connectorFiles.map(f => f.replace('.js', '')),
  ])];

  // Validate each slug
  for (const slug of slugs) {
    const { errors } = validateSlug(slug);
    allErrors.push(...errors);
  }

  // Detect orphaned sync output files
  if (fs.existsSync(SYNC_OUTPUT_DIR)) {
    const syncFiles = fs.readdirSync(SYNC_OUTPUT_DIR)
      .filter(f => f.endsWith('.json') && !f.endsWith('.result.json'));
    for (const file of syncFiles) {
      const fileslug = file.replace('.json', '');
      const hasConfig = fs.existsSync(path.join(INSTITUTIONS_DIR, `${fileslug}.js`))
        || fs.existsSync(path.join(CONNECTORS_DIR, `${fileslug}.js`));
      if (!hasConfig) {
        allErrors.push(`data/sync-output/${file}: orphaned — no matching config in readers/institutions/ or connectors/`);
      }
    }
  }

  // Check data-semantics keys against known slugs (cross-reference check,
  // not covered by per-slug validateSlug which only catches variants of that slug)
  const semantics = loadJSON(SEMANTICS_PATH);
  if (semantics?.institutions) {
    const alreadyFlagged = new Set(allErrors.map(e => e));
    for (const key of Object.keys(semantics.institutions)) {
      const hasConfig = fs.existsSync(path.join(INSTITUTIONS_DIR, `${key}.js`))
        || fs.existsSync(path.join(CONNECTORS_DIR, `${key}.js`));
      if (!hasConfig) {
        const hyphenated = slugs.find(s => s.replace(/-/g, '') === key);
        const msg = hyphenated
          ? `config/data-semantics.json: key "${key}" should be "${hyphenated}" (slug uses hyphens)`
          : `config/data-semantics.json: key "${key}" has no matching institution config`;
        if (!alreadyFlagged.has(msg)) {
          allErrors.push(msg);
        }
      }
    }
  }

  return { ok: allErrors.length === 0, errors: allErrors };
}

// CLI mode
if (require.main === module) {
  const slug = process.argv[2];

  if (slug) {
    console.log(`Validating slug: ${slug}\n`);
    const { ok, errors } = validateSlug(slug);
    if (ok) {
      console.log(`  ✓ ${slug}: all checks passed`);
    } else {
      errors.forEach(e => console.log(`  ✗ ${e}`));
    }
    process.exit(ok ? 0 : 1);
  }

  console.log('Slug Immutability Audit\n');
  const { ok, errors } = validateAllSlugs();
  if (ok) {
    console.log('  ✓ All slugs consistent — no mismatches or orphans');
  } else {
    errors.forEach(e => console.log(`  ✗ ${e}`));
    console.log(`\n${errors.length} issue(s) found`);
  }
  process.exit(ok ? 0 : 1);
}

module.exports = { validateSlug, validateAllSlugs };
