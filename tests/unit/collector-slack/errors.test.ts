import assert from "node:assert/strict";
import test from "node:test";

import { summarizeError, toErrorMessage } from "../../../src/collector-slack/errors.js";

test("toErrorMessage は Error/string/object を正規化する", () => {
  assert.equal(toErrorMessage(new Error("boom")), "boom");
  assert.equal(toErrorMessage("plain"), "plain");
  assert.equal(toErrorMessage({ message: "from-object" }), "from-object");
  assert.equal(toErrorMessage({}), "unknown error");
});

test("summarizeError は name/message/stack を返す", () => {
  const error = new Error("failed");
  error.name = "CollectorError";
  const summary = summarizeError(error);

  assert.equal(summary.name, "CollectorError");
  assert.equal(summary.message, "failed");
  assert.equal(typeof summary.stack, "string");
});
