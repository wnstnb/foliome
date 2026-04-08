#!/usr/bin/env node
/**
 * Transaction Classifier
 *
 * Two classifiers:
 *   1. Day-to-day transactions: merchant rules → bank category mapping → fine-tuned model → cache
 *   2. Investment transactions: type rules only (no model needed)
 *
 * Usage:
 *   node sync-engine/classify.js              # classify all unclassified
 *   node sync-engine/classify.js --force      # reclassify everything (except user overrides)
 *   node sync-engine/classify.js --stats      # show classification stats
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'foliome.db');
const OVERRIDES_PATH = path.join(__dirname, '..', 'config', 'category-overrides.json');
const CACHE_PATH = path.join(__dirname, '..', 'data', 'merchant-category-cache.json');

const forceReclassify = process.argv.includes('--force');
const statsOnly = process.argv.includes('--stats');

// Load overrides config
function loadOverrides() {
  try {
    return JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf-8'));
  } catch {
    return { merchantRules: [], bankCategoryMappings: {}, categories: [] };
  }
}

// Load/save merchant cache (model results cached by normalized merchant name)
function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

/**
 * Normalize merchant description for cache key grouping.
 * Strip numbers, locations, transaction IDs — keep the merchant name.
 * Used only for dedup/caching, NOT for model input (model gets full description).
 */
function normalizeMerchant(description) {
  return description
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/\d{4,}/g, '')       // strip long numbers (transaction IDs, phone numbers)
    .replace(/#\d+/g, '')         // strip #123 store numbers
    .replace(/\s{2,}/g, ' ')
    .trim()
    .substring(0, 80);            // cache key length — enough for dedup without over-collapsing
}

/**
 * Check merchant rules for a match.
 * Returns category if a rule matches, null otherwise.
 */
function matchRule(description, merchantRules) {
  const upper = description.toUpperCase();
  for (const [pattern, category] of Object.entries(merchantRules)) {
    if (upper.includes(pattern.toUpperCase())) {
      return category;
    }
  }
  return null;
}

// === Day-to-Day Classifier ===

async function classifyDayToDay(db) {
  const overrides = loadOverrides();
  const cache = loadCache();
  const categories = overrides.default_categories;
  const merchantRules = overrides.merchant_rules || {};
  const bankCategoryMapping = overrides.bank_category_mapping || {};

  // Confidence threshold: model results above this are used directly.
  // Below this, we check if the bank provided a usable category as fallback.
  const MODEL_CONFIDENCE_THRESHOLD = 0.70;

  // Account types where the account itself determines the category.
  // These skip the model entirely — the transaction category is implied by the account type.
  const ACCOUNT_TYPE_CATEGORIES = {
    mortgage: 'Mortgage',
    auto_loan: 'Transportation',
    student_loan: 'Education',
    personal_loan: 'Transfer',
    heloc: 'Transfer',
    cd: 'Income',
  };

  // Account types that run through the full classification pipeline.
  // checking, savings, credit, hsa, fsa, prepaid, money_market
  // (any type NOT in ACCOUNT_TYPE_CATEGORIES goes through the model)

  // Get transactions that need classification
  const whereClause = forceReclassify
    ? "WHERE (category_source IS NULL OR category_source != 'user_override')"
    : "WHERE user_category IS NULL";

  const txns = db.prepare(`SELECT id, description, category, amount, account_type FROM transactions ${whereClause}`).all();

  if (txns.length === 0) {
    console.log('[classify] No day-to-day transactions to classify');
    return;
  }

  console.log(`[classify] Classifying ${txns.length} day-to-day transactions...`);

  // Phase 0: Account-type-implied classifications
  let accountTypeClassified = 0;
  const accountTypeStmt = db.prepare(`
    UPDATE transactions SET user_category = ?, category_source = 'account_type', category_confidence = 1.0, updated_at = datetime('now')
    WHERE id = ?
  `);
  const remainingTxns = [];
  const applyAccountType = db.transaction(() => {
    for (const txn of txns) {
      const impliedCategory = ACCOUNT_TYPE_CATEGORIES[txn.account_type];
      if (impliedCategory) {
        accountTypeStmt.run(impliedCategory, txn.id);
        accountTypeClassified++;
      } else {
        remainingTxns.push(txn);
      }
    }
  });
  applyAccountType();

  if (accountTypeClassified > 0) {
    console.log(`[classify]   Account type implied: ${accountTypeClassified}`);
  }

  const updateStmt = db.prepare(`
    UPDATE transactions SET user_category = ?, category_source = ?, category_confidence = ?, updated_at = datetime('now')
    WHERE id = ?
  `);

  let ruleMatches = 0;
  let cacheHits = 0;
  let bankFallbacks = 0;
  let modelNeeded = [];

  /**
   * Try to resolve a bank category to one of our normalized categories.
   * Returns the mapped category or null if the bank category is unusable.
   */
  function resolveBankCategory(bankCat) {
    if (!bankCat) return null;
    // Direct match to our categories
    if (categories.includes(bankCat)) return bankCat;
    // Mapped match (e.g., "Food & Drink" → "Restaurants")
    const mapped = bankCategoryMapping[bankCat];
    if (mapped) return mapped;
    return null;
  }

  // Tier 1: User rules (highest priority)
  // Tier 2: Model cache (fast model — same result as live inference)
  // Remaining: need live model inference
  const applyRules = db.transaction(() => {
    for (const txn of remainingTxns) {
      const signPrefix = txn.amount >= 0 ? '[credit]' : '[debit]';

      // Tier 1: Merchant/pattern rules (user-defined overrides — highest trust)
      const ruleCategory = matchRule(txn.description, merchantRules);
      if (ruleCategory) {
        updateStmt.run(ruleCategory, 'rule', null, txn.id);
        ruleMatches++;
        continue;
      }

      // Tier 2: Model cache (previous model results, checked before live inference)
      const normalized = normalizeMerchant(txn.description);
      const cacheKey = `${signPrefix}:${normalized}`;
      if (cache[cacheKey]) {
        const cached = cache[cacheKey];
        // If model confidence is high, use it directly
        if (cached.confidence >= MODEL_CONFIDENCE_THRESHOLD) {
          updateStmt.run(cached.category, 'model', cached.confidence, txn.id);
          cacheHits++;
          continue;
        }
        // Low confidence — check if bank has a usable category
        const bankCat = resolveBankCategory(txn.category);
        if (bankCat) {
          updateStmt.run(bankCat, 'bank', null, txn.id);
          bankFallbacks++;
          continue;
        }
        // Bank can't help either — use the model's low-confidence result
        updateStmt.run(cached.category, 'model', cached.confidence, txn.id);
        cacheHits++;
        continue;
      }

      // Tier 3: Need live model classification
      modelNeeded.push({ id: txn.id, description: txn.description, category: txn.category, normalized, signPrefix, cacheKey });
    }
  });
  applyRules();

  console.log(`[classify]   Rules: ${ruleMatches}, Cache: ${cacheHits}, Bank fallback: ${bankFallbacks}, Need model: ${modelNeeded.length}`);

  // Tier 3: Run fine-tuned classifier on remaining transactions
  if (modelNeeded.length > 0) {
    // Deduplicate by cacheKey for model inference, but keep per-txn bank categories for fallback
    const uniqueMerchants = {};
    const txnBankCategories = {}; // id → bank category for fallback
    for (const txn of modelNeeded) {
      if (!uniqueMerchants[txn.cacheKey]) {
        // Store the first full description as the representative for model input
        uniqueMerchants[txn.cacheKey] = { signPrefix: txn.signPrefix, fullDescription: txn.description, ids: [] };
      }
      uniqueMerchants[txn.cacheKey].ids.push(txn.id);
      txnBankCategories[txn.id] = txn.category; // raw bank category
    }

    const merchantList = Object.keys(uniqueMerchants);
    console.log(`[classify]   ${merchantList.length} unique merchants to classify with model...`);

    // Load the transaction classifier
    // Default: fine-tuned DistilBERT from DoDataThings/distilbert-us-transaction-classifier-v2
    // To use a custom model, place it in data/models/<name>-onnx/ with ONNX weights + tokenizer
    const modelPath = require('path');
    const { pipeline, env } = require('@xenova/transformers');
    const localModelDir = modelPath.resolve(__dirname, '..', 'data', 'models');
    const modelName = 'foliome-classifier-v2-onnx';
    const modelExists = fs.existsSync(path.join(localModelDir, modelName, 'onnx'));

    let classifier;
    if (modelExists) {
      env.localModelPath = localModelDir;
      env.allowRemoteModels = false;
      console.log('[classify]   Loading local transaction classifier...');
      classifier = await pipeline('text-classification', modelName);
    } else {
      console.log('[classify]   Local model not found. Downloading from HuggingFace...');
      console.log('[classify]   Model: DoDataThings/distilbert-us-transaction-classifier-v2');
      console.log('[classify]   To use a custom model, place ONNX files in data/models/foliome-classifier-v2-onnx/');
      classifier = await pipeline('text-classification', 'DoDataThings/distilbert-us-transaction-classifier-v2');
      console.log('[classify]   Model downloaded and cached.');
    }
    console.log('[classify]   Model loaded');

    let modelClassified = 0;
    let modelBankFallbacks = 0;
    const batchUpdate = db.transaction((results) => {
      for (const { cacheKey, category, confidence, ids } of results) {
        // Always cache the model result regardless of confidence
        cache[cacheKey] = { category, confidence };
        for (const id of ids) {
          // High confidence — use model result
          if (confidence >= MODEL_CONFIDENCE_THRESHOLD) {
            updateStmt.run(category, 'model', confidence, id);
            modelClassified++;
            continue;
          }
          // Low confidence — try bank fallback
          const bankCat = resolveBankCategory(txnBankCategories[id]);
          if (bankCat) {
            updateStmt.run(bankCat, 'bank', null, id);
            modelBankFallbacks++;
            continue;
          }
          // Bank can't help — use model's low-confidence result
          updateStmt.run(category, 'model', confidence, id);
          modelClassified++;
        }
      }
    });

    // Classify in batches
    const results = [];
    for (let i = 0; i < merchantList.length; i++) {
      const cacheKey = merchantList[i];
      const { signPrefix, fullDescription, ids } = uniqueMerchants[cacheKey];
      const modelInput = `${signPrefix} ${fullDescription}`;
      try {
        const result = await classifier(modelInput);
        const topCategory = result[0].label;
        const topScore = result[0].score;
        results.push({
          cacheKey,
          category: topCategory,
          confidence: Math.round(topScore * 100) / 100,
          ids,
        });

        if ((i + 1) % 10 === 0 || i === merchantList.length - 1) {
          process.stdout.write(`\r[classify]   Classified ${i + 1}/${merchantList.length} merchants`);
        }
      } catch (e) {
        console.warn(`\n[classify]   Failed to classify "${modelInput}": ${e.message.substring(0, 60)}`);
      }
    }
    console.log('');

    batchUpdate(results);
    saveCache(cache);
    console.log(`[classify]   Model classified ${modelClassified} transactions, bank fallback: ${modelBankFallbacks} (${merchantList.length} unique merchants cached)`);
  }
}

// === Investment Classifier ===

function classifyInvestments(db) {
  const overrides = loadOverrides();
  const typeRules = overrides.investment_type_rules || {};

  const whereClause = forceReclassify
    ? "WHERE (category_source IS NULL OR category_source != 'user_override')"
    : "WHERE user_category IS NULL";

  const txns = db.prepare(`SELECT id, type, description FROM investment_transactions ${whereClause}`).all();

  if (txns.length === 0) {
    console.log('[classify] No investment transactions to classify');
    return;
  }

  console.log(`[classify] Classifying ${txns.length} investment transactions...`);

  const updateStmt = db.prepare(`
    UPDATE investment_transactions SET user_category = ?, category_source = ?, updated_at = datetime('now')
    WHERE id = ?
  `);

  let classified = 0;
  const applyRules = db.transaction(() => {
    for (const txn of txns) {
      // Match against type rules
      let category = null;

      // Exact match on type field
      if (txn.type && typeRules[txn.type]) {
        category = typeRules[txn.type];
      }

      // Partial match on description
      if (!category) {
        for (const [pattern, cat] of Object.entries(typeRules)) {
          if ((txn.type || '').toUpperCase().includes(pattern.toUpperCase()) ||
              (txn.description || '').toUpperCase().includes(pattern.toUpperCase())) {
            category = cat;
            break;
          }
        }
      }

      // Fallback: infer from description
      if (!category) {
        const desc = (txn.description || '').toUpperCase();
        if (desc.includes('BUY') || desc.includes('PURCHASE')) category = 'Buy';
        else if (desc.includes('SELL') || desc.includes('REDEMPTION')) category = 'Sell';
        else if (desc.includes('DIVIDEND')) category = 'Dividend';
        else if (desc.includes('INTEREST')) category = 'Interest';
        else if (desc.includes('CONTRIBUTION')) category = 'Contribution';
        else if (desc.includes('EXCHANGE')) category = 'Rebalance';
        else if (desc.includes('FEE')) category = 'Fee';
        else category = 'Other';
      }

      updateStmt.run(category, 'rule', txn.id);
      classified++;
    }
  });
  applyRules();

  console.log(`[classify]   Classified ${classified} investment transactions via rules`);
}

// === Stats ===

function showStats(db) {
  console.log('\n=== CLASSIFICATION STATS ===');

  console.log('\nDay-to-day transactions:');
  const dayCats = db.prepare(`
    SELECT user_category, category_source, COUNT(*) as cnt
    FROM transactions
    WHERE user_category IS NOT NULL
    GROUP BY user_category, category_source
    ORDER BY cnt DESC
  `).all();

  const unclassified = db.prepare('SELECT COUNT(*) as c FROM transactions WHERE user_category IS NULL').get().c;

  const byCat = {};
  for (const r of dayCats) {
    if (!byCat[r.user_category]) byCat[r.user_category] = { total: 0, sources: {} };
    byCat[r.user_category].total += r.cnt;
    byCat[r.user_category].sources[r.category_source] = r.cnt;
  }

  for (const [cat, data] of Object.entries(byCat).sort((a, b) => b[1].total - a[1].total)) {
    const sources = Object.entries(data.sources).map(([s, c]) => `${s}:${c}`).join(', ');
    console.log(`  ${cat.padEnd(20)} ${String(data.total).padStart(5)}  (${sources})`);
  }
  if (unclassified > 0) console.log(`  ${'UNCLASSIFIED'.padEnd(20)} ${String(unclassified).padStart(5)}`);

  console.log('\nInvestment transactions:');
  const invCats = db.prepare(`
    SELECT user_category, COUNT(*) as cnt
    FROM investment_transactions
    WHERE user_category IS NOT NULL
    GROUP BY user_category
    ORDER BY cnt DESC
  `).all();

  const invUnclassified = db.prepare('SELECT COUNT(*) as c FROM investment_transactions WHERE user_category IS NULL').get().c;

  for (const r of invCats) {
    console.log(`  ${r.user_category.padEnd(20)} ${String(r.cnt).padStart(5)}`);
  }
  if (invUnclassified > 0) console.log(`  ${'UNCLASSIFIED'.padEnd(20)} ${String(invUnclassified).padStart(5)}`);
}

// === Main ===

async function main() {
  const db = new Database(DB_PATH);

  // Add user_category column to investment_transactions if not exists
  try {
    db.exec('ALTER TABLE investment_transactions ADD COLUMN user_category TEXT');
  } catch {} // already exists
  try {
    db.exec('ALTER TABLE investment_transactions ADD COLUMN category_source TEXT');
  } catch {}

  if (statsOnly) {
    showStats(db);
    db.close();
    return;
  }

  await classifyDayToDay(db);
  classifyInvestments(db);
  showStats(db);

  db.close();
}

main().catch(err => {
  console.error('[classify] Error:', err.message);
  process.exit(1);
});
