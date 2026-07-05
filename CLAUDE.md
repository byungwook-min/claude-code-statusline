# CLAUDE.md — claude-code-statusline

A Claude Code statusline that surfaces token in/out, prompt-cache read/write,
per-turn cost delta, and session total. Shipped as scripts + an installer + a
SessionStart auto-heal hook + a re-apply skill.

## Layout

- `install.sh` — idempotent installer. Auto-detects flavor, merges `settings.json` (backup first), installs the script + hook + skill.
- `statusline/omc-hud-plus.sh` — **omc** flavor: a POSIX `sh` wrapper that runs the stock OMC HUD launcher and appends one metrics line below it.
- `statusline/standalone.sh` — **standalone** flavor: self-contained statusline, no OMC.
- `hooks/statusline-guard.mjs` — SessionStart hook that re-points `statusLine.command` back at the installed script when it drifts (e.g. after `omc update`).
- `skill/claude-code-statusline/SKILL.md` — the `/claude-code-statusline` re-apply skill.
- `settings-snippet.json` — reference blocks for manual install.
- `assets/preview.svg` — README preview image.

## Invariants (do not break)

1. **Never modify the compiled OMC HUD** (`omc-hud.mjs`, `omc-hud-cache.sh`, `dist/hud/**`). The whole point is a user-owned wrapper that survives OMC upgrades. The omc flavor must *call* the stock launcher, never reimplement the HUD.
2. **Portable, no hardcoded paths.** Use `${CLAUDE_CONFIG_DIR:-$HOME/.claude}` and resolve dirs from `$0` / `$BASH_SOURCE`. Keep `omc-hud-plus.sh` POSIX `sh` (not bash-only); `install.sh` may be bash.
3. **The "desired command" string is duplicated on purpose** — `install.sh` writes it to `settings.json`, `hooks/statusline-guard.mjs` compares against it. They must stay **byte-identical**, or the hook rewrites `settings.json` every session. Change both together. (Installed names the hook probes for: omc → `hud/omc-hud-plus.sh`, standalone → `statusline-command.sh`.)
4. **`install.sh` stays idempotent** and always backs up `settings.json` before writing. settings edits must **preserve all other keys** (jq object merge, never wholesale overwrite) and must not duplicate the SessionStart hook entry on re-run.
5. **`statusline-guard.mjs` must never throw** out of the process (wrap in try/catch, always `exit 0`), must write **only on drift**, and must refuse to touch an unparseable `settings.json`.

## Data source

Claude Code pipes render JSON to the statusline command on **stdin**. Both scripts read the same paths — `context_window.total_input_tokens`/`total_output_tokens`, `context_window.current_usage.cache_read_input_tokens`/`cache_creation_input_tokens` (last API call only), and `cost.total_cost_usd` (`Δ$` = diff vs the previous render, cached per session in `$TMPDIR`). README's "How it works" table is the canonical field→display mapping.

**`omc-hud-plus.sh` and `standalone.sh` extract these paths independently** — like the desired-command strings (Invariant 3), a field rename must land in both files or the other flavor silently renders wrong numbers.

## Testing

- **Never test against the real `~/.claude`.** Use an isolated dir: `./install.sh --config-dir "$(mktemp -d)/cfg"`, or `--print` for a dry run.
- Syntax: `sh -n statusline/omc-hud-plus.sh` (it must stay POSIX — `bash -n` misses bashisms), `bash -n install.sh statusline/standalone.sh`, `node --check hooks/statusline-guard.mjs`, `jq -e . settings-snippet.json`, `xmllint --noout assets/preview.svg`.
- Smoke test the real output (catches a wrong field or broken `printf` that syntax checks can't) — pipe a sample payload and confirm the metrics line appears:
  ```sh
  printf '{"session_id":"t","cost":{"total_cost_usd":1.2},"context_window":{"total_input_tokens":61000,"total_output_tokens":3,"current_usage":{"cache_read_input_tokens":58000,"cache_creation_input_tokens":2900}}}' | sh statusline/omc-hud-plus.sh
  ```

## If the repo is renamed / re-owned

The slug `byungwook-min/claude-code-statusline` is referenced in `install.sh` (`REPO_SLUG`), `README.md` (clone/curl links + license owner), and `skill/claude-code-statusline/SKILL.md` (curl URL). Update them together.
