#!/usr/bin/env node
/**
 * Send a command to the interactive explorer and wait for the result.
 *
 * Usage:
 *   node readers/explore-cmd.js <bank> screenshot
 *   node readers/explore-cmd.js <bank> click 5
 *   node readers/explore-cmd.js <bank> type 3 "{{USERNAME}}"
 *   node readers/explore-cmd.js <bank> type 7 "{{PASSWORD}}"
 *   node readers/explore-cmd.js <bank> frame 100          # switch into iframe [100]
 *   node readers/explore-cmd.js <bank> frame main         # back to main page
 *   node readers/explore-cmd.js <bank> scroll down 500
 *   node readers/explore-cmd.js <bank> key Enter
 *   node readers/explore-cmd.js <bank> wait 5000
 *   node readers/explore-cmd.js <bank> dismiss
 *   node readers/explore-cmd.js <bank> navigate https://...
 *   node readers/explore-cmd.js <bank> back
 *   node readers/explore-cmd.js <bank> evaluate "document.querySelector('button').click()"
 *   node readers/explore-cmd.js <bank> done
 */

const fs = require('fs');
const path = require('path');

const bank = process.argv[2];
const action = process.argv[3];
const args = process.argv.slice(4);

if (!bank || !action) {
  console.error('Usage: node readers/explore-cmd.js <bank> <action> [args...]');
  console.error('Actions: screenshot, click, type, scroll, navigate, frame, key, wait, dismiss, back, evaluate, done');
  process.exit(1);
}

const EXPLORE_DIR = path.join(__dirname, '..', 'data', 'explore');
const commandFile = path.join(EXPLORE_DIR, `${bank}-command.json`);
const stateFile = path.join(EXPLORE_DIR, `${bank}-state.json`);

async function main() {
  // Verify explorer is running
  let currentStep = -1;
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    currentStep = state.step;
    if (!state.ready) {
      console.log('Explorer is still processing the previous command. Waiting...');
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        try {
          const s = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
          if (s.ready) { currentStep = s.step; break; }
        } catch {}
        await new Promise(r => setTimeout(r, 300));
      }
    }
  } catch {
    console.error(`Explorer not running for "${bank}". Start it first:`);
    console.error(`  node readers/explore-interactive.js ${bank} <url> [usernameEnv] [passwordEnv]`);
    process.exit(1);
  }

  // Build command object
  const cmd = { action };
  switch (action) {
    case 'click':
      cmd.element = parseInt(args[0]);
      if (isNaN(cmd.element)) { console.error('click requires element number: click <N>'); process.exit(1); }
      break;
    case 'type':
      cmd.element = parseInt(args[0]);
      cmd.text = args.slice(1).join(' ');
      if (isNaN(cmd.element) || !cmd.text) { console.error('type requires element and text: type <N> <text>'); process.exit(1); }
      break;
    case 'scroll':
      cmd.direction = args[0] || 'down';
      cmd.amount = parseInt(args[1]) || 300;
      break;
    case 'navigate':
      cmd.url = args[0];
      if (!cmd.url) { console.error('navigate requires URL'); process.exit(1); }
      break;
    case 'frame':
      cmd.element = args[0] === 'main' ? 'main' : parseInt(args[0]);
      break;
    case 'key':
      cmd.key = args[0] || 'Enter';
      break;
    case 'wait':
      cmd.ms = parseInt(args[0]) || 3000;
      break;
    case 'evaluate':
      cmd.code = args.join(' ');
      if (!cmd.code) { console.error('evaluate requires JS code'); process.exit(1); }
      break;
    case 'screenshot':
    case 'dismiss':
    case 'back':
    case 'done':
      break;
    default:
      console.error(`Unknown action: ${action}`);
      process.exit(1);
  }

  // Write command file
  fs.writeFileSync(commandFile, JSON.stringify(cmd));

  if (action === 'done') {
    console.log('Done. Explorer will close and save history.');
    process.exit(0);
  }

  // Wait for state to update (step increments + ready flag)
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      if (state.step > currentStep && state.ready) {
        printState(state);
        process.exit(0);
      }
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }

  console.error('Timeout (30s). Explorer may still be processing. Check the state file manually.');
  process.exit(1);
}

function printState(state) {
  console.log(`\n─── Step ${state.step} ───────────────────────────────────────`);
  console.log(`URL:        ${state.url}`);
  console.log(`Screenshot: ${state.screenshot}`);
  console.log(`Title:      ${state.title} (${state.textLength} chars)`);

  if (state.error) {
    console.log(`\n⚠ ERROR: ${state.error}`);
  }

  if (state.elements.length > 0) {
    console.log(`\nInteractive elements (${state.elements.length}):`);
    for (const el of state.elements) {
      const desc = (el.text || el.ariaLabel || '').substring(0, 42);
      console.log(`  [${String(el.n).padStart(2)}] ${el.tag.padEnd(7)} ${desc.padEnd(44)} ${el.selector}`);
    }
  }

  if (state.inputs.length > 0) {
    console.log(`\nForm inputs (${state.inputs.length}):`);
    for (const el of state.inputs) {
      const desc = el.placeholder || el.name || el.ariaLabel || el.type || '';
      console.log(`  [${String(el.n).padStart(2)}] ${(el.tag + '[' + (el.type || '') + ']').padEnd(16)} ${desc.padEnd(30)} ${el.selector}`);
    }
  }

  if (state.iframes.length > 0) {
    console.log(`\nIframes (${state.iframes.length}):`);
    for (const f of state.iframes) {
      console.log(`  [${f.n}] ${f.url.substring(0, 80)}${f.hasInputs ? '  ← has inputs' : ''}`);
    }
  }

  if (state.currentFrame !== null) {
    console.log(`\n📌 Currently inside frame #${100 + state.currentFrame}`);
  }

  if (state.textPreview) {
    const preview = state.textPreview.substring(0, 200).replace(/\n/g, ' ').trim();
    console.log(`\nText: ${preview}${state.textLength > 200 ? '...' : ''}`);
  }
}

main();
