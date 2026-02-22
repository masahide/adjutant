import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadPolicyRouting, resolveRoutingRule } from "../../src/proactive/policy-routing.js";
import { POLICY_ROUTING_SCHEMA_V1 } from "../../src/proactive/types.js";

describe("policy-routing", () => {
  it("ファイル不在時は default policy を返す", async () => {
    const dir = await mkdtemp(`${tmpdir()}/adjutant-policy-routing-`);
    try {
      const path = join(dir, "POLICY_ROUTING.json");
      const policy = await loadPolicyRouting({ path });
      assert.equal(policy.schema, POLICY_ROUTING_SCHEMA_V1);
      assert.deepEqual(policy.channels, {});
      assert.deepEqual(policy.defaults, {});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("defaults と channel ルールを読み込み、channel 側を優先する", async () => {
    const dir = await mkdtemp(`${tmpdir()}/adjutant-policy-routing-`);
    try {
      const path = join(dir, "POLICY_ROUTING.json");
      await writeFile(
        path,
        JSON.stringify(
          {
            schema: POLICY_ROUTING_SCHEMA_V1,
            defaults: { notifyBudgetPerHour: 2, cooldownMs: 30_000 },
            channels: {
              C123: { priority: "high", notifyBudgetPerHour: 5 },
            },
          },
          null,
          2
        ),
        "utf8"
      );

      const policy = await loadPolicyRouting({ path });
      const rule = resolveRoutingRule(policy, "C123");
      assert.equal(rule.priority, "high");
      assert.equal(rule.notifyBudgetPerHour, 5);
      assert.equal(rule.cooldownMs, 30_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("壊れた JSON は warning を出して default policy にフォールバックする", async () => {
    const dir = await mkdtemp(`${tmpdir()}/adjutant-policy-routing-`);
    try {
      const path = join(dir, "POLICY_ROUTING.json");
      await writeFile(path, "{ broken", "utf8");
      const warnings: string[] = [];
      const policy = await loadPolicyRouting({
        path,
        onWarn: (message) => warnings.push(message),
      });
      assert.equal(policy.schema, POLICY_ROUTING_SCHEMA_V1);
      assert.equal(warnings.includes("policy-routing-parse-failed"), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
