import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { buildAdditionalSkillPaths, logSkillDiagnostics } from "../../../src/assistant/pi-skills.js";

test("buildAdditionalSkillPaths resolves project and user .agents/skills roots", () => {
  const paths = buildAdditionalSkillPaths({
    projectRoot: "/repo/adjutant",
    homedirPath: "/Users/tester",
  });

  assert.deepEqual(paths, [
    "/repo/adjutant/.agents/skills",
    "/Users/tester/.agents/skills",
  ]);
});

test("buildAdditionalSkillPaths omits missing projectRoot and dedupes identical roots", () => {
  assert.deepEqual(
    buildAdditionalSkillPaths({
      homedirPath: "/Users/tester",
    }),
    ["/Users/tester/.agents/skills"]
  );

  assert.deepEqual(
    buildAdditionalSkillPaths({
      projectRoot: "/Users/tester",
      homedirPath: "/Users/tester",
    }),
    ["/Users/tester/.agents/skills"]
  );
});

test("logSkillDiagnostics emits concise warning lines", () => {
  const warnings: string[] = [];
  const existingPath = resolve(process.cwd(), "package.json");

  logSkillDiagnostics(
    [
      {
        type: "warning",
        message: "skill path does not exist",
        path: "/tmp/project/.agents/skills",
      },
      {
        type: "warning",
        message: "description is required",
        path: existingPath,
      },
      {
        type: "warning",
        message: "failed to read skill path",
        path: "/tmp/missing-skill-path",
      },
      {
        type: "collision",
        message: 'name "dup" collision',
        path: existingPath,
      },
    ],
    (message) => warnings.push(message)
  );

  assert.equal(warnings.length, 3);
  assert.match(warnings[0] ?? "", /^\[pi-skills\] warning: description is required path=/);
  assert.match(warnings[1] ?? "", /^\[pi-skills\] warning: failed to read skill path path=/);
  assert.match(warnings[2] ?? "", /^\[pi-skills\] collision: name "dup" collision path=/);
});
