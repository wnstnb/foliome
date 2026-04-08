/**
 * Adaptive Bridge — file-based protocol for visual help with unknown page states.
 *
 * When run.js encounters a page it can't identify (not login, not dashboard, not known MFA),
 * it writes a request file with an annotated screenshot and element list. The orchestrating
 * agent (or a Haiku sub-agent) reads the screenshot, reasons about the page, and writes back
 * instructions. After resolution, run.js writes a "learned" file so the config can be updated.
 *
 * File protocol:
 *   data/adaptive-pending/<institution>.request.json    — run.js writes (screenshot + elements)
 *   data/adaptive-pending/<institution>.instruction.json — agent writes (actions to take)
 *   data/adaptive-pending/<institution>.learned.json     — run.js writes (discovered patterns)
 *   data/adaptive-pending/<institution>-screenshot.png   — annotated screenshot
 */

const fs = require('fs');
const path = require('path');

const ADAPTIVE_DIR = path.join(__dirname, '..', 'data', 'adaptive-pending');
if (!fs.existsSync(ADAPTIVE_DIR)) fs.mkdirSync(ADAPTIVE_DIR, { recursive: true });

/**
 * Request visual help for an unknown page state.
 * @param {string} institution
 * @param {Object} stateData — { screenshot, url, pageText, elements, inputs, iframes }
 */
function requestHelp(institution, stateData) {
  const requestFile = path.join(ADAPTIVE_DIR, `${institution}.request.json`);
  const payload = {
    type: 'unknown-state',
    institution,
    timestamp: new Date().toISOString(),
    ...stateData,
    message: `${institution.toUpperCase()} — unknown page state after login. Screenshot and element list attached.`,
  };
  fs.writeFileSync(requestFile, JSON.stringify(payload, null, 2));
  console.log(`[adaptive] Help requested for ${institution}: ${payload.message}`);
}

/**
 * Request help for a task-phase error (balances/transactions failed).
 * @param {string} institution
 * @param {Object} errorContext — from recovery.captureErrorContext()
 */
function requestTaskErrorHelp(institution, errorContext) {
  const requestFile = path.join(ADAPTIVE_DIR, `${institution}.request.json`);
  const payload = {
    type: 'task-error',
    institution,
    timestamp: new Date().toISOString(),
    ...errorContext,
    message: `${institution.toUpperCase()} — task "${errorContext.task}" failed at step "${errorContext.step}". ${errorContext.error.category}: ${errorContext.error.message.substring(0, 200)}`,
  };
  fs.writeFileSync(requestFile, JSON.stringify(payload, null, 2));
  console.log(`[adaptive] Task error help requested for ${institution}: ${payload.message}`);
}

/**
 * Wait for instruction from the orchestrating agent.
 * @param {string} institution
 * @param {number} timeoutMs
 * @returns {Promise<Object|null>} instruction object or null on timeout
 */
async function waitForInstruction(institution, timeoutMs = 300000) {
  const instructionFile = path.join(ADAPTIVE_DIR, `${institution}.instruction.json`);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (fs.existsSync(instructionFile)) {
      try {
        const instruction = JSON.parse(fs.readFileSync(instructionFile, 'utf-8'));
        fs.unlinkSync(instructionFile);
        console.log(`[adaptive] Instruction received for ${institution}`);
        return instruction;
      } catch {
        try { fs.unlinkSync(instructionFile); } catch {}
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`[adaptive] Timeout waiting for instruction (${institution})`);
  return null;
}

/**
 * Submit instruction (called by the orchestrating agent).
 * @param {string} institution
 * @param {Object} instruction — { actions: [...], mfaType?, mfaPatterns?, ... }
 */
function submitInstruction(institution, instruction) {
  const instructionFile = path.join(ADAPTIVE_DIR, `${institution}.instruction.json`);
  fs.writeFileSync(instructionFile, JSON.stringify(instruction, null, 2));
  console.log(`[adaptive] Instruction submitted for ${institution}`);
}

/**
 * Write discovered patterns after successful resolution.
 * @param {string} institution
 * @param {Object} patterns — { mfaType, mfaPatterns, selectors, pageTextSnippet }
 */
function writeLearnedPatterns(institution, patterns) {
  const learnedFile = path.join(ADAPTIVE_DIR, `${institution}.learned.json`);
  const payload = {
    institution,
    timestamp: new Date().toISOString(),
    ...patterns,
  };
  fs.writeFileSync(learnedFile, JSON.stringify(payload, null, 2));
  console.log(`[adaptive] Learned patterns saved for ${institution}`);
}

/**
 * Check if any institution needs adaptive help.
 * @returns {Array<Object>} pending requests
 */
function getPendingAdaptiveRequests() {
  const pending = [];
  try {
    const files = fs.readdirSync(ADAPTIVE_DIR).filter(f => f.endsWith('.request.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(ADAPTIVE_DIR, file), 'utf-8'));
        pending.push(data);
      } catch {}
    }
  } catch {}
  return pending;
}

/**
 * Clean up all pending files for an institution.
 */
function cleanup(institution) {
  const patterns = ['.request.json', '.instruction.json', '-screenshot.png', '-task-error.png'];
  for (const suffix of patterns) {
    try { fs.unlinkSync(path.join(ADAPTIVE_DIR, `${institution}${suffix}`)); } catch {}
  }
}

module.exports = {
  requestHelp,
  requestTaskErrorHelp,
  waitForInstruction,
  submitInstruction,
  writeLearnedPatterns,
  getPendingAdaptiveRequests,
  cleanup,
};
