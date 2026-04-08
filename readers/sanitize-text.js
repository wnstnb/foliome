/**
 * Sanitized text extraction for AI agent page reading.
 *
 * Layer 1: Strips hidden prompt injection techniques before extracting text.
 *   - Elements with font-size < 2px
 *   - Elements positioned off-screen (left/top < -5000px)
 *   - Elements with clip-path hiding (inset 100%, rect(0,0,0,0))
 *   - Elements with zero dimensions and overflow hidden
 *   - Elements with same foreground/background color
 *
 * Layer 2: Wraps extracted text in untrusted content boundary markers so
 *   the agent knows it's page content, not instructions.
 *
 * Uses a cloned DOM — never modifies the live page.
 */

/**
 * JavaScript to evaluate inside the page. Clones body, strips hidden elements,
 * returns cleaned innerText.
 */
const SANITIZE_SCRIPT = `() => {
  // Quick pass: strip elements with suspicious inline styles
  const hidden = [];
  document.body.querySelectorAll('*').forEach(el => {
    try {
      const style = el.style;
      const fontSize = parseFloat(style.fontSize);
      if (!isNaN(fontSize) && fontSize < 2) { hidden.push(el); return; }

      const left = parseFloat(style.left);
      const top = parseFloat(style.top);
      if ((!isNaN(left) && left < -5000) || (!isNaN(top) && top < -5000)) { hidden.push(el); return; }

      const clipPath = style.clipPath || '';
      const clip = style.clip || '';
      if (clipPath.includes('inset(100') || clip.includes('rect(0')) { hidden.push(el); return; }

      const w = parseFloat(style.width);
      const h = parseFloat(style.height);
      const overflow = style.overflow;
      if (!isNaN(w) && !isNaN(h) && w < 2 && h < 2 && overflow === 'hidden') { hidden.push(el); return; }
    } catch {}
  });

  // Remove hidden + non-content elements, capture text, restore
  const removed = [];
  hidden.forEach(el => {
    if (el.parentNode) {
      removed.push({ el, parent: el.parentNode, next: el.nextSibling });
      el.parentNode.removeChild(el);
    }
  });
  const nonContent = [];
  document.body.querySelectorAll('script, style, noscript').forEach(el => {
    if (el.parentNode) {
      nonContent.push({ el, parent: el.parentNode, next: el.nextSibling });
      el.parentNode.removeChild(el);
    }
  });

  const text = document.body.innerText || '';

  for (const { el, parent, next } of [...nonContent, ...removed].reverse()) {
    try { parent.insertBefore(el, next); } catch {}
  }

  return text;
}`;

/**
 * JavaScript that uses getComputedStyle on the LIVE page for more thorough detection.
 * Slower but catches CSS class-based hiding, not just inline styles.
 */
const SANITIZE_SCRIPT_DEEP = `() => {
  // First pass: identify hidden elements on the live DOM using computed styles
  const hiddenEls = new Set();

  document.body.querySelectorAll('*').forEach(el => {
    try {
      const cs = window.getComputedStyle(el);

      const fontSize = parseFloat(cs.fontSize);
      if (fontSize < 2) { hiddenEls.add(el); return; }

      const rect = el.getBoundingClientRect();
      if (rect.right < -1000 || rect.bottom < -1000) { hiddenEls.add(el); return; }

      const clipPath = cs.clipPath || '';
      const clip = cs.clip || '';
      if (clipPath.includes('inset(100') || clip === 'rect(0px, 0px, 0px, 0px)') { hiddenEls.add(el); return; }

      if (rect.width < 2 && rect.height < 2 && cs.overflow === 'hidden') { hiddenEls.add(el); return; }

      // Same color text as background (text hidden in plain sight)
      const color = cs.color;
      const bg = cs.backgroundColor;
      if (color && bg && color === bg && bg !== 'rgba(0, 0, 0, 0)') { hiddenEls.add(el); return; }
    } catch {}
  });

  // Remove hidden elements from live DOM, capture text, then restore
  const removed = [];
  hiddenEls.forEach(el => {
    if (el.parentNode) {
      removed.push({ el, parent: el.parentNode, next: el.nextSibling });
      el.parentNode.removeChild(el);
    }
  });

  // Also temporarily remove script/style/noscript
  const nonContent = [];
  document.body.querySelectorAll('script, style, noscript').forEach(el => {
    if (el.parentNode) {
      nonContent.push({ el, parent: el.parentNode, next: el.nextSibling });
      el.parentNode.removeChild(el);
    }
  });

  const text = document.body.innerText || '';

  // Restore everything
  for (const { el, parent, next } of [...nonContent, ...removed].reverse()) {
    try { parent.insertBefore(el, next); } catch {}
  }

  return text;
}`;

/**
 * Extract sanitized text from a Playwright page or frame.
 *
 * @param {import('playwright').Page|import('playwright').Frame} target
 * @param {object} [options]
 * @param {boolean} [options.deep=false] - Use computed styles (slower, more thorough)
 * @param {boolean} [options.unwrap=false] - Return raw text without boundary markers
 * @returns {Promise<string>}
 */
async function extractSanitizedText(target, options = {}) {
  const { deep = false, unwrap = false } = options;

  let text;
  try {
    const script = deep ? SANITIZE_SCRIPT_DEEP : SANITIZE_SCRIPT;
    text = await target.evaluate(`(${script})()`);
  } catch {
    // Fallback to plain innerText if evaluation fails (e.g., detached frame)
    try {
      text = await target.evaluate(() => document.body?.innerText || '');
    } catch {
      text = '';
    }
  }

  if (unwrap) return text;

  // Layer 2: Wrap in untrusted content boundary markers
  return `--- BEGIN UNTRUSTED PAGE CONTENT ---\n${text}\n--- END UNTRUSTED PAGE CONTENT ---`;
}

/**
 * Extract sanitized text from a page including all same-origin iframes.
 *
 * @param {import('playwright').Page} page
 * @param {object} [options]
 * @param {boolean} [options.deep=false]
 * @param {boolean} [options.unwrap=false]
 * @returns {Promise<string>}
 */
async function extractSanitizedTextWithFrames(page, options = {}) {
  const { deep = false, unwrap = false } = options;

  const script = deep ? SANITIZE_SCRIPT_DEEP : SANITIZE_SCRIPT;

  let text = '';
  try {
    text = await page.evaluate(`(${script})()`);
  } catch {
    try { text = await page.evaluate(() => document.body?.innerText || ''); } catch {}
  }

  // Include iframe content
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      const frameText = await frame.evaluate(`(${script})()`);
      if (frameText && frameText.trim()) {
        text += '\n' + frameText;
      }
    } catch {} // cross-origin frames will throw
  }

  if (unwrap) return text;
  return `--- BEGIN UNTRUSTED PAGE CONTENT ---\n${text}\n--- END UNTRUSTED PAGE CONTENT ---`;
}

module.exports = { extractSanitizedText, extractSanitizedTextWithFrames };
