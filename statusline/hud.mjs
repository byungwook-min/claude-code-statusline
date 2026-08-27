#!/usr/bin/env node
/**
 * claude-code-statusline — three-line HUD, no third-party runtime.
 *
 * Replaces the compiled oh-my-claudecode HUD with a self-contained renderer we
 * own. Layout:
 *
 *   branch:<branch> (wt:<worktree>) | ?N            <- git context
 *   Model: X | ctx:N% | 5h:N%(reset) wk:N%(reset) | session:Nm
 *
 * Everything except the rate limits comes from the statusLine stdin JSON.
 * Rate limits come from lib/usage.mjs, which serves a cache and refreshes in
 * the background so a render never waits on the network.
 *
 * Design constraints:
 *  - Never throw. A statusline that crashes leaves the user with a blank bar,
 *    so every optional section is individually guarded and simply omitted.
 *  - Never block. git calls carry a timeout; usage is cache-only on this path.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { getUsageCached } from "./lib/usage.mjs";

const DIM = "\x1b[2m";
const RST = "\x1b[0m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";
const BOLD = "\x1b[1m";

/** Green under 50%, yellow under 80%, red above — matches the old HUD. */
function pctColor(p) {
  if (p == null) return DIM;
  if (p >= 80) return RED;
  if (p >= 50) return YELLOW;
  return GREEN;
}

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf-8"));
  } catch {
    return {};
  }
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: 1000,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

/** Compact token counts: 1234567 -> 1.2m, 12345 -> 12k. */
function fmtTokens(n) {
  n = Number(n) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1000) return `${Math.floor(n / 1000)}k`;
  return String(n);
}

/** "4h33m" / "12m" — how long until a rate-limit window resets. */
function fmtUntil(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const mins = Math.floor(ms / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

/* ---------- line 1: git context ---------- */
const GIT_CACHE_TTL_MS = 30_000;

/**
 * `git status --porcelain` walks the whole worktree, which is slow in a large
 * monorepo and would run on every render. Cache the assembled line per cwd for
 * 30s — the same trade-off the previous HUD made.
 */
function gitCache(cwd, compute) {
  try {
    const key = Buffer.from(cwd).toString("base64url").slice(-40);
    const f = join(tmpdir(), `claude-statusline-git.${key}`);
    if (existsSync(f)) {
      const c = JSON.parse(readFileSync(f, "utf-8"));
      if (Date.now() - c.t < GIT_CACHE_TTL_MS) return c.v;
    }
    const v = compute();
    writeFileSync(f, JSON.stringify({ t: Date.now(), v }));
    return v;
  } catch {
    // Cache failure must not lose the data — fall back to computing directly.
    try {
      return compute();
    } catch {
      return null;
    }
  }
}

/**
 * @param cwd      directory to inspect
 * @param wtHint   workspace.git_worktree from the payload — used when the
 *                 directory is gone or git fails, so the line still says
 *                 something instead of vanishing and shrinking the statusline.
 */
function lineGit(cwd, wtHint) {
  if (!cwd) return null;
  return gitCache(cwd, () => {
    let branch = null;
    let worktree = null;
    let dirty = 0;
    try {
      branch = git(["branch", "--show-current"], cwd) || git(["rev-parse", "--short", "HEAD"], cwd);
    } catch {
      /* not a repo, or the dir is gone — fall through to the hint */
    }
    try {
      // In a linked worktree the toplevel basename names the worktree.
      const top = git(["rev-parse", "--show-toplevel"], cwd);
      if (top) worktree = basename(top);
    } catch {
      /* optional */
    }
    try {
      const st = git(["status", "--porcelain"], cwd);
      dirty = st ? st.split("\n").filter(Boolean).length : 0;
    } catch {
      /* optional */
    }

    if (!worktree && wtHint) worktree = wtHint;
    if (!branch && !worktree) return `${DIM}${basename(cwd)}${RST}`;

    let out = branch
      ? `${DIM}branch:${RST}${CYAN}${branch}${RST}`
      : `${DIM}${basename(cwd)}${RST}`;
    if (worktree) out += `${DIM} (wt:${RST}${CYAN}${worktree}${DIM})${RST}`;
    // Always show the dirty count, even 0 — keeps every segment in a fixed slot.
    out += `${DIM} | ${RST}${CYAN}?${RST}${dirty}`;
    return out;
  });
}

/* ---------- session duration ---------- */
/**
 * stdin carries no session start time, so stamp it on first sight and derive
 * elapsed minutes from that. Keyed per session in TMPDIR.
 */
function sessionMinutes(sessionId) {
  if (!sessionId) return null;
  try {
    const f = join(tmpdir(), `claude-statusline-start.${sessionId}`);
    let start;
    if (existsSync(f)) {
      start = Number(readFileSync(f, "utf-8").trim());
      // A stamp older than a day is a stale leftover (TMPDIR outlives sessions,
      // and ids can repeat in testing) — restart the clock rather than report
      // an absurd uptime.
      if (Number.isFinite(start) && Date.now() - start > 24 * 60 * 60 * 1000) start = NaN;
    }
    if (!Number.isFinite(start)) {
      start = Date.now();
      writeFileSync(f, String(start));
    }
    return Math.floor((Date.now() - start) / 60000);
  } catch {
    return null;
  }
}

/* ---------- line 2: model / context / usage / session ---------- */
function lineStatus(payload) {
  const parts = [];

  const model = payload?.model?.display_name;
  if (model) parts.push(`${CYAN}Model: ${model}${RST}`);

  // Always render ctx, even before the first API call reports usage
  // (used_percentage is null then). Keeping the field present holds the line
  // width steady instead of making segments appear a turn later.
  const p = Math.round(Number(payload?.context_window?.used_percentage ?? 0));
  parts.push(`ctx:${pctColor(p)}${p}%${RST}`);

  // Rate limits: cache-only read, refreshed out of band.
  let usage = null;
  try {
    usage = getUsageCached();
  } catch {
    /* optional */
  }
  // Rate-limit segments are always rendered; "--" stands in until the cache
  // has a value, so the line keeps its shape from the very first render.
  const rate = (label, pct, resetsAt) => {
    if (pct == null) return `${DIM}${label}:--%${RST}`;
    const u = fmtUntil(resetsAt);
    return `${DIM}${label}:${RST}${pctColor(pct)}${pct}%${RST}` + (u ? `${DIM}(${u})${RST}` : "");
  };
  parts.push(
    [
      rate("5h", usage?.fiveHourPercent, usage?.fiveHourResetsAt),
      rate("wk", usage?.weeklyPercent, usage?.weeklyResetsAt),
    ].join(" "),
  );

  const mins = sessionMinutes(payload?.session_id) ?? 0;
  parts.push(`session:${GREEN}${mins}m${RST}`);

  return parts.length ? parts.join(`${DIM} | ${RST}`) : null;
}

function main() {
  const payload = readStdin();
  const cwd = payload?.workspace?.current_dir || payload?.cwd || process.cwd();
  const wtHint = payload?.workspace?.git_worktree || null;
  for (const l of [lineGit(cwd, wtHint), lineStatus(payload)]) {
    if (l) console.log(l);
  }
}

try {
  main();
} catch {
  // Never leave the user with a broken bar.
}
process.exit(0);
