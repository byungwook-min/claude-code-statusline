# CLAUDE.md — claude-code-statusline

A three-line Claude Code HUD (git · model/ctx/rate-limits · tokens/cache/cost) shipped as
`statusline/hud.mjs` + an installer + a SessionStart auto-heal hook + a re-apply skill.

## Commands
- Syntax: `bash -n install.sh && node --check statusline/hud.mjs hooks/statusline-guard.mjs && jq -e . settings-snippet.json`
- Tests: `node --test` (spawns the real `hud.mjs` / guard with fixture payloads; no deps)
- Dry-run install: `./install.sh --print`
- Isolated real install (never against `~/.claude`): `./install.sh --config-dir "$(mktemp -d)/cfg"`
- Smoke test (must print 3 lines, the last one `in:0 out:0 | cache r:0 w:0 · --(--) | Δ$0.00 | $0.00`):
  ```sh
  printf '{"session_id":"t","model":{"display_name":"T"},"workspace":{"current_dir":"%s"},"context_window":{},"cost":{}}' "$PWD" | node statusline/hud.mjs
  ```
- Regenerate the README preview after any visual change: `python3 assets/make-preview.py` (renders real HUD output to SVG)

## Invariants (do not break)
1. **The desired statusLine block is duplicated on purpose** — `install.sh` (`DESIRED_CMD`, `REFRESH_INTERVAL`) writes it to `settings.json`, `hooks/statusline-guard.mjs` (`desired`, `REFRESH_INTERVAL`) compares against it. Command string (`node ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/statusline/hud.mjs`) and interval (`60`) must stay **identical**, or the hook rewrites `settings.json` every session. Change both together.
2. **`hud.mjs` never throws and never blocks.** Every optional section is wrapped; git calls have a 1 s timeout; nothing else leaves the process — everything is read from the stdin payload.
3. **Every segment renders at zero.** `?0`, `5h:--%`, `session:0m`, `· --(--)`, `Δ$0.00`, `$0.00` — never conditionally omit a segment; a bar that changes shape between turns makes the terminal jump. The only transient piece is `miss:<cause>`, shown for 2 min after a diagnosed cache miss.
4. **`install.sh` stays idempotent** and backs up `settings.json` before writing. settings edits are jq object merges that preserve all other keys and never duplicate the SessionStart hook entry on re-run.
5. **`statusline-guard.mjs` never throws out of the process** (always `exit 0`), writes **only on drift**, and refuses to touch an unparseable `settings.json`.
6. **Portable, no hardcoded paths.** Use `${CLAUDE_CONFIG_DIR:-$HOME/.claude}` and resolve dirs from `import.meta.url` / `$BASH_SOURCE`.

## Gotchas
- Other tools (Orca, IDE integrations) rewrite `~/.claude/settings.json` on their own; that is exactly what the SessionStart hook exists for — don't treat it as a bug.
- `Δ$` is `0.00` on the first render of a session by design (no prior total to diff against). Renders also fire on the `refreshInterval` timer with an unchanged total; `Δ$` then keeps the last turn's value instead of dropping to `0.00`.
- `rate_limits` and `prompt_cache` are in the stdin payload only after the first API response (and `rate_limits` only on Pro/Max) — Claude Code ≥ 2.1.251. Before that both segments show `--`.
- The statusline is event-driven and goes quiet while idle; `refreshInterval: 60` is what keeps the cache countdown (`1h(52m)`) ticking. Claude Code also re-renders once when `expires_at` passes.
- `prompt_cache.warm` is as of the last response, so `hud.mjs` treats a passed `expires_at` as cold regardless.
- Renaming the repo: the slug `byungwook-min/claude-code-statusline` lives in `install.sh` (`REPO_SLUG`), `README.md`, and `skill/claude-code-statusline/SKILL.md` — update together.
