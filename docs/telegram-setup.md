# Foliome Telegram Setup — Claude Code Channels

Claude Code acts as the Telegram bot via the official Telegram plugin. No separate bot process needed.

## Prerequisites

- Claude Code CLI installed (`claude --version` ≥ 2.1.77)
- Bun runtime installed (`bun --version`)
- Telegram bot token (from @BotFather)
- Claude Code Telegram plugin installed

## One-Time Setup

### 1. Install the Telegram plugin (already done)

```bash
claude plugins install telegram@claude-plugins-official
```

### 2. Configure the bot token

In a Claude Code session:
```
/telegram:configure <your-bot-token>
```

This writes the token to `~/.claude/channels/telegram/.env`.

### 3. Pair your Telegram account

Start Claude Code with the channel:
```bash
claude --channels plugin:telegram@claude-plugins-official
```

DM your bot on Telegram — it replies with a 6-character code. In the Claude Code session:
```
/telegram:access pair <code>
```

### 4. Lock down access

```
/telegram:access policy allowlist
```

This prevents strangers from interacting with the bot.

## Starting the Telegram Bot

**Open a dedicated terminal window** and run:

```bash
cd /path/to/foliome
claude --channels plugin:telegram@claude-plugins-official --dangerously-skip-permissions
```

Flags:
- `--channels plugin:telegram@claude-plugins-official` — enables the Telegram bridge
- `--dangerously-skip-permissions` — allows unattended operation (no permission prompts)

**Leave this terminal open.** The bot is active as long as this session runs.

### What Claude can do in this session:
- Respond to Telegram messages (balances, queries, morning brief)
- Run sync scripts: `node readers/sync-all.js`
- Query SQLite: `node -e "..."`
- Read JSON output files
- Send charts/images back to Telegram
- Serve the dashboard Mini App (7 tabs + wiki browser)

## Important Notes

- **One bot token, one consumer.** Only one process can poll a given Telegram bot token at a time.
- **Session stays open.** Closing the terminal stops the bot. Use a dedicated terminal window or `tmux`/`screen` on Linux.
- **MFA during sync.** The sync scripts use `scripts/telegram-notify.js` (send-only) for MFA prompts. This works independently of Claude Code channels since it just calls the Telegram Bot API directly to send a message — it doesn't poll.

## Dashboard Mini App (optional)

The dashboard server serves your financial overview as a Telegram Mini App — tap a button in the chat to see net worth, balances, and spending inside Telegram.

### Setup

1. Start the dashboard server:
   ```bash
   node scripts/dashboard-server.js
   ```

2. Expose via Cloudflare tunnel:
   ```bash
   cloudflared tunnel --url http://localhost:3847
   ```

3. Ask the agent (via Telegram) to show your dashboard — it sends an InlineKeyboardButton with `web_app: { url: <tunnel-url> }`.

The server serves a React SPA from `dashboard/dist/` with API endpoints for live data. The SPA has 7 tabs (Brief, Overview, Transactions, Budget, Portfolio, Subscriptions, Wiki) with responsive layout — mobile in the Telegram WebView, full-page when opened wider.

### Bot Token for HMAC Validation

Telegram Mini App `initData` is HMAC-signed by whichever bot sent the `web_app` button. The dashboard server must validate against that same token.

The server resolves the token automatically:

1. **`DASHBOARD_BOT_TOKEN` env var** — explicit override, always wins
2. **Plugin bot token** — auto-detected from `~/.claude/channels/telegram/.env`
3. **`TELEGRAM_BOT_TOKEN`** — foliome `.env` fallback

If you use the Claude Code Telegram plugin (most common setup), no extra config is needed — the server auto-detects the plugin bot's token. If you use a different bot to send the `web_app` button, set `DASHBOARD_BOT_TOKEN` in `.env`.

**If validation fails** (403 "Invalid authentication"), the most common cause is a token mismatch. Check the server startup log — it prints which token source it chose. Set `DASHBOARD_BOT_TOKEN` explicitly if the auto-detection picks the wrong one.

### Quick vs Named Tunnels

Quick tunnels (`cloudflared tunnel --url`) get a random URL that changes on restart. For a persistent URL, set up a named tunnel with a Cloudflare account. The dashboard works with either — just update the `web_app` URL when the tunnel changes.

## Troubleshooting

**Bot not responding:**
- Check the terminal — is Claude Code still running?
- Verify no other process is polling the bot: only one consumer per token
- Check `~/.claude/channels/telegram/.env` has the correct token

**Permission denied:**
- Make sure `--dangerously-skip-permissions` is set
- Or approve permissions manually in the terminal

**Plugin not loading:**
- Run `/reload-plugins` in the session
- Check `claude plugins list` shows the telegram plugin


