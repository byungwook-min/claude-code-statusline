---
name: claude-code-statusline
description: |
  Install or re-apply the claude-code-statusline HUD (3-line: git / model+ctx+rate-limits /
  token+cache+cost). Use whenever settings.json's statusLine.command was reset by another
  tool, or the HUD needs to be (re)installed from the claude-code-statusline repo.

  Trigger on: "statusline 재설정", "statusline 복구", "상태줄 재설정", "상태줄 복구",
  "statusline 다시 설정", "restore statusline", "reapply statusline", "statusline setup",
  "install statusline", "상태줄 다시 깔아".
version: 0.2.0
user-invocable: true
---

# claude-code-statusline

Re-applies the HUD from the **claude-code-statusline** repo. The repo is the single source
of truth: `install.sh` copies `statusline/hud.mjs` into `~/.claude/`, points `settings.json`
`statusLine` at it (with `refreshInterval: 60`), and installs the SessionStart auto-heal
hook plus this skill. Every `settings.json` write is backed up first.

## Steps

### 1. Run the installer

Prefer a local clone; fall back to the network. Run exactly one of these:

```bash
for d in "$HOME/personal/claude-code-statusline" "$HOME/Projects/claude-code-statusline" "$HOME/claude-code-statusline"; do
  [ -f "$d/install.sh" ] && { bash "$d/install.sh"; break; }
done
```

```bash
curl -fsSL https://raw.githubusercontent.com/byungwook-min/claude-code-statusline/main/install.sh | bash
```

Pass `--no-hook`, `--no-skill`, or `--print` (dry run) through when asked.

### 2. Verify it renders

Pipe a minimal payload and confirm three lines come back, including the zero-valued
metrics line (`in:0 out:0 | cache r:0 w:0 · --(--) | Δ$0.00 | $0.00`):

```bash
CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
printf '{"session_id":"verify","model":{"display_name":"Test"},"workspace":{"current_dir":"%s"},"context_window":{},"cost":{}}' "$PWD" \
  | node "$CFG/statusline/hud.mjs"
```

### 3. Report

Tell the user a **new session** is needed to see it, and that the SessionStart hook will
re-assert the `statusLine` block automatically if another tool rewrites `settings.json`.

## Notes

- `settings.json` is always backed up (`settings.json.bak.*`) before any change.
- The `Δ` (per-turn cost) segment reads `0.00` on the first render of a session by design.
