import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

const HUD = join(dirname(fileURLToPath(import.meta.url)), "..", "statusline", "hud.mjs");
const NOW = Math.floor(Date.now() / 1000);

function render(payload, sid = `t-${process.pid}-${Math.random().toString(36).slice(2)}`) {
  const out = spawnSync(process.execPath, [HUD], {
    input: JSON.stringify({ session_id: sid, workspace: { current_dir: tmpdir() }, ...payload }),
    encoding: "utf-8",
  });
  assert.equal(out.status, 0);
  assert.equal(out.stderr, "");
  return out.stdout.trimEnd().split("\n").map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
}

const withCache = (prompt_cache, extra = {}) => ({
  context_window: {
    total_input_tokens: 135000,
    total_output_tokens: 943,
    current_usage: { cache_read_input_tokens: 131520, cache_creation_input_tokens: 3537 },
  },
  cost: { total_cost_usd: 4.31 },
  prompt_cache,
  ...extra,
});

test("metrics line keeps a fixed shape before the first API response", () => {
  const [, , metrics] = render({ context_window: {}, cost: {} });
  assert.equal(metrics, "in:0 out:0 | cache r:0 w:0 · --(--) | Δ$0.00 | $0.00");
});

test("warm cache shows the TTL and time left until it goes cold", () => {
  const [, , metrics] = render(withCache({ warm: true, ttl: "1h", expires_at: NOW + 52 * 60 + 30 }));
  assert.equal(metrics, "in:135k out:943 | cache r:131k w:3k · 1h(52m) | Δ$0.00 | $4.31");
});

test("cold cache shows COLD and how many tokens the next request re-caches", () => {
  const [, , metrics] = render(
    withCache({ warm: false, ttl: "1h", expires_at: null, recache_tokens_if_cold: 135000 }),
  );
  assert.match(metrics, /cache r:131k w:3k · 1h\(COLD \+135k\) \|/);
});

test("a warm flag whose expires_at already passed renders as cold", () => {
  const [, , metrics] = render(
    withCache({ warm: true, ttl: "1h", expires_at: NOW - 5, recache_tokens_if_cold: 135000 }),
  );
  assert.match(metrics, /· 1h\(COLD \+135k\) \|/);
});

test("a miss within the last two minutes shows its cause", () => {
  const [, , metrics] = render(
    withCache({
      warm: true, ttl: "1h", expires_at: NOW + 3000,
      last_miss_at: NOW - 30, last_miss_cause: { causes: ["tools_changed"] },
    }),
  );
  assert.match(metrics, /· 1h\(49m\) miss:tools_changed \|/);
});

test("an old miss is not shown", () => {
  const [, , metrics] = render(
    withCache({
      warm: true, ttl: "1h", expires_at: NOW + 3000,
      last_miss_at: NOW - 600, last_miss_cause: { causes: ["tools_changed"] },
    }),
  );
  assert.doesNotMatch(metrics, /miss:/);
});

test("rate limits come from the payload, with reset countdown", () => {
  const [, status] = render({
    model: { display_name: "T" }, context_window: {}, cost: {},
    rate_limits: {
      five_hour: { used_percentage: 23.5, resets_at: NOW + 4 * 3600 + 33 * 60 + 20 },
      seven_day: { used_percentage: 41, resets_at: NOW + 2 * 86400 + 3 * 3600 + 60 },
    },
  });
  assert.equal(status, "Model: T | ctx:0% | 5h:24%(4h33m) wk:41%(2d3h) | session:0m");
});

test("rate-limit segments render as -- when the payload has none", () => {
  const [, status] = render({ model: { display_name: "T" }, context_window: {}, cost: {} });
  assert.equal(status, "Model: T | ctx:0% | 5h:--% wk:--% | session:0m");
});

test("Δ$ keeps the last turn's delta on renders where the total did not change", () => {
  const sid = `t-delta-${process.pid}`;
  const base = { context_window: {}, cost: { total_cost_usd: 1.0 } };
  try {
    render(base, sid);
    const [, , second] = render({ ...base, cost: { total_cost_usd: 1.15 } }, sid);
    assert.match(second, /Δ\$0\.15 \| \$1\.15$/);
    const [, , third] = render({ ...base, cost: { total_cost_usd: 1.15 } }, sid);
    assert.match(third, /Δ\$0\.15 \| \$1\.15$/);
  } finally {
    rmSync(join(tmpdir(), `claude-statusline-cost.${sid}`), { force: true });
    rmSync(join(tmpdir(), `claude-statusline-start.${sid}`), { force: true });
  }
});
