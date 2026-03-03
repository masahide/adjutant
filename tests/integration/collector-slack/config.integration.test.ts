import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveCollectorCdpEndpoint } from "../../../src/collector-slack/config.js";

test("resolveCollectorCdpEndpoint reads endpoint file from disk", () => {
  const root = mkdtempSync(join(tmpdir(), "adjutant-collector-config-"));
  const endpointPath = join(root, ".adjutant", "cdp-endpoint.json");
  mkdirSync(join(root, ".adjutant"), { recursive: true });
  writeFileSync(endpointPath, JSON.stringify({ host: "172.16.0.10", port: 9666 }), "utf8");

  const endpoint = resolveCollectorCdpEndpoint({
    env: {
      CDP_ENDPOINT_FILE: ".adjutant/cdp-endpoint.json",
      CDP_HOST: "127.0.0.1",
      CDP_PORT: "9222",
    },
    cwd: root,
  });

  assert.equal(endpoint.host, "172.16.0.10");
  assert.equal(endpoint.port, 9666);
  assert.equal(endpoint.source, "file");
  assert.equal(endpoint.endpointFilePath, endpointPath);
});
