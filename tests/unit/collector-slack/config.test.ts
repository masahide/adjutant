import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CDP_ENDPOINT_FILE,
  DEFAULT_CDP_HOST,
  DEFAULT_CDP_PORT,
  loadCollectorSlackConfig,
  resolveCollectorCdpEndpoint,
} from "../../../src/collector-slack/config.js";

test("resolveCollectorCdpEndpoint uses endpoint file first", () => {
  const endpoint = resolveCollectorCdpEndpoint({
    env: {
      CDP_ENDPOINT_FILE: "/tmp/adjutant/cdp-endpoint.json",
      CDP_HOST: "10.0.0.1",
      CDP_PORT: "9229",
    },
    exists: () => true,
    readFile: () => JSON.stringify({ host: "192.168.1.10", port: 9333 }),
  });

  assert.equal(endpoint.host, "192.168.1.10");
  assert.equal(endpoint.port, 9333);
  assert.equal(endpoint.source, "file");
});

test("resolveCollectorCdpEndpoint falls back to env when endpoint file is missing", () => {
  const endpoint = resolveCollectorCdpEndpoint({
    env: {
      CDP_HOST: "127.0.0.2",
      CDP_PORT: "9333",
    },
    cwd: "/tmp/work",
    exists: () => false,
  });

  assert.equal(endpoint.host, "127.0.0.2");
  assert.equal(endpoint.port, 9333);
  assert.equal(endpoint.source, "env");
  assert.equal(endpoint.endpointFilePath, "/tmp/work/.adjutant/cdp-endpoint.json");
});

test("resolveCollectorCdpEndpoint falls back to defaults when env is incomplete", () => {
  const endpoint = resolveCollectorCdpEndpoint({
    env: {
      CDP_HOST: "127.0.0.2",
    },
    exists: () => false,
  });

  assert.equal(endpoint.host, DEFAULT_CDP_HOST);
  assert.equal(endpoint.port, DEFAULT_CDP_PORT);
  assert.equal(endpoint.source, "default");
});

test("resolveCollectorCdpEndpoint ignores malformed endpoint file", () => {
  const endpoint = resolveCollectorCdpEndpoint({
    env: {
      CDP_ENDPOINT_FILE: "custom-endpoint.json",
      CDP_HOST: "10.20.30.40",
      CDP_PORT: "9444",
    },
    cwd: "/tmp/work",
    exists: () => true,
    readFile: () => "{ invalid json",
  });

  assert.equal(endpoint.host, "10.20.30.40");
  assert.equal(endpoint.port, 9444);
  assert.equal(endpoint.source, "env");
  assert.equal(endpoint.endpointFilePath, "/tmp/work/custom-endpoint.json");
});

test("loadCollectorSlackConfig resolves collector env defaults", () => {
  const config = loadCollectorSlackConfig({
    env: {
      ADJUTANT_STATE_DIR: "/tmp/state",
      ADJUTANT_COLLECTOR_SLACK_ENABLED: "1",
      ADJUTANT_DISABLE_DOM_CAPTURE: "true",
      ADJUTANT_DEBUG_UI: "1",
      ADJUTANT_DEBUG_UI_PORT: "9000",
    },
    exists: () => false,
  });

  assert.equal(config.collectorEnabled, true);
  assert.equal(config.collectorEntry, "src/collector-slack/main.ts");
  assert.equal(config.accountId, "default");
  assert.equal(config.dataDir, "/tmp/state/data");
  assert.equal(config.disableDomCapture, true);
  assert.equal(config.debugUiEnabled, true);
  assert.equal(config.debugUiPort, 9000);
  assert.equal(config.endpoint.source, "default");
});

test("loadCollectorSlackConfig prefers ADJUTANT_DATA_DIR over DATA_DIR", () => {
  const config = loadCollectorSlackConfig({
    env: {
      ADJUTANT_DATA_DIR: "/tmp/adjutant-data",
      DATA_DIR: "/tmp/legacy-data",
      CDP_ENDPOINT_FILE: DEFAULT_CDP_ENDPOINT_FILE,
    },
    exists: () => false,
  });

  assert.equal(config.dataDir, "/tmp/adjutant-data");
});
