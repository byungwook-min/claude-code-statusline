#!/usr/bin/env node
/**
 * Anthropic subscription usage (5-hour / 7-day rate limits).
 *
 * Claude Code's statusLine stdin does NOT carry rate-limit utilization, so we
 * fetch it from the same endpoint the app itself uses:
 *   GET https://api.anthropic.com/api/oauth/usage
 * authenticated with the OAuth access token Claude Code stores in the macOS
 * Keychain (falling back to ~/.claude/.credentials.json on other platforms).
 *
 * The network round-trip must never block a render, so the read path is:
 *   read cache -> return immediately -> if stale, spawn a detached refresh
 * A refreshed value therefore lands on the NEXT render, which is fine for a
 * figure that moves on the order of minutes.
 *
 * Run directly (`node usage.mjs --refresh`) to perform the fetch+write; that is
 * exactly what the detached background refresh invokes.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";

const CACHE_TTL_MS = 5 * 60 * 1000; // serve from cache for 5 minutes
const REFRESH_LOCK_MS = 60 * 1000; // at most one refresh attempt per minute

export function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

export function cachePath() {
  return join(configDir(), "statusline", "usage-cache.json");
}

/**
 * Keychain service name. Claude Code namespaces the entry by a hash of
 * CLAUDE_CONFIG_DIR when a non-default config dir is in play, so mirror that
 * exactly or we would read another profile's token (or none at all).
 */
function keychainService() {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  if (!dir) return "Claude Code-credentials";
  return `Claude Code-credentials-${createHash("sha256").update(dir).digest("hex").slice(0, 8)}`;
}

function readKeychainToken() {
  try {
    const raw = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", keychainService(), "-w"],
      { encoding: "utf-8", timeout: 2000, stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed.claudeAiOauth || parsed;
  } catch {
    return null;
  }
}

function readFileToken() {
  try {
    const p = join(configDir(), ".credentials.json");
    if (!existsSync(p)) return null;
    const parsed = JSON.parse(readFileSync(p, "utf-8"));
    return parsed.claudeAiOauth || parsed;
  } catch {
    return null;
  }
}

function getToken() {
  const creds = readKeychainToken() || readFileToken();
  return creds?.accessToken ? creds : null;
}

function fetchUsage(accessToken) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.anthropic.com",
        path: "/api/oauth/usage",
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
        timeout: 5000,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end();
  });
}

/** Reduce the API response to just what the statusline draws. */
function shape(raw) {
  return {
    fiveHourPercent: raw?.five_hour?.utilization ?? null,
    fiveHourResetsAt: raw?.five_hour?.resets_at ?? null,
    weeklyPercent: raw?.seven_day?.utilization ?? null,
    weeklyResetsAt: raw?.seven_day?.resets_at ?? null,
  };
}

export function readCache() {
  try {
    return JSON.parse(readFileSync(cachePath(), "utf-8"));
  } catch {
    return null;
  }
}

function writeCache(entry) {
  const p = cachePath();
  mkdirSync(dirname(p), { recursive: true });
  // Write-then-rename so a concurrent reader never sees a half-written file.
  const tmp = `${p}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(entry));
  renameSync(tmp, p);
}

/** Fetch and persist. Used by the detached refresh and by `--refresh`. */
export async function refresh() {
  const creds = getToken();
  if (!creds) {
    writeCache({ timestamp: Date.now(), data: null, error: "no-credentials" });
    return null;
  }
  try {
    const data = shape(await fetchUsage(creds.accessToken));
    writeCache({ timestamp: Date.now(), data, error: null });
    return data;
  } catch (e) {
    // Keep the last good data so a transient failure does not blank the line.
    const prev = readCache();
    writeCache({
      timestamp: Date.now(),
      data: prev?.data ?? null,
      error: String(e.message || e),
      lastSuccessAt: prev?.lastSuccessAt ?? null,
    });
    return prev?.data ?? null;
  }
}

/**
 * Non-blocking read for the render path: return whatever is cached right now,
 * and kick off a detached refresh when the cache is older than the TTL.
 */
export function getUsageCached() {
  const cached = readCache();
  const age = cached ? Date.now() - cached.timestamp : Infinity;

  if (age > CACHE_TTL_MS && age > REFRESH_LOCK_MS) {
    try {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--refresh"], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    } catch {
      // A failed refresh must never break the render.
    }
  }
  return cached?.data ?? null;
}

// Allow `node usage.mjs --refresh` (the detached background path).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--refresh")) await refresh();
}
