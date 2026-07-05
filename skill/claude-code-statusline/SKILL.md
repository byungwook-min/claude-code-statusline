---
name: claude-code-statusline
description: |
  Install or re-apply the claude-code-statusline setup (OMC HUD + token/cache/cost
  metrics line, or the standalone statusline). Use this after `omc update` or an OMC
  re-setup resets settings.json's statusLine.command, or whenever the statusline
  needs to be (re)installed from the claude-code-statusline repo.

  Trigger on: "statusline 재설정", "statusline 복구", "상태줄 재설정", "상태줄 복구",
  "statusline 다시 설정", "restore statusline", "reapply statusline", "statusline setup",
  "install statusline", "omc update 후 statusline", "상태줄 다시 깔아".
version: 0.1.0
user-invocable: true
---

# claude-code-statusline

Re-applies the statusline from the **claude-code-statusline** repo. The repo is the
single source of truth: the installer places the right script, points
`settings.json` `statusLine.command` at it, and (by default) installs an auto-heal
hook + this skill. This skill exists for the manual path — mainly to recover after
`omc update` wipes the `statusLine.command`.

## What it does

1. Runs the repo's `install.sh`, which:
   - auto-detects **omc** (oh-my-claudecode present) vs **standalone**,
   - copies the statusline script into `~/.claude/`,
   - idempotently merges `statusLine.command` (and, for OMC, a `focused` `omcHud` default) into `settings.json` — backing it up first,
   - installs the SessionStart auto-heal hook and this skill.
2. Verifies the statusline renders.

## Steps

### 1. Locate the source and run the installer

Prefer a local clone; fall back to the network. Run exactly one of these:

```bash
# Preferred: local clone (check these paths, use the first that exists)
for d in "$HOME/personal/claude-code-statusline" "$HOME/claude-code-statusline" "$HOME/dev/claude-code-statusline"; do
  [ -f "$d/install.sh" ] && { bash "$d/install.sh"; break; }
done
```

If no local clone is found, install straight from the repo:

```bash
curl -fsSL https://raw.githubusercontent.com/byungwook-min/claude-code-statusline/main/install.sh | bash
```

Pass flags through when the user asks for a specific flavor or wants to skip pieces,
e.g. `bash install.sh --standalone`, `--no-hook`, `--no-skill`, or `--print` for a
dry run. `install.sh --help` lists them.

### 2. Verify it renders

Feed a captured statusline payload through the installed command and confirm the
metrics line appears (`in:… out:… | cache r:… w:… | …$…`):

```bash
CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
# find a recent cached payload from any project's OMC state, else skip
PAYLOAD=$(ls -t "$HOME"/**/.omc/state/hud-stdin-cache.json 2>/dev/null | head -1)
if [ -n "$PAYLOAD" ]; then
  if [ -f "$CFG/hud/omc-hud-plus.sh" ]; then
    OMC_HUD_SYNC_REFRESH=1 sh "$CFG/hud/omc-hud-plus.sh" < "$PAYLOAD" | tail -2
  else
    sh "$CFG/statusline-command.sh" < "$PAYLOAD"
  fi
fi
```

### 3. Report

Tell the user the flavor installed and that a **new session (or a render)** is needed
to see it. If OMC was involved, remind them the auto-heal hook now restores this on
future `omc update`s automatically — this manual skill is the fallback.

## Notes

- Never edit the compiled OMC HUD; the whole point is the user-owned wrapper.
- `settings.json` is always backed up (`settings.json.bak.*`) before any change.
- The Δ (per-turn cost) figure only appears from the second render onward and only when spend changed.
