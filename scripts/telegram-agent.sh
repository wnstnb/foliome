#!/bin/bash
# Telegram Agent Supervisor
# Keeps the Claude Code Telegram agent running. Auto-restarts on exit.
# The agent can restart itself (for context management) by running: kill $PPID
#
# Usage:
#   ./scripts/telegram-agent.sh              # foreground (for terminal)
#   nohup ./scripts/telegram-agent.sh &      # background (headless)
#
# Logs: /tmp/telegram-agent.log

cd "$(dirname "$0")/.."
LOG=/tmp/telegram-agent.log

# Headed browser automation needs a display. This box runs at a TTY (no graphical
# session), so a persistent Xvfb virtual framebuffer on :99 backs all headed Chrome
# launches. Provided by the xvfb.service systemd unit (Restart=always). Exporting
# DISPLAY here means every agent session and the syncs it spawns inherit it.
export DISPLAY=:99

# Ensure dashboard server is running
if ! curl -s http://localhost:3847/health > /dev/null 2>&1; then
  echo "[$(date)] Starting dashboard server..." >> $LOG
  nohup node scripts/dashboard-server.js >> /tmp/dashboard-server.log 2>&1 &
fi

# The dashboard needs a public HTTPS URL for the Telegram Mini App. A
# persistent tunnel (e.g. Tailscale Funnel: `tailscale funnel --bg 3847`) is
# set once and survives reboots, so no per-start tunnel is needed here.
# Inspect/manage with: tailscale funnel status

SESSION=0
while true; do
  SESSION=$((SESSION + 1))
  echo "[$(date)] Starting agent session #$SESSION" >> $LOG
  echo "[$(date)] Starting agent session #$SESSION"

  # A seed prompt is required to run headless (launchd, no TTY) — without input
  # claude errors out. Arg order matters: --dangerously-skip-permissions must
  # sit between --channels and the prompt, or --channels consumes the prompt as
  # a (malformed) channel entry.
  claude --channels plugin:telegram@claude-plugins-official --dangerously-skip-permissions \
    "Boot Foliome. Run your CLAUDE.md session-start sequence, then stand by for Telegram messages."

  EXIT_CODE=$?
  echo "[$(date)] Session #$SESSION ended (exit code $EXIT_CODE). Restarting in 5s..." >> $LOG
  echo "[$(date)] Session #$SESSION ended (exit code $EXIT_CODE). Restarting in 5s..."
  sleep 5
done
