// Telegram MarkdownV2 conversion — the single source of truth.
//
// Used by scripts/telegram-notify.js and by any outbound send path that
// needs MarkdownV2 (e.g. a PreToolUse hook on the Telegram reply tool).
//
// Conversion mirrors hermes-agent/gateway/platforms/telegram.py:
//   1. Protect fenced code blocks
//   2. Protect inline code
//   3. Convert links
//   4. Convert headers (## Title → bold)
//   5. Convert bold (**text** → *text* in MDV2)
//   6. Convert italic (*text* → _text_ in MDV2)
//   7. Convert strikethrough (~~text~~ → ~text~ in MDV2)
//   8. Escape all remaining MDV2 specials
//   9. Restore protected regions in reverse insertion order
//
// On MarkdownV2 parse failure at the Telegram side, callers should fall back
// to sending the original (unformatted) text with no parse_mode so a reply is
// never silently lost. That fallback is the responsibility of the caller —
// this module only does the conversion.

export const MDV2_ESCAPE_RE = /([_*\[\]()~`>#+\-=|{}.!\\])/g

export function escapeMdV2(text) {
  return text.replace(MDV2_ESCAPE_RE, '\\$1')
}

export function formatMessageMdV2(content) {
  if (!content) return content

  const placeholders = {}
  let counter = 0
  const ph = (value) => {
    const key = `\x00PH${counter}\x00`
    counter++
    placeholders[key] = value
    return key
  }

  let text = content

  // 1) Protect fenced code blocks. Inside, escape \ and `.
  text = text.replace(/(```(?:[^\n]*\n)?[\s\S]*?```)/g, (raw) => {
    const newlineIdx = raw.indexOf('\n')
    const openEnd = newlineIdx > 2 ? newlineIdx + 1 : 3
    const opening = raw.slice(0, openEnd)
    const bodyAndClose = raw.slice(openEnd)
    let body = bodyAndClose.slice(0, -3)
    body = body.replace(/\\/g, '\\\\').replace(/`/g, '\\`')
    return ph(opening + body + '```')
  })

  // 2) Protect inline code. Inside, escape \.
  text = text.replace(/(`[^`]+`)/g, (m) => ph(m.replace(/\\/g, '\\\\')))

  // 3) Convert markdown links. Escape display text per MDV2; in URL escape ) and \.
  text = text.replace(
    /\[([^\]]+)\]\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g,
    (_m, display, url) => {
      const d = escapeMdV2(display)
      const u = url.replace(/\\/g, '\\\\').replace(/\)/g, '\\)')
      return ph(`[${d}](${u})`)
    },
  )

  // 4) Convert markdown headers (## Title) → bold *Title*.
  text = text.replace(/^#{1,6}\s+(.+)$/gm, (_m, inner) => {
    const stripped = inner.trim().replace(/\*\*(.+?)\*\*/g, '$1')
    return ph(`*${escapeMdV2(stripped)}*`)
  })

  // 5) Convert bold: **text** → *text* (MDV2 bold).
  text = text.replace(/\*\*(.+?)\*\*/g, (_m, inner) =>
    ph(`*${escapeMdV2(inner)}*`),
  )

  // 6) Convert italic: *text* (single asterisk) → _text_ (MDV2 italic).
  //    [^*\n]+ prevents matching across newlines (would corrupt bullet lists
  //    that use * markers and multi-line content).
  text = text.replace(/\*([^*\n]+)\*/g, (_m, inner) =>
    ph(`_${escapeMdV2(inner)}_`),
  )

  // 7) Convert strikethrough: ~~text~~ → ~text~ (MDV2).
  text = text.replace(/~~(.+?)~~/g, (_m, inner) =>
    ph(`~${escapeMdV2(inner)}~`),
  )

  // 8) Escape remaining special characters in plain text.
  text = escapeMdV2(text)

  // 9) Restore placeholders in reverse insertion order so nested references
  //    resolve correctly (a placeholder inside another).
  const keys = Object.keys(placeholders)
  for (let i = keys.length - 1; i >= 0; i--) {
    text = text.replace(keys[i], placeholders[keys[i]])
  }

  return text
}
