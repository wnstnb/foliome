/**
 * Shared annotation primitives for visual page exploration.
 *
 * Used by:
 *   - explore-interactive.js (interactive visual explorer)
 *   - run.js (adaptive bridge — when unknown page state is encountered)
 *
 * Provides: element discovery, numbered label injection, label cleanup, iframe detection.
 */
const { extractSanitizedText } = require('./sanitize-text');

/**
 * Discover interactive elements and inject numbered labels onto the page.
 * @param {import('playwright').Page} page - Playwright page
 * @param {import('playwright').Frame|import('playwright').Page} target - page or frame to annotate
 * @returns {Promise<Array>} array of element objects with .n, .tag, .selector, .bounds, .text
 */
async function annotateElements(page, target) {
  const elements = await target.evaluate(() => {
    const results = [];
    const seen = new Set();
    const interactiveSelectors = [
      'button', '[role="button"]', 'a[href]', 'a[onclick]',
      'input', 'select', 'textarea',
      '[role="link"]', '[role="tab"]', '[role="menuitem"]',
      '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
      '[role="option"]', '[onclick]',
    ];

    for (const sel of interactiveSelectors) {
      try {
        document.querySelectorAll(sel).forEach(el => {
          if (seen.has(el)) return;
          seen.add(el);

          const rect = el.getBoundingClientRect();
          if (rect.width < 8 || rect.height < 8) return;
          if (rect.bottom < 0 || rect.right < 0) return;
          if (rect.top > window.innerHeight + 50) return;
          if (rect.left > window.innerWidth + 50) return;

          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return;
          if (parseFloat(style.opacity) === 0) return;

          const tag = el.tagName.toLowerCase();
          const text = (el.textContent || '').trim().replace(/\s+/g, ' ').substring(0, 60);

          let selector = '';
          if (el.id && !el.id.includes(' ') && el.id.length < 60) {
            selector = `#${el.id}`;
          } else if (el.name) {
            selector = `${tag}[name="${el.name}"]`;
          } else if (el.getAttribute('aria-label')) {
            selector = `[aria-label="${el.getAttribute('aria-label')}"]`;
          } else if (el.getAttribute('data-testid')) {
            selector = `[data-testid="${el.getAttribute('data-testid')}"]`;
          } else if (text && text.length > 0 && text.length < 40 && (tag === 'button' || tag === 'a')) {
            selector = `${tag}:has-text("${text.replace(/"/g, '\\"')}")`;
          } else if (tag === 'input' && el.type) {
            const typeCount = document.querySelectorAll(`input[type="${el.type}"]`).length;
            selector = typeCount === 1
              ? `input[type="${el.type}"]`
              : `input[type="${el.type}"]:nth(${Array.from(document.querySelectorAll(`input[type="${el.type}"]`)).indexOf(el)})`;
          } else if (el.className && typeof el.className === 'string') {
            const cls = el.className.trim().split(/\s+/)[0];
            if (cls && cls.length < 60) selector = `${tag}.${cls}`;
          }
          if (!selector) selector = tag;

          results.push({
            tag,
            type: el.type || null,
            text: text || null,
            selector,
            name: el.name || null,
            id: el.id || null,
            ariaLabel: el.getAttribute('aria-label') || null,
            href: (tag === 'a' && el.href) ? el.href : null,
            placeholder: el.placeholder || null,
            bounds: {
              x: Math.round(rect.x), y: Math.round(rect.y),
              w: Math.round(rect.width), h: Math.round(rect.height),
            },
          });
        });
      } catch {}
    }

    return results;
  });

  elements.forEach((el, i) => { el.n = i + 1; });

  await target.evaluate((elements) => {
    document.querySelectorAll('[data-fc-explore]').forEach(el => el.remove());

    for (const el of elements) {
      const label = document.createElement('div');
      label.setAttribute('data-fc-explore', String(el.n));
      label.textContent = String(el.n);
      Object.assign(label.style, {
        position: 'fixed',
        left: Math.max(0, el.bounds.x - 10) + 'px',
        top: Math.max(0, el.bounds.y - 10) + 'px',
        background: '#e74c3c',
        color: 'white',
        fontSize: '10px',
        fontWeight: 'bold',
        padding: '0 3px',
        borderRadius: '7px',
        zIndex: '2147483647',
        pointerEvents: 'none',
        fontFamily: 'Arial, Helvetica, sans-serif',
        lineHeight: '14px',
        minWidth: '14px',
        textAlign: 'center',
        boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
        border: '1px solid rgba(255,255,255,0.5)',
      });
      document.body.appendChild(label);
    }
  }, elements);

  return elements;
}

/**
 * Remove annotation labels from the page.
 */
async function removeLabels(target) {
  await target.evaluate(() => {
    document.querySelectorAll('[data-fc-explore]').forEach(el => el.remove());
  }).catch(() => {});
}

/**
 * Detect iframes on the page.
 * @returns {Promise<Array>} array of iframe metadata
 */
async function detectIframes(page) {
  const iframes = [];
  const frames = page.frames();
  let idx = 0;
  for (const frame of frames) {
    if (frame === page.mainFrame()) continue;
    try {
      const frameUrl = frame.url();
      if (!frameUrl || frameUrl === 'about:blank') { idx++; continue; }
      let hasInputs = false;
      try { hasInputs = await frame.evaluate(() => document.querySelectorAll('input').length > 0); } catch {}
      iframes.push({ n: 100 + idx, index: idx, url: frameUrl, hasInputs });
    } catch {}
    idx++;
  }
  return iframes;
}

/**
 * Take an annotated screenshot — annotate elements, capture, remove labels.
 * @returns {{ screenshot: string, elements: Array, inputs: Array, iframes: Array, pageText: string }}
 */
async function captureAnnotatedState(page, target, screenshotPath) {
  let elements = [];
  try {
    elements = await annotateElements(page, target);
  } catch (e) {
    console.log(`[annotate] Annotation failed: ${e.message.substring(0, 60)}`);
  }

  await page.screenshot({ path: screenshotPath });
  await removeLabels(target);

  const iframes = await detectIframes(page);

  let pageText = '';
  try { pageText = await extractSanitizedText(target); } catch {}

  const inputTags = new Set(['input', 'select', 'textarea']);
  const inputs = elements.filter(el => inputTags.has(el.tag));
  const interactive = elements.filter(el => !inputTags.has(el.tag));

  return {
    screenshot: screenshotPath,
    url: page.url(),
    title: await page.title().catch(() => ''),
    pageText: pageText.substring(0, 2000),
    textLength: pageText.length,
    elements: interactive,
    inputs,
    iframes,
  };
}

module.exports = { annotateElements, removeLabels, detectIframes, captureAnnotatedState };
