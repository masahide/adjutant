#!/usr/bin/env -S node --experimental-strip-types

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { executeSlackCommand } from './slack-search/command.ts';
import type { OutputPayload, PayloadBody } from './slack-search/contracts.ts';
import { loadPackageEnv } from './slack-search/env.ts';
import { parseArgs } from './slack-search/options.ts';
import { normalizeProfilePath } from './slack-search/profile.ts';
import { prepareSession, safeCloseSession } from './slack-search/session.ts';

function main(): void {
  loadPackageEnv();
  const options = parseArgs(process.argv.slice(2));
  const profile = normalizeProfilePath(options.profile);
  const { openedSession, session } = prepareSession({
    profile,
    requestedSession: options.session,
    workspaceUrl: options.workspaceUrl,
  });

  try {
    const payloadBody = executeSlackCommand(options, session);
    const payload = buildOutputPayload(payloadBody, {
      profile,
      query: options.query,
      session,
      workspaceUrl: options.workspaceUrl,
    });

    writeOutput(payload, options.output);
  } finally {
    if (options.close && openedSession) {
      safeCloseSession(openedSession);
    }
  }
}

function buildOutputPayload(
  payloadBody: PayloadBody,
  metadata: {
    profile: string;
    query: string;
    session: string;
    workspaceUrl: string;
  },
): OutputPayload {
  const baseMetadata = {
    generatedAt: new Date().toISOString(),
    profile: metadata.profile,
    session: metadata.session,
    workspaceUrl: metadata.workspaceUrl,
  };

  if (payloadBody.mode !== 'search') {
    return {
      ...payloadBody,
      ...baseMetadata,
      query: null,
    };
  }

  return {
    ...payloadBody,
    ...baseMetadata,
    query: metadata.query,
  };
}

function writeOutput(payload: OutputPayload, outputPath?: string): void {
  const json = `${JSON.stringify(payload, null, 2)}\n`;

  if (outputPath) {
    const resolvedPath = resolve(outputPath);
    mkdirSync(dirname(resolvedPath), { recursive: true });
    writeFileSync(resolvedPath, json, 'utf8');
  }

  process.stdout.write(json);
}

main();
