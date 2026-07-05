#!/usr/bin/env bash

# Read JSON input from stdin
input=$(cat)

# Extract values from JSON
current_dir=$(echo "$input" | jq -r '.workspace.current_dir')
model_name=$(echo "$input" | jq -r '.model.display_name')
git_worktree=$(echo "$input" | jq -r '.workspace.git_worktree // empty')
cost_total=$(echo "$input" | jq -r '.cost.total_cost_usd // 0')
tokens_in=$(echo "$input" | jq -r '.context_window.total_input_tokens // 0')
tokens_out=$(echo "$input" | jq -r '.context_window.total_output_tokens // 0')
cache_read=$(echo "$input" | jq -r '.context_window.current_usage.cache_read_input_tokens // 0')
cache_write=$(echo "$input" | jq -r '.context_window.current_usage.cache_creation_input_tokens // 0')
# Current context-window size — matches Claude Code's built-in token counter
# (the one that sometimes gets hidden behind the "current: … latest: …" version
# notice). This is a snapshot, not cumulative — it can drop after /clear or
# autocompact, which is what we want for a "how full is the window" display.
context_tokens=$(echo "$input" | jq -r '
    (.context_window.total_input_tokens // 0)
    + (.context_window.total_output_tokens // 0)
' 2>/dev/null) || context_tokens=0
context_tokens=${context_tokens:-0}

# Per-turn cost delta. cost_total is cumulative, so the diff between two
# consecutive renders equals the last turn's spend. State persisted per session
# in TMPDIR so concurrent sessions don't clobber each other.
session_id=$(echo "$input" | jq -r '.session_id // empty')
cost_delta_str=""
if [[ -n "$session_id" ]] && [[ "$cost_total" != "0" ]]; then
    state_file="${TMPDIR:-/tmp}/claude-statusline-cost.${session_id}"
    had_prior_state=0
    [[ -f "$state_file" ]] && had_prior_state=1
    prev_cost=0
    if [[ -r "$state_file" ]]; then
        prev_cost=$(cat "$state_file" 2>/dev/null) || prev_cost=0
        prev_cost=${prev_cost:-0}
    fi
    # Persist current cost for next render. Failure is non-fatal.
    printf '%s' "$cost_total" >| "$state_file" 2>/dev/null || true
    # Only show delta after we have a baseline (skip the very first render
    # of a session, where the "delta" would be the entire cumulative cost).
    if (( had_prior_state == 1 )); then
        cost_delta_str=$(awk -v a="$cost_total" -v b="$prev_cost" 'BEGIN {
            d = a - b
            if (d >= 0.01)      printf "%.2f", d
            else if (d > 0)     printf "%.4f", d
        }' 2>/dev/null) || cost_delta_str=""
    fi
fi

# Compact token formatter: 1234567 -> 1.2m, 12345 -> 12k, 999 -> 999
format_tokens() {
    local n=$1
    if (( n >= 1000000 )); then
        printf '%.1fm' "$(echo "scale=1; $n / 1000000" | bc -l)"
    elif (( n >= 1000 )); then
        printf '%dk' "$((n / 1000))"
    else
        printf '%d' "$n"
    fi
}

# Time in HH:MM:SS format (matching P10k config)
time_str=$(date '+%H:%M:%S')

# Context (user@host) - only show when root or in SSH (matching P10k CONTEXT behavior)
context=""
if [[ $EUID -eq 0 ]] || [[ -n "$SSH_CONNECTION" ]]; then
    if [[ $EUID -eq 0 ]]; then
        # Root: white username, grey @host
        context="$(printf '\033[2m\033[37m%s\033[0m\033[2m@%s \033[0m' "$(whoami)" "$(hostname -s)")"
    else
        # SSH: all grey
        context="$(printf '\033[2m%s@%s \033[0m' "$(whoami)" "$(hostname -s)")"
    fi
fi

# Directory (basename only, matching P10k Pure style) - blue color
dir_name=$(basename "$current_dir")

# Git information (matching P10k Pure style)
git_info=""
if git -C "$current_dir" rev-parse --git-dir >/dev/null 2>&1; then
    # Get branch name or commit hash if detached HEAD
    branch=$(git -C "$current_dir" branch --show-current 2>/dev/null)
    if [[ -z "$branch" ]]; then
        # Detached HEAD - show @commit (matching P10k VCS_COMMIT_ICON)
        branch="@$(git -C "$current_dir" rev-parse --short HEAD 2>/dev/null)"
    fi

    if [[ -n "$branch" ]]; then
        git_status=""
        # Check for dirty state (staged, unstaged, or untracked files)
        if ! git -C "$current_dir" diff --quiet 2>/dev/null || \
           ! git -C "$current_dir" diff --cached --quiet 2>/dev/null || \
           [[ -n $(git -C "$current_dir" ls-files --others --exclude-standard 2>/dev/null) ]]; then
            git_status="*"
        fi

        # Check for ahead/behind status
        upstream=$(git -C "$current_dir" rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null)
        if [[ -n "$upstream" ]]; then
            ahead_behind=$(git -C "$current_dir" rev-list --left-right --count HEAD...$upstream 2>/dev/null)
            ahead=$(echo "$ahead_behind" | awk '{print $1}')
            behind=$(echo "$ahead_behind" | awk '{print $2}')

            if [[ "$ahead" -gt 0 ]] && [[ "$behind" -gt 0 ]]; then
                git_status="${git_status}:⇣⇡"
            elif [[ "$behind" -gt 0 ]]; then
                git_status="${git_status}:⇣"
            elif [[ "$ahead" -gt 0 ]]; then
                git_status="${git_status}:⇡"
            fi
        fi

        git_info=" $branch$git_status"
    fi
fi

# Worktree indicator - use Claude Code JSON first, fallback to git detection
worktree_info=""
if [[ -n "$git_worktree" ]]; then
    worktree_info=" ⊞ $git_worktree"
else
    # Detect linked worktree: .git is a file (not a directory) in linked worktrees
    git_toplevel=$(git -C "$current_dir" rev-parse --show-toplevel 2>/dev/null)
    if [[ -n "$git_toplevel" ]] && [[ -f "$git_toplevel/.git" ]]; then
        worktree_info=" ⊞ $(basename "$git_toplevel")"
    fi
fi

# Session cost (formatted to 2 decimal places)
cost_info=""
if [[ "$cost_total" != "0" ]]; then
    cost_info=$(printf '$%.2f' "$cost_total")
fi

# Build the status line with colors matching P10k Pure theme
printf '%s\033[2m\033[34m%s\033[0m\033[2m%s%s\033[0m \033[2m%s\033[0m' \
    "$context" \
    "$dir_name" \
    "$git_info" \
    "$worktree_info" \
    "$time_str"
printf ' \033[2m|\033[0m \033[36m%s\033[0m' "$model_name"
printf ' \033[2m| in:%s out:%s\033[0m' "$(format_tokens "$tokens_in")" "$(format_tokens "$tokens_out")"
# Cache stats from last API call (current_usage). Helps spot prefix invalidators
# in real time: a healthy turn has high read, near-zero write.
printf ' \033[2m| cache r:%s w:%s\033[0m' "$(format_tokens "$cache_read")" "$(format_tokens "$cache_write")"
# Order: per-turn delta → session total → context tokens. Reads left-to-right
# as "this turn cost Δ$X → session total $Y".
[[ -n "$cost_delta_str" ]] && printf ' \033[2m|\033[0m \033[35mΔ$%s\033[0m' "$cost_delta_str"
[[ -n "$cost_info" ]] && printf ' \033[2m|\033[0m \033[32m%s\033[0m' "$cost_info"
# Current context-window size as raw integer, so it stays legible even when
# CC's built-in counter is hidden by the version-notice line.
if (( context_tokens > 0 )); then
    printf ' \033[2m|\033[0m \033[33m%d tokens\033[0m' "$context_tokens"
fi
