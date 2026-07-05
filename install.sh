#!/usr/bin/env bash
#
# claude-code-statusline installer.
#
# Installs a Claude Code statusline that surfaces token in/out, prompt-cache
# read/write, per-turn cost delta, and cumulative session cost.
#
# Two flavors, auto-detected:
#   - omc        : you run oh-my-claudecode. Installs omc-hud-plus.sh, a thin
#                  wrapper that keeps the OMC HUD and appends a metrics line.
#   - standalone : no OMC. Installs a self-contained statusline script.
#
# Safe to re-run. Every settings.json write is backed up first. Designed to be
# run from a local clone OR piped straight from the web:
#   curl -fsSL https://raw.githubusercontent.com/byungwook-min/claude-code-statusline/main/install.sh | bash
#
set -euo pipefail

# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------
REPO_SLUG="byungwook-min/claude-code-statusline"
BRANCH="main"
RAW_BASE="${STATUSLINE_REPO_RAW:-https://raw.githubusercontent.com/${REPO_SLUG}/${BRANCH}}"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

FLAVOR="auto"          # auto | omc | standalone
INSTALL_HOOK=1         # install the SessionStart auto-heal hook
INSTALL_SKILL=1        # install the re-apply skill into ~/.claude/skills
FORCE_HUD_CONFIG=0     # overwrite an existing omcHud block
DRY_RUN=0

# --------------------------------------------------------------------------
# Pretty output
# --------------------------------------------------------------------------
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'
  YLW=$'\033[33m'; CYN=$'\033[36m'; RST=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GRN=""; YLW=""; CYN=""; RST=""
fi
say()  { printf '%s\n' "$*"; }
step() { printf '%s➜%s %s\n' "$CYN" "$RST" "$*"; }
ok()   { printf '%s✓%s %s\n' "$GRN" "$RST" "$*"; }
warn() { printf '%s!%s %s\n' "$YLW" "$RST" "$*" >&2; }
die()  { printf '%s✗%s %s\n' "$RED" "$RST" "$*" >&2; exit 1; }

show_help() {
  cat <<EOF
${BOLD}claude-code-statusline installer${RST}

Usage: install.sh [options]

Options:
  --omc                Force the OMC-wrapper flavor
  --standalone         Force the standalone flavor
  --no-hook            Do not install the SessionStart auto-heal hook
  --no-skill           Do not install the re-apply skill
  --force-hud-config   Overwrite an existing omcHud block (OMC flavor)
  --print, --dry-run   Show what would happen; write nothing
  --config-dir DIR     Target config dir (default: \$CLAUDE_CONFIG_DIR or ~/.claude)
  -h, --help           This help

Env:
  CLAUDE_CONFIG_DIR    Claude config dir
  STATUSLINE_REPO_RAW  Raw base URL for remote fetch (default: this repo's main)
EOF
}

# --------------------------------------------------------------------------
# Args
# --------------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --omc) FLAVOR=omc ;;
    --standalone) FLAVOR=standalone ;;
    --no-hook) INSTALL_HOOK=0 ;;
    --no-skill) INSTALL_SKILL=0 ;;
    --force-hud-config) FORCE_HUD_CONFIG=1 ;;
    --print|--dry-run) DRY_RUN=1 ;;
    --config-dir) CONFIG_DIR="${2:?--config-dir needs a value}"; shift ;;
    -h|--help) show_help; exit 0 ;;
    *) die "unknown argument: $1  (see --help)" ;;
  esac
  shift
done

command -v jq >/dev/null 2>&1 || die "jq is required. Install it (e.g. 'brew install jq') and re-run."

# --------------------------------------------------------------------------
# Source resolution: local clone vs curl-piped
# --------------------------------------------------------------------------
SOURCE="${BASH_SOURCE[0]:-$0}"
SRC_DIR=""
if [ -f "$SOURCE" ]; then
  SRC_DIR="$(cd "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd -P)" || SRC_DIR=""
fi
if [ -n "$SRC_DIR" ] && [ -f "$SRC_DIR/statusline/omc-hud-plus.sh" ]; then
  MODE="local"
else
  MODE="remote"
fi

# get_file <relpath> <dest> : copy from local clone, else download from RAW_BASE
get_file() {
  local rel="$1" dest="$2"
  if [ "$MODE" = "local" ] && [ -f "$SRC_DIR/$rel" ]; then
    cp "$SRC_DIR/$rel" "$dest"
  else
    curl -fsSL "$RAW_BASE/$rel" -o "$dest" || die "failed to fetch $rel from $RAW_BASE"
  fi
}

# --------------------------------------------------------------------------
# Flavor detection
# --------------------------------------------------------------------------
if [ "$FLAVOR" = "auto" ]; then
  if [ -f "$CONFIG_DIR/hud/omc-hud-cache.sh" ]; then
    FLAVOR="omc"
  else
    FLAVOR="standalone"
  fi
fi

say ""
say "${BOLD}claude-code-statusline${RST} ${DIM}(${MODE} source)${RST}"
say "  config dir : ${CONFIG_DIR}"
say "  flavor     : ${BOLD}${FLAVOR}${RST}"
say "  hook       : $([ "$INSTALL_HOOK" = 1 ] && echo yes || echo no)   skill: $([ "$INSTALL_SKILL" = 1 ] && echo yes || echo no)"
[ "$DRY_RUN" = 1 ] && say "  ${YLW}dry-run: no files will be written${RST}"
say ""

run() { # echo + execute (or just echo under --dry-run)
  if [ "$DRY_RUN" = 1 ]; then printf '  %swould:%s %s\n' "$DIM" "$RST" "$*"; else eval "$*"; fi
}

backup_settings() {
  local settings="$1"
  [ -f "$settings" ] || return 0
  local ts; ts="$(date +%Y%m%d-%H%M%S)"
  run "cp '$settings' '$settings.bak.$ts'"
}

# jq_write <settings-file> <jq-filter> [--arg name val ...]
# Applies filter, validates, writes back. Backs up first.
jq_write() {
  local settings="$1"; shift
  local filter="$1"; shift
  [ -f "$settings" ] || { run "mkdir -p '$(dirname "$settings")'"; [ "$DRY_RUN" = 1 ] || echo '{}' > "$settings"; }
  if [ "$DRY_RUN" = 1 ]; then
    printf '  %swould:%s jq update %s\n' "$DIM" "$RST" "$settings"
    return 0
  fi
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

# --------------------------------------------------------------------------
# 1. Place the statusline script + compute the desired command
# --------------------------------------------------------------------------
CONFIG_DIR_TOKEN='${CLAUDE_CONFIG_DIR:-$HOME/.claude}'
if [ "$FLAVOR" = "omc" ]; then
  if [ ! -f "$CONFIG_DIR/hud/omc-hud-cache.sh" ]; then
    warn "OMC HUD launcher not found at $CONFIG_DIR/hud/omc-hud-cache.sh."
    warn "The wrapper needs it. Install oh-my-claudecode, or re-run with --standalone."
  fi
  step "Installing OMC wrapper -> $CONFIG_DIR/hud/omc-hud-plus.sh"
  run "mkdir -p '$CONFIG_DIR/hud'"
  if [ "$DRY_RUN" != 1 ]; then get_file "statusline/omc-hud-plus.sh" "$CONFIG_DIR/hud/omc-hud-plus.sh"; run "chmod +x '$CONFIG_DIR/hud/omc-hud-plus.sh'"; fi
  DESIRED_CMD="sh ${CONFIG_DIR_TOKEN}/hud/omc-hud-plus.sh"
else
  step "Installing standalone statusline -> $CONFIG_DIR/statusline-command.sh"
  run "mkdir -p '$CONFIG_DIR'"
  if [ "$DRY_RUN" != 1 ]; then get_file "statusline/standalone.sh" "$CONFIG_DIR/statusline-command.sh"; run "chmod +x '$CONFIG_DIR/statusline-command.sh'"; fi
  DESIRED_CMD="bash ${CONFIG_DIR_TOKEN}/statusline-command.sh"
fi
ok "statusline script in place"

# --------------------------------------------------------------------------
# 2. Point settings.json statusLine at it
# --------------------------------------------------------------------------
step "Pointing settings.json statusLine at the script"
jq_write "$SETTINGS" '.statusLine = {type:"command", command:$cmd}' --arg cmd "$DESIRED_CMD"
ok "statusLine.command set"

# OMC look: set omcHud only if missing (or --force-hud-config), never clobber tweaks silently
if [ "$FLAVOR" = "omc" ]; then
  if [ "$FORCE_HUD_CONFIG" = 1 ] || [ "$DRY_RUN" = 1 ] || ! jq -e '.omcHud' "$SETTINGS" >/dev/null 2>&1; then
    step "Setting a sensible omcHud default (focused preset)"
    jq_write "$SETTINGS" '.omcHud = (.omcHud // {}) * {preset:"focused", elementOrder:["omcLabel","model","contextBar"], elements:{thinking:false, useBars:false}}'
    ok "omcHud configured"
  else
    say "  ${DIM}omcHud already present — left as-is (use --force-hud-config to overwrite)${RST}"
  fi
fi

# --------------------------------------------------------------------------
# 3. Auto-heal SessionStart hook
# --------------------------------------------------------------------------
if [ "$INSTALL_HOOK" = 1 ]; then
  step "Installing SessionStart auto-heal hook -> $CONFIG_DIR/hooks/statusline-guard.mjs"
  run "mkdir -p '$CONFIG_DIR/hooks'"
  if [ "$DRY_RUN" != 1 ]; then get_file "hooks/statusline-guard.mjs" "$CONFIG_DIR/hooks/statusline-guard.mjs"; fi
  HOOK_CMD="node ${CONFIG_DIR_TOKEN}/hooks/statusline-guard.mjs"
  jq_write "$SETTINGS" '
    .hooks = (.hooks // {})
    | .hooks.SessionStart = (.hooks.SessionStart // [])
    | if ([.hooks.SessionStart[]?.hooks[]?.command] | any(. == $hookcmd))
      then .
      else .hooks.SessionStart += [{hooks:[{type:"command", command:$hookcmd}]}]
      end
  ' --arg hookcmd "$HOOK_CMD"
  ok "auto-heal hook registered (re-asserts statusLine on each session)"
fi

# --------------------------------------------------------------------------
# 4. Re-apply skill
# --------------------------------------------------------------------------
if [ "$INSTALL_SKILL" = 1 ]; then
  step "Installing re-apply skill -> $CONFIG_DIR/skills/claude-code-statusline/"
  run "mkdir -p '$CONFIG_DIR/skills/claude-code-statusline'"
  if [ "$DRY_RUN" != 1 ]; then get_file "skill/claude-code-statusline/SKILL.md" "$CONFIG_DIR/skills/claude-code-statusline/SKILL.md"; fi
  ok "skill installed (invoke: /claude-code-statusline)"
fi

# --------------------------------------------------------------------------
# Done
# --------------------------------------------------------------------------
say ""
ok "${BOLD}Done.${RST}"
say "  Open a new Claude Code session (or trigger a render) to see it."
if [ "$FLAVOR" = "omc" ]; then
  say "  ${DIM}After 'omc update' resets things, the hook auto-restores it — or run /claude-code-statusline.${RST}"
fi
say ""
