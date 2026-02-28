import assert from "node:assert/strict";
import test from "node:test";

import { validateAcpEnvelopeWithVendorSchema } from "../../../src/contracts/acp/schema-validator.js";

test("vendor schema validator accepts stable ACP method", async () => {
  const result = await validateAcpEnvelopeWithVendorSchema({
    jsonrpc: "2.0",
    id: "1",
    method: "session/new",
    params: {},
  });

  assert.equal(result.ok, true);
});

test("vendor schema validator rejects unstable method in stable mode", async () => {
  const result = await validateAcpEnvelopeWithVendorSchema({
    jsonrpc: "2.0",
    id: "1",
    method: "session/list",
    params: {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "UNKNOWN_METHOD");
});

test("vendor schema validator accepts unstable method when enabled", async () => {
  const result = await validateAcpEnvelopeWithVendorSchema(
    {
      jsonrpc: "2.0",
      id: "1",
      method: "session/list",
      params: {},
    },
    { allowUnstable: true }
  );

  assert.equal(result.ok, true);
});

test("vendor schema validator rejects invalid json-rpc envelope", async () => {
  const result = await validateAcpEnvelopeWithVendorSchema({
    id: "1",
    method: "session/new",
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "INVALID_JSON_RPC");
});
