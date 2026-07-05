#!/bin/sh
# OMC HUD + metrics tail.
#
# Thin wrapper around the stock OMC HUD launcher (omc-hud-cache.sh). It runs the
# HUD unchanged, then appends one extra line with the numbers the HUD does not
# surface on consumer plans: last-turn in/out tokens, prompt-cache read/write,
# per-turn cost delta, and cumulative session cost.
#
# Why a wrapper instead of editing the HUD: omc-hud.mjs is generated and the
# compiled HUD lives in the auto-updating plugin cache. Wrapping keeps our
# additions in a user-owned file that survives OMC upgrades. Point settings.json
# statusLine.command at THIS script.
#
# Field paths match Claude Code's statusLine stdin JSON (verified against a live
# payload): cache figures come from context_window.current_usage, i.e. the LAST
# API call only — a healthy turn shows high read, near-zero write. A write spike
# means something invalidated the cached prompt prefix (= paying full price).

# Resolve this script's directory so we can find its siblings.
case "$0" in
  */*) SCRIPT_DIR=${0%/*} ;;
  *) SCRIPT_DIR=. ;;
esac
SCRIPT_DIR=$(cd "$SCRIPT_DIR" 2>/dev/null && pwd -P) || SCRIPT_DIR=.

HUD_LAUNCHER="$SCRIPT_DIR/omc-hud-cache.sh"
HUD_SCRIPT="$SCRIPT_DIR/omc-hud.mjs"

# Claude Code pipes the render JSON on stdin. Read it once; we feed it to both
# the HUD and our own jq extraction.
input=$(cat)

# Run the stock HUD. $() strips trailing newlines but preserves the HUD's own
# multi-line block. If the launcher is missing, HUD_OUT stays empty and we still
# emit the metrics line.
if [ -r "$HUD_LAUNCHER" ]; then
  HUD_OUT=$(printf '%s' "$input" | sh "$HUD_LAUNCHER" "$HUD_SCRIPT" 2>/dev/null)
else
  HUD_OUT=""
fi

# Print the HUD block first.
[ -n "$HUD_OUT" ] && printf '%s\n' "$HUD_OUT"

# Without jq we cannot parse the payload — emit HUD only and stop.
command -v jq >/dev/null 2>&1 || exit 0

# Single jq pass: space-joined so `set --` can split it. session_id is a UUID
# (no whitespace), so it is safe as the trailing field.
vals=$(printf '%s' "$input" | jq -r '
  [ (.context_window.total_input_tokens // 0),
    (.context_window.total_output_tokens // 0),
    (.context_window.current_usage.cache_read_input_tokens // 0),
    (.context_window.current_usage.cache_creation_input_tokens // 0),
    (.cost.total_cost_usd // 0),
    (.session_id // "nosession")
  ] | join(" ")' 2>/dev/null)
[ -n "$vals" ] || exit 0

# shellcheck disable=SC2086  # deliberate word-splitting of the joined jq output
set -- $vals
tok_in=$1; tok_out=$2; c_read=$3; c_write=$4; cost_total=$5; session_id=$6

# Compact token formatter: 1234567 -> 1.2m, 12345 -> 12k, 999 -> 999. awk keeps
# us free of a bc dependency.
fmt() {
  awk -v n="$1" 'BEGIN{
    if (n>=1000000) printf "%.1fm", n/1000000;
    else if (n>=1000)  printf "%dk", int(n/1000);
    else               printf "%d", n;
  }'
}

# Per-turn cost delta. cost_total is cumulative, so the diff between two renders
# is the last turn's spend. State is kept per session in TMPDIR so concurrent
# sessions do not clobber each other.
delta_str=""
if [ "$session_id" != "nosession" ] && [ "$cost_total" != "0" ]; then
  state_file="${TMPDIR:-/tmp}/omc-hud-costdelta.${session_id}"
  had_prior=0
  [ -f "$state_file" ] && had_prior=1
  prev_cost=0
  if [ -r "$state_file" ]; then
    prev_cost=$(cat "$state_file" 2>/dev/null) || prev_cost=0
    [ -n "$prev_cost" ] || prev_cost=0
  fi
  printf '%s' "$cost_total" >| "$state_file" 2>/dev/null || true
  # Skip the very first render (no baseline yet), else the "delta" would be the
  # entire cumulative cost.
  if [ "$had_prior" = "1" ]; then
    delta_str=$(awk -v a="$cost_total" -v b="$prev_cost" 'BEGIN{
      d=a-b;
      if (d>=0.01)    printf "%.2f", d;
      else if (d>0)   printf "%.4f", d;
    }' 2>/dev/null) || delta_str=""
  fi
fi

# Assemble the metrics line. Colors mirror the P10k-style shared script:
# dim labels, magenta delta, green cumulative total.
DIM='\033[2m'; RST='\033[0m'; MAG='\033[35m'; GRN='\033[32m'
line=$(printf "${DIM}in:%s out:%s${RST} ${DIM}| cache r:%s w:%s${RST}" \
  "$(fmt "$tok_in")" "$(fmt "$tok_out")" "$(fmt "$c_read")" "$(fmt "$c_write")")
[ -n "$delta_str" ] && line="$line$(printf " ${DIM}|${RST} ${MAG}Δ\$%s${RST}" "$delta_str")"
if [ "$cost_total" != "0" ]; then
  line="$line$(printf " ${DIM}|${RST} ${GRN}\$%.2f${RST}" "$cost_total")"
fi

printf '%b\n' "$line"
