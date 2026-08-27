#!/usr/bin/env bash
#
# claude-code-statusline installer.
#
# Installs the self-owned 3-line HUD (statusline/hud.mjs) into ~/.claude,
# points settings.json at it, and adds a SessionStart hook that re-asserts
# the statusLine if anything else rewrites settings.json.
#
# Safe to re-run. Every settings.json write is backed up first. Works from a
# local clone or piped straight from the web:
#   curl -fsSL https://raw.githubusercontent.com/byungwook-min/claude-code-statusline/main/install.sh | bash
#
set -euo pipefail

REPO_SLUG="byungwook-min/claude-code-statusline"
BRANCH="main"
RAW_BASE="${STATUSLINE_REPO_RAW:-https://raw.githubusercontent.com/${REPO_SLUG}/${BRANCH}}"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

INSTALL_HOOK=1
INSTALL_SKILL=1
DRY_RUN=0

if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'
  YLW=$'\033[33m'; CYN=$'\033[36m'; RST=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GRN=""; YLW=""; CYN=""; RST=""
fi
say()  { printf '%s\n' "$*"; }
step() { printf '%s➜%s %s\n' "$CYN" "$RST" "$*"; }
ok()   { printf '%s✓%s %s\n' "$GRN" "$RST" "$*"; }
die()  { printf '%s✗%s %s\n' "$RED" "$RST" "$*" >&2; exit 1; }

show_help() {
  cat <<HELP
${BOLD}claude-code-statusline installer${RST}

Usage: install.sh [options]

Options:
  --no-hook            Do not install the SessionStart auto-heal hook
  --no-skill           Do not install the /claude-code-statusline re-apply skill
  --print, --dry-run   Show what would happen; write nothing
  --config-dir DIR     Target config dir (default: \$CLAUDE_CONFIG_DIR or ~/.claude)
  -h, --help           This help

Env:
  CLAUDE_CONFIG_DIR    Claude config dir
  STATUSLINE_REPO_RAW  Raw base URL for remote fetch (default: this repo's main)
HELP
}

while [ $# -gt 0 ]; do
  case "$1" in
    --no-hook) INSTALL_HOOK=0 ;;
    --no-skill) INSTALL_SKILL=0 ;;
    --print|--dry-run) DRY_RUN=1 ;;
    --config-dir) CONFIG_DIR="${2:?--config-dir needs a value}"; shift ;;
    -h|--help) show_help; exit 0 ;;
    *) die "unknown argument: $1  (see --help)" ;;
  esac
  shift
done

command -v jq >/dev/null 2>&1 || die "jq is required (e.g. 'brew install jq')."
command -v node >/dev/null 2>&1 || die "node is required on PATH (the HUD is an ESM script)."

# Source resolution: local clone vs curl-piped
SOURCE="${BASH_SOURCE[0]:-$0}"
SRC_DIR=""
if [ -f "$SOURCE" ]; then
  SRC_DIR="$(cd "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd -P)" || SRC_DIR=""
fi
if [ -n "$SRC_DIR" ] && [ -f "$SRC_DIR/statusline/hud.mjs" ]; then MODE="local"; else MODE="remote"; fi

get_file() { # <relpath> <dest>
  local rel="$1" dest="$2"
  if [ "$MODE" = "local" ] && [ -f "$SRC_DIR/$rel" ]; then
    cp "$SRC_DIR/$rel" "$dest"
  else
    curl -fsSL "$RAW_BASE/$rel" -o "$dest" || die "failed to fetch $rel from $RAW_BASE"
  fi
}

say ""
say "${BOLD}claude-code-statusline${RST} ${DIM}(${MODE} source)${RST}"
say "  config dir : ${CONFIG_DIR}"
say "  hook       : $([ "$INSTALL_HOOK" = 1 ] && echo yes || echo no)   skill: $([ "$INSTALL_SKILL" = 1 ] && echo yes || echo no)"
[ "$DRY_RUN" = 1 ] && say "  ${YLW}dry-run: no files will be written${RST}"
say ""

run() { if [ "$DRY_RUN" = 1 ]; then printf '  %swould:%s %s\n' "$DIM" "$RST" "$*"; else eval "$*"; fi; }

backup_settings() {
  local settings="$1"
  [ -f "$settings" ] || return 0
  run "cp '$settings' '$settings.bak.$(date +%Y%m%d-%H%M%S)'"
}

# jq_write <settings-file> <jq-filter> [--arg name val ...] — merge, validate, write back (backup first)
jq_write() {
  local settings="$1"; shift
  local filter="$1"; shift
  [ -f "$settings" ] || { run "mkdir -p '$(dirname "$settings")'"; [ "$DRY_RUN" = 1 ] || echo '{}' > "$settings"; }
  if [ "$DRY_RUN" = 1 ]; then printf '  %swould:%s jq update %s\n' "$DIM" "$RST" "$settings"; return 0; fi
  backup_settings "$settings"
  local tmp; tmp="$(mktemp)"
  if jq "$@" "$filter" "$settings" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$settings"
  else
    rm -f "$tmp"
    die "could not update $settings with jq (is it valid JSON?). Nothing changed."
  fi
}

SETTINGS="$CONFIG_DIR/settings.json"
# Must stay byte-identical with the string hooks/statusline-guard.mjs compares against.
CONFIG_DIR_TOKEN='${CLAUDE_CONFIG_DIR:-$HOME/.claude}'
DESIRED_CMD="node ${CONFIG_DIR_TOKEN}/statusline/hud.mjs"

# 1. HUD script
step "Installing HUD -> $CONFIG_DIR/statusline/hud.mjs"
run "mkdir -p '$CONFIG_DIR/statusline/lib'"
if [ "$DRY_RUN" != 1 ]; then
  get_file "statusline/hud.mjs" "$CONFIG_DIR/statusline/hud.mjs"
  get_file "statusline/lib/usage.mjs" "$CONFIG_DIR/statusline/lib/usage.mjs"
  run "chmod +x '$CONFIG_DIR/statusline/hud.mjs'"
fi
ok "HUD in place"

# 2. settings.json statusLine
step "Pointing settings.json statusLine at the HUD"
jq_write "$SETTINGS" '.statusLine = {type:"command", command:$cmd}' --arg cmd "$DESIRED_CMD"
ok "statusLine.command set"

# 3. SessionStart auto-heal hook
if [ "$INSTALL_HOOK" = 1 ]; then
  step "Installing SessionStart auto-heal hook -> $CONFIG_DIR/hooks/statusline-guard.mjs"
  run "mkdir -p '$CONFIG_DIR/hooks'"
  [ "$DRY_RUN" = 1 ] || get_file "hooks/statusline-guard.mjs" "$CONFIG_DIR/hooks/statusline-guard.mjs"
  HOOK_CMD="node ${CONFIG_DIR_TOKEN}/hooks/statusline-guard.mjs"
  jq_write "$SETTINGS" '
    .hooks = (.hooks // {})
    | .hooks.SessionStart = (.hooks.SessionStart // [])
    | if ([.hooks.SessionStart[]?.hooks[]?.command] | any(. == $hookcmd))
      then .
      else .hooks.SessionStart += [{hooks:[{type:"command", command:$hookcmd}]}]
      end
  ' --arg hookcmd "$HOOK_CMD"
  ok "auto-heal hook registered"
fi

# 4. Re-apply skill
if [ "$INSTALL_SKILL" = 1 ]; then
  step "Installing re-apply skill -> $CONFIG_DIR/skills/claude-code-statusline/"
  run "mkdir -p '$CONFIG_DIR/skills/claude-code-statusline'"
  [ "$DRY_RUN" = 1 ] || get_file "skill/claude-code-statusline/SKILL.md" "$CONFIG_DIR/skills/claude-code-statusline/SKILL.md"
  ok "skill installed (invoke: /claude-code-statusline)"
fi

say ""
ok "${BOLD}Done.${RST} Open a new Claude Code session to see the HUD."
say ""
