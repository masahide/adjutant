import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SettingsManager,
  type AgentSession,
  type ResourceLoader,
} from "@mariozechner/pi-coding-agent";

import { createPiAgentSession } from "../../../src/assistant/agent-session-factory.js";
import { createPiResourceLoader } from "../../../src/assistant/pi-skills.js";

async function writeSkill(
  skillsRoot: string,
  skillName: string,
  description?: string
): Promise<string> {
  const skillDir = join(skillsRoot, skillName);
  await mkdir(skillDir, { recursive: true });

  const frontmatter = description
    ? `---\ndescription: ${description}\n---\n`
    : "---\nname: broken-skill\n---\n";
  const skillPath = join(skillDir, "SKILL.md");
  await writeFile(skillPath, `${frontmatter}\n# ${skillName}\n`, "utf8");
  return skillPath;
}

test("createPiResourceLoader discovers project and user .agents/skills roots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "adjutant-pi-skills-loader-"));
  const workspaceDir = join(root, "workspace");
  const projectRoot = join(root, "project");
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(workspaceDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeSkill(join(projectRoot, ".agents", "skills"), "repo-helper", "Repo helper skill");
  await writeSkill(join(homeDir, ".agents", "skills"), "user-helper", "User helper skill");

  const loader = createPiResourceLoader({
    workspaceDir,
    projectRoot,
    homedirPath: homeDir,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
  });
  await loader.reload();

  const skills = loader
    .getSkills()
    .skills.map((skill) => skill.name)
    .sort();

  assert.deepEqual(skills, ["repo-helper", "user-helper"]);
  assert.deepEqual(loader.getSkills().diagnostics, []);
});

test("createPiAgentSession injects discovered skills into the Pi catalog", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "adjutant-pi-skills-session-"));
  const workspaceDir = join(root, "workspace");
  const projectRoot = join(root, "project");
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(workspaceDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeSkill(join(projectRoot, ".agents", "skills"), "repo-helper", "Repo helper skill");
  await writeSkill(join(homeDir, ".agents", "skills"), "broken-skill");

  const warnings: string[] = [];
  const created = await createPiAgentSession({
    workspaceDir,
    projectRoot,
    homedirPath: homeDir,
    agentDir,
    onSkillWarning: (message) => warnings.push(message),
  });
  const session = created.session as unknown as AgentSession & {
    agent: { state: { systemPrompt?: string } };
    resourceLoader: ResourceLoader;
  };

  assert.equal(
    session.resourceLoader.getSkills().skills.some((skill) => skill.name === "repo-helper"),
    true
  );
  assert.equal(session.agent.state.systemPrompt?.includes("<available_skills>"), true);
  assert.equal(session.agent.state.systemPrompt?.includes("repo-helper"), true);
  assert.equal(
    warnings.some((message) => message.includes("description is required")),
    true
  );
});

test("createPiAgentSession exposes Pi /skill:name expansion for discovered .agents skills", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "adjutant-pi-skills-expand-"));
  const workspaceDir = join(root, "workspace");
  const projectRoot = join(root, "project");
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(workspaceDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeSkill(join(projectRoot, ".agents", "skills"), "repo-helper", "Repo helper skill");

  const created = await createPiAgentSession({
    workspaceDir,
    projectRoot,
    homedirPath: homeDir,
    agentDir,
  });
  const session = created.session as unknown as AgentSession & {
    agent: {
      prompt: (messages: unknown[]) => Promise<void>;
      setModel: (model: unknown) => void;
    };
    modelRegistry: {
      getApiKey: (model: unknown) => Promise<string | undefined>;
    };
  };

  let capturedMessages: unknown;
  session.agent.setModel({
    provider: "openai",
    id: "gpt-5-nano",
    reasoning: false,
  });
  const originalGetApiKey = session.modelRegistry.getApiKey.bind(session.modelRegistry);
  const originalAgentPrompt = session.agent.prompt.bind(session.agent);
  session.modelRegistry.getApiKey = async () => "test-key";
  session.agent.prompt = async (messages) => {
    capturedMessages = messages;
  };

  try {
    await session.prompt("/skill:repo-helper fix imports");
  } finally {
    session.modelRegistry.getApiKey = originalGetApiKey;
    session.agent.prompt = originalAgentPrompt;
  }

  const text = (
    (capturedMessages as Array<{
      content?: Array<{ type?: string; text?: string }>;
    }>)[0]
  )?.content?.[0]?.text;

  assert.equal(typeof text, "string");
  assert.match(text ?? "", /<skill name="repo-helper"/);
  assert.match(text ?? "", /References are relative to/);
  assert.match(text ?? "", /fix imports/);
});
