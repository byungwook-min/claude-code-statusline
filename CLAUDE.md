# CLAUDE.md — claude-code-statusline

A three-line Claude Code HUD (git · model/ctx/rate-limits · tokens/cache/cost) shipped as
`statusline/hud.mjs` + an installer + a SessionStart auto-heal hook + a re-apply skill.

## Commands
- Syntax: `bash -n install.sh && node --check statusline/hud.mjs statusline/lib/usage.mjs hooks/statusline-guard.mjs && jq -e . settings-snippet.json`
- Dry-run install: `./install.sh --print`
- Isolated real install (never against `~/.claude`): `./install.sh --config-dir "$(mktemp -d)/cfg"`
- Smoke test (must print 3 lines, the last one `in:0 out:0 | cache r:0 w:0 | Δ$0.00 | $0.00`):
  ```sh
  printf '{"session_id":"t","model":{"display_name":"T"},"workspace":{"current_dir":"%s"},"context_window":{},"cost":{}}' "$PWD" | node statusline/hud.mjs
  ```
- Refresh the rate-limit cache by hand: `node statusline/lib/usage.mjs --refresh`
- Regenerate the README preview after any visual change: `python3 assets/make-preview.py` (renders real HUD output to SVG)

## Invariants (do not break)
1. **The desired-command string is duplicated on purpose** — `install.sh` (`DESIRED_CMD`) writes it to `settings.json`, `hooks/statusline-guard.mjs` (`desired`) compares against it. They must stay **byte-identical** (`node ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/statusline/hud.mjs`), or the hook rewrites `settings.json` every session. Change both together.
2. **`hud.mjs` never throws and never blocks.** Every optional section is wrapped; git calls have a 1 s timeout; the render path reads the usage cache only — network refresh happens in a detached process (`usage.mjs --refresh`).
3. **Every segment renders at zero.** `?0`, `5h:--%`, `session:0m`, `Δ$0.00`, `$0.00` — never conditionally omit a segment; a bar that changes shape between turns makes the terminal jump.
4. **`install.sh` stays idempotent** and backs up `settings.json` before writing. settings edits are jq object merges that preserve all other keys and never duplicate the SessionStart hook entry on re-run.
5. **`statusline-guard.mjs` never throws out of the process** (always `exit 0`), writes **only on drift**, and refuses to touch an unparseable `settings.json`.
6. **Portable, no hardcoded paths.** Use `${CLAUDE_CONFIG_DIR:-$HOME/.claude}` and resolve dirs from `import.meta.url` / `$BASH_SOURCE`.

## Gotchas
- Other tools (Orca, IDE integrations) rewrite `~/.claude/settings.json` on their own; that is exactly what the SessionStart hook exists for — don't treat it as a bug.
- `Δ$` is `0.00` on the first render of a session by design (no prior total to diff against).
- Rate-limit data comes from `GET api.anthropic.com/api/oauth/usage` with the OAuth token from the macOS Keychain (fallback `~/.claude/.credentials.json`); it is not in the statusline stdin payload.
- Renaming the repo: the slug `byungwook-min/claude-code-statusline` lives in `install.sh` (`REPO_SLUG`), `README.md`, and `skill/claude-code-statusline/SKILL.md` — update together.
