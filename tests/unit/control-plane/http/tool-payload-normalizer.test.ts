import assert from "node:assert/strict";
import test from "node:test";

import {
  extractToolError,
  normalizeToolPayload,
} from "../../../../src/control-plane/http/tool-payload-normalizer.js";

test("normalizeToolPayload keeps small JSON payload as object", () => {
  const normalized = normalizeToolPayload({ command: "pnpm check" });
  assert.deepEqual(normalized, { command: "pnpm check" });
});

test("normalizeToolPayload truncates oversized string payload", () => {
  const normalized = normalizeToolPayload("x".repeat(40 * 1024));
  assert.equal(typeof normalized, "string");
  assert.equal((normalized as string).includes("[truncated "), true);
});

test("normalizeToolPayload handles circular payload safely", () => {
  const payload: { self?: unknown } = {};
  payload.self = payload;

  const normalized = normalizeToolPayload(payload);
  assert.deepEqual(normalized, { self: "[circular]" });
});

test("extractToolError reads explicit error first", () => {
  const error = extractToolError({
    error: "permission denied",
    content: [
      {
        type: "content",
        content: {
          type: "text",
          text: "fallback",
        },
      },
    ],
  });
  assert.equal(error, "permission denied");
});

test("extractToolError reads text from ACP content", () => {
  const error = extractToolError({
    content: [
      {
        type: "content",
        content: {
          type: "text",
          text: "tool failed",
        },
      },
    ],
  });
  assert.equal(error, "tool failed");
});
