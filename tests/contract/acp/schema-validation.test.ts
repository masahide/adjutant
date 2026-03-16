import assert from "node:assert/strict";
import test from "node:test";

import { validateAcpEnvelopeWithSchema } from "../../../src/contracts/acp/schema-validator.js";

test("ACP schema validator accepts stable method", async () => {
  const result = await validateAcpEnvelopeWithSchema({
    jsonrpc: "2.0",
    id: "1",
    method: "session/new",
    params: {},
  });

  assert.equal(result.ok, true);
});

test("ACP schema validator rejects unstable-only method in stable mode", async () => {
  const result = await validateAcpEnvelopeWithSchema({
    jsonrpc: "2.0",
    id: "1",
    method: "session/close",
    params: {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "UNKNOWN_METHOD");
});

test("ACP schema validator accepts unstable-only method when enabled", async () => {
  const result = await validateAcpEnvelopeWithSchema(
    {
      jsonrpc: "2.0",
      id: "1",
      method: "session/close",
      params: {},
    },
    { allowUnstable: true }
  );

  assert.equal(result.ok, true);
});

test("ACP schema validator rejects invalid json-rpc envelope", async () => {
  const result = await validateAcpEnvelopeWithSchema({
    id: "1",
    method: "session/new",
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "INVALID_JSON_RPC");
});
