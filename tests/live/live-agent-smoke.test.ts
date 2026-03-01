import assert from "node:assert/strict";
import test from "node:test";

test(
  "live agent test scaffold: OPENAI_API_KEY must be provided by dedicated CI job",
  {
    skip:
      process.env.OPENAI_API_KEY === undefined || process.env.OPENAI_API_KEY.trim().length === 0,
  },
  () => {
    assert.ok(process.env.OPENAI_API_KEY);
  }
);
