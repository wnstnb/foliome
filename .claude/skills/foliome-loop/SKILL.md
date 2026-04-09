---
name: foliome-loop
description: Manage recurring scheduled tasks — add, list, pause, resume, remove
trigger: manual
---

# Foliome Loop — Recurring Task Scheduling

Persist recurring schedules to `config/schedules.json` and register them via CronCreate on every agent startup. Schedules survive agent restarts because they're config-driven — the agent re-registers all enabled entries on boot.

## Subcommands

Parse the user's message to determine which subcommand to run:

### Add (default)

Trigger: "schedule", "every day at", "recurring", "automate", or any natural language describing a recurring task.

1. **Parse the schedule** from natural language → cron expression (see Cron Parsing below)
2. **Resolve institutions** if the command involves `/sync`:
   - "non-MFA" → read each `readers/institutions/*.js` config. If `mfa.sms`, `mfa.email`, `mfa.push`, `mfa.totp` are ALL false/absent → non-MFA. All API connectors (`connectors/*.js`) are always non-MFA.
   - Specific bank names → validate they exist in institutions/ or connectors/
   - Store the resolved bank list in the `prompt` field as `--banks bank1,bank2`
3. **MFA warning** — if any resolved bank requires MFA, warn the user:
   - "Banks [X, Y] require MFA. You'll get a Telegram notification for the code when the sync runs. If you don't respond within 5 minutes, the sync fails for those banks."
   - Suggest scheduling MFA banks for times the user will be available, or using `non-MFA` to exclude them
4. **Generate a slug ID** from the description (e.g., "daily-sync-non-mfa", "weekday-morning-brief")
5. **Write to config** — read `config/schedules.json`, append the new entry, write back:
   ```json
   {
     "id": "<slug>",
     "description": "<human-readable schedule description>",
     "cron": "<cron expression>",
     "command": "<skill name>",
     "prompt": "<full prompt for the agent when the cron fires>",
     "enabled": true,
     "cronJobId": null,
     "createdAt": "<ISO timestamp>",
     "lastRun": null,
     "lastStatus": null,
     "consecutiveFailures": 0,
     "maxFailures": 3,
     "suspendedAt": null,
     "suspendReason": null
   }
   ```
6. **Register via CronCreate** — call CronCreate with the cron expression and a prompt that:
   - Reads `config/schedules.json` to get the entry details
   - Executes the skill/command specified
   - Updates `lastRun`, `lastStatus`, `consecutiveFailures` in the config after completion
   - On failure: increments `consecutiveFailures`. If >= `maxFailures`, auto-suspends (see Auto-Suspend below)
7. **Update cronJobId** in the config with the returned job ID
8. **Confirm** with the user: show the schedule ID, cron expression, next approximate run time, and the command

### List

Trigger: "list schedules", "show schedules", "what's scheduled"

Read `config/schedules.json` and display a table:

```
ID                    Schedule           Command              Status
──────────────────────────────────────────────────────────────────────
daily-sync-non-mfa   Every day 6am      /sync (non-MFA)      ✓ active — last ok 2h ago
weekday-brief        Weekdays 7am       /morning-brief       ✓ active — last ok 5h ago
sunday-full-sync     Sundays 10am       /sync (all)          ⏸ suspended — MFA timeout (3 failures)
monthly-reflect      1st of month 9am   /reflect             ✓ active — never run
```

### Remove `<id>`

Trigger: "remove schedule", "delete schedule", "cancel schedule"

1. Read `config/schedules.json`, find the entry by ID
2. If it has a `cronJobId`, call CronDelete to unregister it
3. Remove the entry from the array
4. Write back to config
5. Confirm removal

### Pause `<id>`

Trigger: "pause schedule", "disable schedule", "stop schedule"

1. Find the entry, set `enabled: false`
2. If it has a `cronJobId`, call CronDelete
3. Set `cronJobId: null`
4. Write back to config
5. Confirm: "Paused `<id>`. Run `/foliome-loop resume <id>` to re-enable."

### Resume `<id>`

Trigger: "resume schedule", "enable schedule", "unpause schedule"

1. Find the entry, set `enabled: true`
2. Reset `consecutiveFailures: 0`, clear `suspendedAt` and `suspendReason`
3. Re-register via CronCreate with the stored cron and prompt
4. Update `cronJobId`
5. Write back to config
6. Confirm with next run time

## Cron Parsing (Natural Language → Cron)

The agent parses natural language into standard 5-field cron expressions. Follow CronCreate conventions — offset from :00/:30 when the user says "around" or "morning" (pick a minute like :03, :07, :57 etc.).

| Input | Cron | Notes |
|-------|------|-------|
| "every day at 6am" | `0 6 * * *` | Exact time requested |
| "every morning" | `57 8 * * *` | Approximate — offset from :00 |
| "every Tuesday" | `3 9 * * 2` | Default 9am, offset |
| "weekdays 7am" | `0 7 * * 1-5` | Exact time |
| "every 6 hours" | `7 */6 * * *` | Offset minute |
| "first of every month" | `3 9 1 * *` | Default 9am, offset |
| "every 30 minutes" | `*/30 * * * *` | Interval — no offset needed |
| "twice a day" | Two entries: `3 9 * * *` and `3 17 * * *` | Create two schedule entries |

## Event-Relative Scheduling

Some requests are event-relative, not time-fixed:
- "3 days before each payment due date"
- "the day before rent is due"

These can't be a single cron. Translate to a daily schedule and let the target skill handle the logic:
- "3 days before payments" → `every day at 9am /payment-reminders`
- Explain to the user: "Payment reminders already check what's due within configurable days. I'll schedule a daily check so you're always covered."

## Time-Windowed Schedules

Some requests specify a time window:
- "every 4 hours during market hours (9:30am–4pm)"
- "every hour during business hours"

Prefer creating **multiple schedule entries** from a single request (simpler, more transparent):
- "every 4 hours during market hours" → two entries:
  - `30 9 * * 1-5` (9:30am weekdays)
  - `30 13 * * 1-5` (1:30pm weekdays)
- Give all entries a shared prefix ID like `market-check-0930` and `market-check-1330`

## Auto-Suspend on Repeated Failures

Schedules that fail repeatedly get auto-paused to avoid churning forever.

When a scheduled task completes:
- **On success:** set `lastStatus: "ok"`, `lastRun` to now, reset `consecutiveFailures: 0`
- **On failure:** set `lastStatus: "failed"`, `lastRun` to now, increment `consecutiveFailures`
- **When `consecutiveFailures >= maxFailures`** (default 3):
  1. Set `enabled: false`
  2. CronDelete the active job, set `cronJobId: null`
  3. Set `suspendedAt` to current ISO timestamp
  4. Set `suspendReason` to the last error message
  5. Notify user via Telegram: "Schedule `<id>` suspended after `<maxFailures>` consecutive failures. Last error: <reason>. Run `/foliome-loop resume <id>` when ready."

## CronCreate Prompt Template

When registering a schedule via CronCreate, use this prompt template:

```
Scheduled task firing: "<schedule-id>"

1. Read config/schedules.json, find the entry with id "<schedule-id>"
2. Execute the command: <prompt from the schedule entry>
3. After completion, read config/schedules.json again and update the entry:
   - Set lastRun to the current ISO timestamp
   - If the task succeeded: set lastStatus to "ok", set consecutiveFailures to 0
   - If the task failed: set lastStatus to "failed", increment consecutiveFailures by 1
   - If consecutiveFailures >= maxFailures: set enabled to false, set suspendedAt to current ISO timestamp, set suspendReason to the error message, and notify the user that the schedule has been suspended
4. Write the updated config back to config/schedules.json
```

## Startup Registration

This is handled by the agent on startup (documented in CLAUDE.md), not by this skill. The agent:
1. Reads `config/schedules.json`
2. For each entry with `enabled: true`, calls CronCreate
3. Updates `cronJobId` values
4. Checks for missed runs: if `lastRun` is null or significantly older than the schedule period, executes a catch-up run immediately

## 7-Day CronCreate Expiry

CronCreate jobs auto-expire after 7 days. This is not an issue in practice — the Telegram agent restarts for context management more frequently than every 7 days, and each restart re-registers all schedules from config. The persistent config is the source of truth; CronCreate is just the session-level executor.

## File Location

Config: `config/schedules.json` (gitignored, initialized from `config-templates/schedules.json`)
