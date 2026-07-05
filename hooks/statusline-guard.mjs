#!/usr/bin/env node
/**
 * claude-code-statusline — SessionStart auto-heal hook.
 *
 * Problem: `omc update` (and some setup flows) rewrite settings.json and reset
 * `statusLine.command` back to their default, dropping the claude-code-statusline
 * wrapper. This hook runs on SessionStart and, if it detects that drift, quietly
 * re-points statusLine.command at the installed script.
 *
 * It only writes when it finds drift, so a healthy config incurs no churn. It
 * never throws out of the process — a statusline hook must never break a session.
 *
 * Registered by install.sh as:
 *   settings.json > hooks.SessionStart[] > { type:"command",
 *     command:"node ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/statusline-guard.mjs" }
 *
 * Note: the fix lands in settings.json immediately, but the running session may
 * have already read the old value — expect it to take full effect from the next
 * render/session. That is still zero manual steps per update.
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The literal token string must match exactly what install.sh writes, so drift
// comparison is a plain string equality check.
const CONFIG_TOKEN = "${CLAUDE_CONFIG_DIR:-$HOME/.claude}";

function main() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const settingsPath = join(configDir, "settings.json");
  if (!existsSync(settingsPath)) return; // nothing to heal

  // Decide the desired command from what is actually installed on disk.
  let desired = null;
  if (existsSync(join(configDir, "hud", "omc-hud-plus.sh"))) {
    desired = `sh ${CONFIG_TOKEN}/hud/omc-hud-plus.sh`;
  } else if (existsSync(join(configDir, "statusline-command.sh"))) {
    desired = `bash ${CONFIG_TOKEN}/statusline-command.sh`;
  } else {
    return; // no claude-code-statusline script installed — do nothing
  }

  let raw;
  try {
    raw = readFileSync(settingsPath, "utf8");
  } catch {
    return;
  }

  let settings;
  try {
    settings = JSON.parse(raw);
  } catch {
    return; // JSONC / malformed — refuse to touch it
  }

  const current = settings?.statusLine?.command ?? null;
  if (current === desired) return; // already correct — no write

  // Heal: back up once per drift, then rewrite preserving all other keys.
  settings.statusLine = { type: "command", command: desired };
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(settingsPath, `${settingsPath}.bak.${stamp}`);
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  } catch {
    // If we cannot write, stay silent; a broken heal must not break the session.
  }
}

try {
  main();
} catch {
  /* never propagate */
}
process.exit(0);
