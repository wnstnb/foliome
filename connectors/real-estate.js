#!/usr/bin/env node
/**
 * Real Estate Valuation Connector
 *
 * Uses Playwright to visit Zillow and Redfin directly, extract property estimates,
 * and average them for a home value.
 *
 * Usage:
 *   node connectors/real-estate.js
 */

require('@dotenvx/dotenvx').config({ path: require('path').join(__dirname, '..', '.env') });
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ADDRESS = process.env.HOME_RESIDENCE_ADDRESS;
const OUTPUT_DIR = path.join(__dirname, '..', 'data', 'sync-output');
const PROFILE_DIR = path.join(__dirname, '..', 'data', 'chrome-profile', 'real-estate');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });

if (!ADDRESS) {
  console.error('[real-estate] HOME_RESIDENCE_ADDRESS not set in .env');
  process.exit(1);
}

const REFRESH_DAYS = 25; // Only re-estimate if last sync is older than this
const forceRefresh = process.argv.includes('--force');

// Check if we need to refresh
if (!forceRefresh) {
  const outputFile = path.join(OUTPUT_DIR, 'real-estate.json');
  if (fs.existsSync(outputFile)) {
    try {
      const existing = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
      if (existing.syncedAt) {
        const daysSinceSync = (Date.now() - new Date(existing.syncedAt).getTime()) / (24 * 60 * 60 * 1000);
        if (daysSinceSync < REFRESH_DAYS) {
          const value = existing.balances?.[0]?.balance || 0;
          console.log(`[real-estate] Last synced ${daysSinceSync.toFixed(1)} days ago — skipping (refresh after ${REFRESH_DAYS} days)`);
          console.log(`[real-estate] Current estimate: $${value.toLocaleString()}`);
          console.log(`[real-estate] Use --force to override`);
          process.exit(0);
        }
      }
    } catch {}
  }
}

// Build search-friendly address slug
const addressSlug = ADDRESS.replace(/[,#]/g, '').replace(/\s+/g, '-').toLowerCase();

async function capturePageText(page, source) {
  const pageText = await page.evaluate(() => document.body.innerText);

  if (pageText.length < 100) {
    console.log(`[real-estate]   ${source}: page too short (${pageText.length} chars)`);
    return null;
  }

  console.log(`[real-estate]   ${source}: captured ${pageText.length} chars`);
  return { source, text: pageText.substring(0, 6000) };
}

async function main() {
  console.log(`[real-estate] Estimating value for: ${ADDRESS}\n`);

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const results = [];

  // === GOOGLE SEARCH → find Zillow and Redfin links ===
  console.log('[real-estate] Searching Google...');
  const page = await ctx.newPage();
  try {
    await page.goto(`https://www.google.com/search?q=${encodeURIComponent(ADDRESS + ' home value estimate')}`, {
      waitUntil: 'domcontentloaded', timeout: 15000,
    });
    await page.waitForTimeout(3000);

    // Capture Google's page text (may contain a value card)
    const googleResult = await capturePageText(page, 'Google');
    if (googleResult) {
      results.push(googleResult);
    }
  } catch (e) {
    console.log(`[real-estate]   Google search failed: ${e.message.substring(0, 60)}`);
  }

  // === ZILLOW (via Google) ===
  console.log('[real-estate] Checking Zillow...');
  try {
    const zillowPage = await ctx.newPage();
    await zillowPage.goto(`https://www.google.com/search?q=${encodeURIComponent(ADDRESS + ' zillow')}`, {
      waitUntil: 'domcontentloaded', timeout: 15000,
    });
    await zillowPage.waitForTimeout(3000);

    // Click first Zillow result
    const zillowLink = zillowPage.locator('a[href*="zillow.com/homedetails"]').first();
    if (await zillowLink.count() > 0) {
      await zillowLink.click();
      await zillowPage.waitForTimeout(5000);
      try { await zillowPage.locator('button:has-text("Accept")').first().click({ timeout: 2000 }); } catch {}
      try { await zillowPage.locator('[aria-label="Close"]').first().click({ timeout: 1000 }); } catch {}

      const zillowResult = await capturePageText(zillowPage, 'Zillow');
      if (zillowResult) {
        results.push(zillowResult);
      } else {
        console.log('[real-estate]   Zillow: no text captured');
      }
    } else {
      console.log('[real-estate]   Zillow: no Google result found');
    }
    await zillowPage.close();
  } catch (e) {
    console.log(`[real-estate]   Zillow failed: ${e.message.substring(0, 60)}`);
  }

  // === REDFIN (via Google) ===
  console.log('[real-estate] Checking Redfin...');
  try {
    const redfinPage = await ctx.newPage();
    await redfinPage.goto(`https://www.google.com/search?q=${encodeURIComponent(ADDRESS + ' redfin')}`, {
      waitUntil: 'domcontentloaded', timeout: 15000,
    });
    await redfinPage.waitForTimeout(3000);

    // Click first Redfin result
    const redfinLink = redfinPage.locator('a[href*="redfin.com"]').first();
    if (await redfinLink.count() > 0) {
      await redfinLink.click();
      await redfinPage.waitForTimeout(5000);

      const redfinResult = await capturePageText(redfinPage, 'Redfin');
      if (redfinResult) {
        results.push(redfinResult);
      } else {
        console.log('[real-estate]   Redfin: no text captured');
      }
    } else {
      console.log('[real-estate]   Redfin: no Google result found');
    }
    await redfinPage.close();
  } catch (e) {
    console.log(`[real-estate]   Redfin failed: ${e.message.substring(0, 60)}`);
  }

  await ctx.close();

  // === RESULTS ===
  console.log(`\n[real-estate] Captured text from ${results.length} sources`);

  if (results.length === 0) {
    console.log('[real-estate] No page texts captured');
    return;
  }

  for (const r of results) {
    console.log(`  ${r.source.padEnd(12)} ${r.text.length} chars`);
  }

  // Load existing output to preserve previous values during pending extraction
  const outputFile = path.join(OUTPUT_DIR, 'real-estate.json');
  let existingBalances = [];
  try {
    if (fs.existsSync(outputFile)) {
      const existing = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
      existingBalances = existing.balances || [];
    }
  } catch {}

  // Write output with raw texts for agent extraction
  const output = {
    institution: 'real-estate',
    syncedAt: new Date().toISOString(),
    balances: existingBalances, // Preserve previous values until agent extracts new ones
    transactions: [],
    holdings: [],
    pendingExtraction: {
      address: ADDRESS,
      pageTexts: results, // Array of { source, text }
    },
  };

  fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
  console.log(`\n[real-estate] Page texts saved — pending agent extraction`);
}

main().catch(err => {
  console.error('[real-estate] Error:', err.message);
  process.exit(1);
});
