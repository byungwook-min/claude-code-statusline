import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";

const GUARD = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "statusline-guard.mjs");
const CMD = "node ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/statusline/hud.mjs";

function runGuard(settings) {
  const dir = mkdtempSync(join(tmpdir(), "guard-"));
  mkdirSync(join(dir, "statusline"));
  writeFileSync(join(dir, "statusline", "hud.mjs"), "");
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings, null, 2) + "\n");
  const out = spawnSync(process.execPath, [GUARD], { env: { ...process.env, CLAUDE_CONFIG_DIR: dir }, encoding: "utf-8" });
  assert.equal(out.status, 0);
  return {
    statusLine: JSON.parse(readFileSync(join(dir, "settings.json"), "utf-8")).statusLine,
    backups: readdirSync(dir).filter((f) => f.startsWith("settings.json.bak.")).length,
  };
}

test("heals a statusLine that lost its refreshInterval", () => {
  const r = runGuard({ statusLine: { type: "command", command: CMD }, other: 1 });
  assert.deepEqual(r.statusLine, { type: "command", command: CMD, refreshInterval: 60 });
  assert.equal(r.backups, 1);
});

test("leaves a correct statusLine alone without writing", () => {
  const r = runGuard({ statusLine: { type: "command", command: CMD, refreshInterval: 60 } });
  assert.equal(r.backups, 0);
});

test("re-points a rewritten command", () => {
  const r = runGuard({ statusLine: { type: "command", command: "other" } });
  assert.deepEqual(r.statusLine, { type: "command", command: CMD, refreshInterval: 60 });
});
