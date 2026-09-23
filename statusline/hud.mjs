#!/usr/bin/env node
/**
 * claude-code-statusline — three-line HUD, no third-party runtime.
 *
 * Replaces the compiled oh-my-claudecode HUD with a self-contained renderer we
 * own. Layout:
 *
 *   branch:<branch> (wt:<worktree>) | ?N            <- git context
 *   Model: X | ctx:N% | 5h:N%(reset) wk:N%(reset) | session:Nm
 *   in:… out:… | cache r:… w:… · 1h(52m) | Δ$… | $…  <- token/cache/cost metrics
 *
 * Everything comes from the statusLine stdin JSON; nothing is fetched.
 *
 * Design constraints:
 *  - Never throw. A statusline that crashes leaves the user with a blank bar,
 *    so every optional section is individually guarded and simply omitted.
 *  - Never block. git calls carry a timeout; nothing else leaves the process.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

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

/** "4h33m" / "12m" — time left until an epoch-seconds instant; null once passed. */
function fmtUntil(epochSec) {
  if (epochSec == null) return null;
  const ms = Number(epochSec) * 1000 - Date.now();
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

  // rate_limits is only in the payload for Pro/Max, and only after the first
  // API response. The segments are always rendered; "--" stands in until then,
  // so the line keeps its shape from the very first render.
  const rl = payload?.rate_limits ?? {};
  const rate = (label, win) => {
    if (win?.used_percentage == null) return `${DIM}${label}:--%${RST}`;
    const pct = Math.round(Number(win.used_percentage));
    const u = fmtUntil(win.resets_at);
    return `${DIM}${label}:${RST}${pctColor(pct)}${pct}%${RST}` + (u ? `${DIM}(${u})${RST}` : "");
  };
  parts.push([rate("5h", rl.five_hour), rate("wk", rl.seven_day)].join(" "));

  const mins = sessionMinutes(payload?.session_id) ?? 0;
  parts.push(`session:${GREEN}${mins}m${RST}`);

  return parts.length ? parts.join(`${DIM} | ${RST}`) : null;
}

/* ---------- line 3: token / cache / cost metrics ---------- */
const CACHE_WARN_MS = 10 * 60 * 1000;
const MISS_SHOW_MS = 2 * 60 * 1000;

/**
 * "· 1h(52m)" while warm, "· 1h(COLD +135k)" once the prefix has expired
 * (the +N is what the next request re-caches), "· --(--)" before the first
 * API response. A miss in the last two minutes appends its diagnosed cause.
 */
function cacheState(pc) {
  if (!pc?.ttl) return `${DIM}· --(--)${RST}`;
  // warm is as of the last response; the clock may have run past expires_at since.
  const msLeft = pc.warm && pc.expires_at ? pc.expires_at * 1000 - Date.now() : 0;
  let body;
  if (msLeft > 0) {
    body = `${msLeft < CACHE_WARN_MS ? YELLOW : GREEN}${fmtUntil(pc.expires_at)}${RST}`;
  } else {
    const re = pc.recache_tokens_if_cold;
    body = `${RED}COLD${re ? ` +${fmtTokens(re)}` : ""}${RST}`;
  }
  let out = `${DIM}· ${pc.ttl}(${RST}${body}${DIM})${RST}`;
  const causes = pc.last_miss_cause?.causes;
  if (causes?.length && pc.last_miss_at && Date.now() - pc.last_miss_at * 1000 < MISS_SHOW_MS) {
    out += ` ${YELLOW}miss:${causes.join(",")}${RST}`;
  }
  return out;
}

function lineMetrics(payload) {
  const cw = payload?.context_window ?? {};
  const cu = cw.current_usage ?? {};
  const tokIn = cw.total_input_tokens ?? 0;
  const tokOut = cw.total_output_tokens ?? 0;
  const cRead = cu.cache_read_input_tokens ?? 0;
  const cWrite = cu.cache_creation_input_tokens ?? 0;
  const costTotal = Number(payload?.cost?.total_cost_usd ?? 0);

  // Rendered unconditionally, including the all-zero first render: a statusline
  // that changes height between turns makes the terminal jump.

  let line =
    `${DIM}in:${fmtTokens(tokIn)} out:${fmtTokens(tokOut)}${RST} ` +
    `${DIM}| cache r:${fmtTokens(cRead)} w:${fmtTokens(cWrite)}${RST} ` +
    cacheState(payload?.prompt_cache);

  // Per-turn delta: cost_total is cumulative, so diff it against the previous
  // render. Renders also fire on the refreshInterval timer with an unchanged
  // total, so the last delta is kept until the total moves again — otherwise
  // Δ$ would flicker to 0.00 between turns. Skipped on the very first render,
  // where the "delta" would be the whole total. Both cost segments are always
  // rendered (Δ$0.00 / $0.00 on the first turn) so the line never changes width.
  const sid = payload?.session_id;
  let delta = 0;
  if (sid) {
    try {
      const f = join(tmpdir(), `claude-statusline-cost.${sid}`);
      let prev = null;
      if (existsSync(f)) {
        try {
          prev = JSON.parse(readFileSync(f, "utf-8"));
        } catch {
          prev = null; // unreadable — fall through and rewrite it
        }
      }
      if (typeof prev === "number") prev = { cost: prev, delta: 0 }; // pre-JSON file format
      if (prev) delta = costTotal === prev.cost ? prev.delta ?? 0 : Math.max(0, costTotal - prev.cost);
      writeFileSync(f, JSON.stringify({ cost: costTotal, delta }));
    } catch {
      /* optional */
    }
  }
  const deltaStr = delta > 0 && delta < 0.01 ? delta.toFixed(4) : delta.toFixed(2);
  line += ` ${DIM}|${RST} ${MAGENTA}Δ$${deltaStr}${RST}`;
  line += ` ${DIM}|${RST} ${GREEN}$${costTotal.toFixed(2)}${RST}`;
  return line;
}

function main() {
  const payload = readStdin();
  const cwd = payload?.workspace?.current_dir || payload?.cwd || process.cwd();
  const wtHint = payload?.workspace?.git_worktree || null;
  for (const l of [lineGit(cwd, wtHint), lineStatus(payload), lineMetrics(payload)]) {
    if (l) console.log(l);
  }
}

try {
  main();
} catch {
  // Never leave the user with a broken bar.
}
process.exit(0);
