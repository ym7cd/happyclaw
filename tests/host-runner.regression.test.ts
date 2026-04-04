import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { DATA_DIR, GROUPS_DIR } from '../src/config.js';
import {
  runHostAgent,
  type ContainerOutput,
} from '../src/container-runner.js';
import type { RegisteredGroup } from '../src/types.js';

const tempDirs: string[] = [];
const envSnapshots = new Map<string, string | undefined>();

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeExecutable(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function setEnv(name: string, value: string | undefined): void {
  if (!envSnapshots.has(name)) {
    envSnapshots.set(name, process.env[name]);
  }
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function cleanupGroupArtifacts(folder: string): void {
  fs.rmSync(path.join(DATA_DIR, 'sessions', folder), {
    recursive: true,
    force: true,
  });
  fs.rmSync(path.join(DATA_DIR, 'ipc', folder), {
    recursive: true,
    force: true,
  });
  fs.rmSync(path.join(DATA_DIR, 'memory', folder), {
    recursive: true,
    force: true,
  });
  fs.rmSync(path.join(GROUPS_DIR, folder), {
    recursive: true,
    force: true,
  });
}

afterEach(() => {
  for (const [name, value] of envSnapshots) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  envSnapshots.clear();

  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('runHostAgent provider regression', () => {
  it('keeps Claude and Codex host groups isolated and dispatched to different runners', async () => {
    const fakeRunnerDir = makeTempDir('happyclaw-host-runner-');
    const fakeRunnerEntry = path.join(fakeRunnerDir, 'fake-runner.cjs');
    writeExecutable(
      fakeRunnerEntry,
      String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdin += chunk;
});
process.stdin.on('end', () => {
  const input = JSON.parse(stdin || '{}');
  const provider = process.env.HAPPYCLAW_MODEL_PROVIDER;
  const sessionHome = provider === 'codex'
    ? (process.env.CODEX_HOME || '')
    : (process.env.CLAUDE_CONFIG_DIR || '');
  const payload = {
    provider,
    cwd: process.cwd(),
    sessionHome,
    hasSettings: fs.existsSync(path.join(sessionHome, 'settings.json')),
    hasAuth: fs.existsSync(path.join(sessionHome, 'auth.json')),
    hasConfigToml: fs.existsSync(path.join(sessionHome, 'config.toml')),
    hasWorkspaceFile: fs.existsSync(path.join(process.cwd(), 'workspace.txt')),
  };
  const sessionId = input.sessionId || payload.provider + '-session-1';
  console.log('---HAPPYCLAW_OUTPUT_START---');
  console.log(JSON.stringify({
    status: 'stream',
    result: null,
    newSessionId: sessionId,
    sessionId,
    streamEvent: {
      eventType: 'text_delta',
      text: JSON.stringify(payload),
      sessionId,
    },
  }));
  console.log('---HAPPYCLAW_OUTPUT_END---');
  console.log('---HAPPYCLAW_OUTPUT_START---');
  console.log(JSON.stringify({
    status: 'success',
    result: JSON.stringify(payload),
    newSessionId: sessionId,
    sessionId,
  }));
  console.log('---HAPPYCLAW_OUTPUT_END---');
});
`,
    );

    const fakeGlobalCodexHome = makeTempDir('happyclaw-global-codex-home-');
    fs.writeFileSync(path.join(fakeGlobalCodexHome, 'auth.json'), '{"token":"x"}\n');
    fs.writeFileSync(path.join(fakeGlobalCodexHome, 'config.toml'), 'model = "gpt-5"\n');

    setEnv('HAPPYCLAW_CLAUDE_RUNNER_ENTRY', fakeRunnerEntry);
    setEnv('HAPPYCLAW_CODEX_RUNNER_ENTRY', fakeRunnerEntry);
    setEnv('CODEX_HOME', fakeGlobalCodexHome);

    const claudeGroup: RegisteredGroup = {
      name: 'Claude Host Group',
      folder: `claude-host-${Date.now()}`,
      added_at: new Date().toISOString(),
      executionMode: 'host',
      modelProvider: 'claude',
    };
    const codexGroup: RegisteredGroup = {
      name: 'Codex Host Group',
      folder: `codex-host-${Date.now()}`,
      added_at: new Date().toISOString(),
      executionMode: 'host',
      modelProvider: 'codex',
    };

    cleanupGroupArtifacts(claudeGroup.folder);
    cleanupGroupArtifacts(codexGroup.folder);
    fs.mkdirSync(path.join(GROUPS_DIR, claudeGroup.folder), { recursive: true });
    fs.mkdirSync(path.join(GROUPS_DIR, codexGroup.folder), { recursive: true });
    fs.writeFileSync(
      path.join(GROUPS_DIR, claudeGroup.folder, 'workspace.txt'),
      'claude\n',
    );
    fs.writeFileSync(
      path.join(GROUPS_DIR, codexGroup.folder, 'workspace.txt'),
      'codex\n',
    );

    const claudeOutputs: ContainerOutput[] = [];
    const codexOutputs: ContainerOutput[] = [];
    const noopProcess = (_proc: ChildProcess, _id: string) => {};

    const claudeResult = await runHostAgent(
      claudeGroup,
      {
        prompt: 'claude prompt',
        groupFolder: claudeGroup.folder,
        chatJid: 'web:claude',
        isMain: false,
      },
      noopProcess,
      async (output) => {
        claudeOutputs.push(output);
      },
    );

    const codexResult = await runHostAgent(
      codexGroup,
      {
        prompt: 'codex prompt',
        groupFolder: codexGroup.folder,
        chatJid: 'web:codex',
        isMain: false,
      },
      noopProcess,
      async (output) => {
        codexOutputs.push(output);
      },
    );

    expect(claudeResult.status).toBe('success');
    expect(codexResult.status).toBe('success');
    expect(claudeResult.newSessionId).toBe('claude-session-1');
    expect(codexResult.newSessionId).toBe('codex-session-1');
    expect(
      claudeOutputs.find((output) => output.status === 'stream')?.streamEvent
        ?.provider,
    ).toBe('claude');
    expect(
      codexOutputs.find((output) => output.status === 'stream')?.streamEvent
        ?.provider,
    ).toBe('codex');

    const claudePayload = JSON.parse(
      String(claudeOutputs.find((output) => output.status === 'success')?.result),
    ) as Record<string, unknown>;
    const codexPayload = JSON.parse(
      String(codexOutputs.find((output) => output.status === 'success')?.result),
    ) as Record<string, unknown>;

    expect(claudePayload.provider).toBe('claude');
    expect(codexPayload.provider).toBe('codex');
    expect(String(claudePayload.sessionHome)).toContain('.claude');
    expect(String(codexPayload.sessionHome)).toContain('.codex');
    expect(claudePayload.hasSettings).toBe(true);
    expect(claudePayload.hasAuth).toBe(false);
    expect(codexPayload.hasAuth).toBe(true);
    expect(codexPayload.hasConfigToml).toBe(true);
    expect(claudePayload.hasWorkspaceFile).toBe(true);
    expect(codexPayload.hasWorkspaceFile).toBe(true);

    const claudeSessionDir = path.join(
      DATA_DIR,
      'sessions',
      claudeGroup.folder,
      '.claude',
    );
    const codexSessionDir = path.join(
      DATA_DIR,
      'sessions',
      codexGroup.folder,
      '.codex',
    );
    expect(fs.existsSync(path.join(claudeSessionDir, 'settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(codexSessionDir, 'auth.json'))).toBe(true);
    expect(fs.existsSync(path.join(codexSessionDir, 'config.toml'))).toBe(true);
    expect(fs.existsSync(path.join(claudeSessionDir, 'auth.json'))).toBe(false);

    cleanupGroupArtifacts(claudeGroup.folder);
    cleanupGroupArtifacts(codexGroup.folder);
  });

  it('projects shared skills into Codex host session home', async () => {
    const fakeRunnerDir = makeTempDir('happyclaw-host-skills-runner-');
    const fakeRunnerEntry = path.join(fakeRunnerDir, 'fake-runner.cjs');
    writeExecutable(
      fakeRunnerEntry,
      String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdin += chunk;
});
process.stdin.on('end', () => {
  const provider = process.env.HAPPYCLAW_MODEL_PROVIDER;
  const sessionHome = provider === 'codex'
    ? (process.env.CODEX_HOME || '')
    : (process.env.CLAUDE_CONFIG_DIR || '');
  const skillsDir = path.join(sessionHome, 'skills');
  const payload = {
    provider,
    hasProjectSkill: fs.existsSync(path.join(skillsDir, 'project-shared', 'SKILL.md')),
    hasUserSkill: fs.existsSync(path.join(skillsDir, 'user-shared', 'SKILL.md')),
  };
  console.log('---HAPPYCLAW_OUTPUT_START---');
  console.log(JSON.stringify({
    status: 'success',
    result: JSON.stringify(payload),
    newSessionId: provider + '-skills-session',
    sessionId: provider + '-skills-session',
  }));
  console.log('---HAPPYCLAW_OUTPUT_END---');
});
`,
    );

    const fakeGlobalCodexHome = makeTempDir('happyclaw-global-codex-home-');
    fs.writeFileSync(path.join(fakeGlobalCodexHome, 'auth.json'), '{"token":"x"}\n');
    fs.writeFileSync(path.join(fakeGlobalCodexHome, 'config.toml'), 'model = "gpt-5"\n');

    const userId = `skills-user-${Date.now()}`;
    const projectSkillDir = path.join(process.cwd(), 'container', 'skills', 'project-shared');
    const userSkillDir = path.join(DATA_DIR, 'skills', userId, 'user-shared');
    fs.mkdirSync(projectSkillDir, { recursive: true });
    fs.mkdirSync(userSkillDir, { recursive: true });
    fs.writeFileSync(path.join(projectSkillDir, 'SKILL.md'), '---\nname: project-shared\n---\n');
    fs.writeFileSync(path.join(userSkillDir, 'SKILL.md'), '---\nname: user-shared\n---\n');

    setEnv('HAPPYCLAW_CODEX_RUNNER_ENTRY', fakeRunnerEntry);
    setEnv('CODEX_HOME', fakeGlobalCodexHome);

    const codexGroup: RegisteredGroup = {
      name: 'Codex Host Group Skills',
      folder: `codex-host-skills-${Date.now()}`,
      added_at: new Date().toISOString(),
      executionMode: 'host',
      modelProvider: 'codex',
      created_by: userId,
    };

    cleanupGroupArtifacts(codexGroup.folder);
    fs.mkdirSync(path.join(GROUPS_DIR, codexGroup.folder), { recursive: true });

    const result = await runHostAgent(
      codexGroup,
      {
        prompt: 'codex prompt',
        groupFolder: codexGroup.folder,
        chatJid: 'web:codex-skills',
        isMain: false,
      },
      (_proc: ChildProcess, _id: string) => {},
    );

    expect(result.status).toBe('success');
    const payload = JSON.parse(String(result.result)) as Record<string, unknown>;
    expect(payload.provider).toBe('codex');
    expect(payload.hasProjectSkill).toBe(true);
    expect(payload.hasUserSkill).toBe(true);

    cleanupGroupArtifacts(codexGroup.folder);
    fs.rmSync(path.join(DATA_DIR, 'skills', userId), { recursive: true, force: true });
    fs.rmSync(projectSkillDir, { recursive: true, force: true });
  });
});
