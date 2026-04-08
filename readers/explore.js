#!/usr/bin/env node
/**
 * Page Explorer — Reconnaissance tool for building bank reader configs.
 *
 * Opens a bank URL with a persistent Chrome profile, then inspects:
 *   1. Page state (URL, title, frames)
 *   2. All input fields, buttons, and forms (main page + iframes)
 *   3. Visible text content
 *   4. Screenshots
 *
 * Usage:
 *   node readers/explore.js <url> [--profile <name>] [--wait <ms>]
 *
 * Examples:
 *   node readers/explore.js https://www.example-bank.com/login
 *   node readers/explore.js https://www.example-bank.com/login --profile mybank --wait 5000
 *
 * The browser stays open after exploration so you can interact manually.
 * Press Ctrl+C to close.
 */

require('@dotenvx/dotenvx').config({ path: require('path').join(__dirname, '..', '.env') });
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PROFILE_BASE = path.join(__dirname, '..', 'data', 'chrome-profile');
const SCREENSHOT_DIR = path.join(__dirname, '..', 'data', 'explore');

const url = process.argv[2];
const profileName = getArg('--profile') || 'explore';
const waitMs = parseInt(getArg('--wait') || '5000');

function getArg(flag) {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}

if (!url) {
  console.error('Usage: node readers/explore.js <url> [--profile <name>] [--wait <ms>]');
  process.exit(1);
}

async function exploreFrame(frame, label, depth = 0) {
  const indent = '  '.repeat(depth);
  const frameUrl = frame.url();

  console.log(`\n${indent}${'='.repeat(60 - depth * 2)}`);
  console.log(`${indent}FRAME: ${label}`);
  console.log(`${indent}URL: ${frameUrl}`);
  console.log(`${indent}${'='.repeat(60 - depth * 2)}`);

  // --- Input fields ---
  const inputs = await frame.$$eval('input', els =>
    els.map(el => ({
      tag: 'input',
      type: el.type || 'text',
      name: el.name || null,
      id: el.id || null,
      placeholder: el.placeholder || null,
      'aria-label': el.getAttribute('aria-label') || null,
      autocomplete: el.autocomplete || null,
      visible: el.offsetParent !== null,
      classes: el.className || null,
      value: el.type === 'hidden' ? el.value : '[redacted]',
    }))
  ).catch(() => []);

  if (inputs.length > 0) {
    console.log(`\n${indent}INPUT FIELDS (${inputs.length}):`);
    for (const input of inputs) {
      const attrs = [];
      if (input.type) attrs.push(`type="${input.type}"`);
      if (input.name) attrs.push(`name="${input.name}"`);
      if (input.id) attrs.push(`id="${input.id}"`);
      if (input.placeholder) attrs.push(`placeholder="${input.placeholder}"`);
      if (input['aria-label']) attrs.push(`aria-label="${input['aria-label']}"`);
      if (input.autocomplete) attrs.push(`autocomplete="${input.autocomplete}"`);
      attrs.push(input.visible ? 'VISIBLE' : 'hidden');
      console.log(`${indent}  <input ${attrs.join(' ')}>`);
      if (input.classes) console.log(`${indent}    classes: ${input.classes}`);
    }
  }

  // --- Buttons ---
  const buttons = await frame.$$eval('button, input[type="submit"], a[role="button"]', els =>
    els.map(el => ({
      tag: el.tagName.toLowerCase(),
      type: el.type || null,
      id: el.id || null,
      text: el.textContent?.trim().substring(0, 80) || null,
      'aria-label': el.getAttribute('aria-label') || null,
      classes: el.className || null,
      visible: el.offsetParent !== null,
    }))
  ).catch(() => []);

  if (buttons.length > 0) {
    console.log(`\n${indent}BUTTONS (${buttons.length}):`);
    for (const btn of buttons) {
      const attrs = [];
      if (btn.type) attrs.push(`type="${btn.type}"`);
      if (btn.id) attrs.push(`id="${btn.id}"`);
      if (btn.text) attrs.push(`text="${btn.text}"`);
      if (btn['aria-label']) attrs.push(`aria-label="${btn['aria-label']}"`);
      attrs.push(btn.visible ? 'VISIBLE' : 'hidden');
      console.log(`${indent}  <${btn.tag} ${attrs.join(' ')}>`);
    }
  }

  // --- Select dropdowns ---
  const selects = await frame.$$eval('select', els =>
    els.map(el => ({
      name: el.name || null,
      id: el.id || null,
      options: Array.from(el.options).map(o => o.text.trim()).slice(0, 10),
      visible: el.offsetParent !== null,
    }))
  ).catch(() => []);

  if (selects.length > 0) {
    console.log(`\n${indent}SELECTS (${selects.length}):`);
    for (const sel of selects) {
      console.log(`${indent}  <select name="${sel.name}" id="${sel.id}" ${sel.visible ? 'VISIBLE' : 'hidden'}>`);
      console.log(`${indent}    options: ${sel.options.join(', ')}`);
    }
  }

  // --- Forms ---
  const forms = await frame.$$eval('form', els =>
    els.map(el => ({
      action: el.action || null,
      method: el.method || null,
      id: el.id || null,
      name: el.name || null,
      classes: el.className || null,
    }))
  ).catch(() => []);

  if (forms.length > 0) {
    console.log(`\n${indent}FORMS (${forms.length}):`);
    for (const form of forms) {
      const attrs = [];
      if (form.id) attrs.push(`id="${form.id}"`);
      if (form.name) attrs.push(`name="${form.name}"`);
      if (form.action) attrs.push(`action="${form.action}"`);
      if (form.method) attrs.push(`method="${form.method}"`);
      console.log(`${indent}  <form ${attrs.join(' ')}>`);
    }
  }

  // --- Visible text (truncated) ---
  const textContent = await frame.evaluate(() => {
    return document.body ? document.body.innerText : '';
  }).catch(() => '');

  if (textContent.length > 0) {
    console.log(`\n${indent}VISIBLE TEXT (${textContent.length} chars, first 2000):`);
    const lines = textContent.split('\n').filter(l => l.trim());
    for (const line of lines.slice(0, 60)) {
      console.log(`${indent}  | ${line.trim().substring(0, 120)}`);
    }
    if (lines.length > 60) {
      console.log(`${indent}  | ... (${lines.length - 60} more lines)`);
    }
  }

  // --- Child iframes ---
  const iframes = await frame.$$eval('iframe', els =>
    els.map(el => ({
      src: el.src || null,
      id: el.id || null,
      name: el.name || null,
      title: el.title || null,
      width: el.width || null,
      height: el.height || null,
    }))
  ).catch(() => []);

  if (iframes.length > 0) {
    console.log(`\n${indent}IFRAMES (${iframes.length}):`);
    for (const iframe of iframes) {
      const attrs = [];
      if (iframe.id) attrs.push(`id="${iframe.id}"`);
      if (iframe.name) attrs.push(`name="${iframe.name}"`);
      if (iframe.src) attrs.push(`src="${iframe.src}"`);
      if (iframe.title) attrs.push(`title="${iframe.title}"`);
      console.log(`${indent}  <iframe ${attrs.join(' ')}>`);
    }
  }
}

async function main() {
  const profilePath = path.join(PROFILE_BASE, profileName);
  if (!fs.existsSync(profilePath)) fs.mkdirSync(profilePath, { recursive: true });
  if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  console.log(`Opening ${url}`);
  console.log(`Profile: ${profilePath}`);
  console.log(`Wait: ${waitMs}ms before exploring`);
  console.log('');

  const context = await chromium.launchPersistentContext(profilePath, {
    headless: false,
    viewport: { width: 1280, height: 720 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = context.pages()[0] || await context.newPage();

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  console.log(`Page loaded. Waiting ${waitMs}ms for JS/iframes to settle...\n`);
  await page.waitForTimeout(waitMs);

  // Screenshot
  const screenshotPath = path.join(SCREENSHOT_DIR, `${profileName}-${Date.now()}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log(`Screenshot saved: ${screenshotPath}`);

  // Explore main page
  await exploreFrame(page, 'MAIN PAGE', 0);

  // Explore all child frames
  const frames = page.frames();
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (frame === page.mainFrame()) continue;
    await exploreFrame(frame, `CHILD FRAME ${i} (${frame.url()})`, 1);
  }

  console.log('\n' + '='.repeat(60));
  console.log('EXPLORATION COMPLETE');
  console.log('Browser is still open — interact manually if needed.');
  console.log('Press Ctrl+C to close.');
  console.log('='.repeat(60));

  // Keep the process alive
  await new Promise(() => {});
}

main().catch(err => {
  console.error('Explorer error:', err.message);
  process.exit(1);
});
