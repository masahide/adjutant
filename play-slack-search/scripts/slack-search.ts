#!/usr/bin/env -S node --experimental-strip-types

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { executeSlackCommand } from './slack-search/command.ts';
import type {
  LoginPayload,
  OutputPayload,
  PayloadBody,
} from './slack-search/contracts.ts';
import { loadPackageEnv } from './slack-search/env.ts';
import { parseArgs } from './slack-search/options.ts';
import { normalizeProfilePath } from './slack-search/profile.ts';
import {
  prepareSession,
  runInteractiveLogin,
  safeCloseSession,
} from './slack-search/session.ts';

function main(): void {
  loadPackageEnv();
  const options = parseArgs(process.argv.slice(2));
  const profile = normalizeProfilePath(options.profile);
  if (options.login) {
    const login = runInteractiveLogin({
      profile,
      requestedSession: options.session,
      workspaceUrl: options.workspaceUrl,
    });
    const payload = buildOutputPayload(
      {
        completed: true,
        instructions:
          'A persistent Playwright browser was opened with your Slack profile. Log in there; the session data is stored in that profile. Close the browser yourself when you are done.',
        mode: 'login',
      },
      {
        debug: login.debug,
        profile: login.profile,
        query: '',
        session: login.session,
        workspaceUrl: options.workspaceUrl,
      },
    );
    writeOutput(payload, options.output);
    return;
  }
  const {
    debug,
    openedSession,
    profile: openedProfile,
    session,
  } = prepareSession({
    profile,
    requestedSession: options.session,
    workspaceUrl: options.workspaceUrl,
  });

  try {
    const payloadBody = executeSlackCommand(options, session);
    const payload = buildOutputPayload(payloadBody, {
      debug,
      profile: openedProfile,
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
  payloadBody: PayloadBody | LoginPayload,
  metadata: {
    debug?: {
      sessionMessages: string[];
    };
    profile: string;
    query: string;
    session: string;
    workspaceUrl: string;
  },
): OutputPayload {
  const baseMetadata = {
    generatedAt: new Date().toISOString(),
    ...(metadata.debug ? { debug: metadata.debug } : {}),
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
