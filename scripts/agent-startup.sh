#!/bin/bash
# Agent startup hook — runs on SessionStart, outputs context for the agent.
# Starts background services and injects handoff + schedule context.

cd "$(dirname "$0")/.." || exit 0

NODE="$(command -v node 2>/dev/null)"
if [ -z "$NODE" ]; then
  # nvm path fallback (Mac)
  NODE="$HOME/.nvm/versions/node/v22.22.2/bin/node"
fi

# 1. Start dashboard server if not running
if ! pgrep -f "dashboard-server.js" > /dev/null 2>&1; then
  nohup "$NODE" scripts/dashboard-server.js > /dev/null 2>&1 &
  echo "[startup] Dashboard server started"
fi

# 2. Output handoff context if it exists
HANDOFF="data/agent-handoff.md"
if [ -f "$HANDOFF" ]; then
  echo ""
  echo "=== HANDOFF FROM PREVIOUS SESSION ==="
  cat "$HANDOFF"
  echo "=== END HANDOFF ==="
  echo ""
  echo "Read and act on the handoff above. After processing, delete data/agent-handoff.md."
fi

# 3. Output schedule context
SCHEDULES="config/schedules.json"
if [ -f "$SCHEDULES" ]; then
  ENABLED=$("$NODE" -e "const s=JSON.parse(require('fs').readFileSync('$SCHEDULES','utf-8'));const e=s.filter(x=>x.enabled);if(e.length)console.log(e.length+' enabled schedules to register: '+e.map(x=>x.name||x.cron).join(', '))" 2>/dev/null)
  if [ -n "$ENABLED" ]; then
    echo "[startup] $ENABLED"
    echo "Register these schedules via CronCreate now."
  fi
fi

# 4. Point to prior conversation transcripts
TRANSCRIPT_DIR="$HOME/.claude/projects/-Users-$(whoami)-Projects-foliome"
if [ -d "$TRANSCRIPT_DIR" ]; then
  LATEST=$(ls -t "$TRANSCRIPT_DIR"/*.jsonl 2>/dev/null | head -1)
  if [ -n "$LATEST" ]; then
    echo ""
    echo "[startup] Prior conversation transcripts: $TRANSCRIPT_DIR/"
    echo "[startup] Most recent: $LATEST"
  fi
fi
