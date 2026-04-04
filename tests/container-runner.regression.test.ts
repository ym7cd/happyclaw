import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { DATA_DIR, GROUPS_DIR } from '../src/config.js';
import {
  runContainerAgent,
  type ContainerOutput,
} from '../src/container-runner.js';
import type { RegisteredGroup } from '../src/types.js';

const tempDirs: string[] = [];
const envSnapshots = new Map<string, string | undefined>();
const OUTPUT_START_MARKER = '---HAPPYCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---HAPPYCLAW_OUTPUT_END---';

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
  fs.rmSync(path.join(DATA_DIR, 'env', folder), {
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

describe('runContainerAgent provider regression', () => {
  it('selects provider-specific image, runner source, and session mounts in container mode', async () => {
    const fakeDockerDir = makeTempDir('happyclaw-fake-docker-');
    const fakeDockerState = path.join(fakeDockerDir, 'invocations.jsonl');
    const fakeDockerPath = path.join(fakeDockerDir, 'docker');
    writeExecutable(
      fakeDockerPath,
      String.raw`#!/usr/bin/env node
const fs = require('node:fs');

const args = process.argv.slice(2);
const stateFile = process.env.HAPPYCLAW_FAKE_DOCKER_STATE;

if (args[0] === 'stop') {
  process.exit(0);
}

if (args[0] !== 'run') {
  console.error('unsupported docker args: ' + JSON.stringify(args));
  process.exit(9);
}

const envVars = {};
const mounts = [];
let containerName = null;
let image = null;

for (let i = 1; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--name') {
    containerName = args[i + 1];
    i += 1;
    continue;
  }
  if (arg === '-e') {
    const [key, ...rest] = String(args[i + 1] || '').split('=');
    envVars[key] = rest.join('=');
    i += 1;
    continue;
  }
  if (arg === '-v') {
    mounts.push(args[i + 1]);
    i += 1;
    continue;
  }
  if (!arg.startsWith('-')) {
    image = arg;
    break;
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  const parsedInput = JSON.parse(input || '{}');
  fs.appendFileSync(
    stateFile,
    JSON.stringify({ args, envVars, mounts, containerName, image, input: parsedInput }) + '\n',
  );

  console.log('${OUTPUT_START_MARKER}');
  console.log(JSON.stringify({
    status: 'stream',
    result: null,
    newSessionId: 'container-session-1',
    sessionId: 'container-session-1',
    streamEvent: {
      eventType: 'text_delta',
      text: JSON.stringify({
        provider: envVars.HAPPYCLAW_MODEL_PROVIDER,
        image,
        containerName,
      }),
      sessionId: 'container-session-1',
    },
  }));
  console.log('${OUTPUT_END_MARKER}');
  console.log('${OUTPUT_START_MARKER}');
  console.log(JSON.stringify({
    status: 'success',
    result: JSON.stringify({
      provider: envVars.HAPPYCLAW_MODEL_PROVIDER,
      image,
      containerName,
      mounts,
      envVars,
    }),
    newSessionId: 'container-session-1',
    sessionId: 'container-session-1',
  }));
  console.log('${OUTPUT_END_MARKER}');
});
`,
    );

    const fakeCodexHome = makeTempDir('happyclaw-codex-home-');
    fs.writeFileSync(path.join(fakeCodexHome, 'auth.json'), '{"token":"x"}\n');
    fs.writeFileSync(path.join(fakeCodexHome, 'config.toml'), 'model = "gpt-5"\n');
    fs.mkdirSync(path.join(fakeCodexHome, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(fakeCodexHome, 'AGENTS.md'), 'codex rules\n');

    setEnv('PATH', `${fakeDockerDir}:${process.env.PATH || ''}`);
    setEnv('HAPPYCLAW_FAKE_DOCKER_STATE', fakeDockerState);
    setEnv('CODEX_HOME', fakeCodexHome);

    const claudeGroup: RegisteredGroup = {
      name: 'Claude Container Group',
      folder: `claude-container-${Date.now()}`,
      added_at: new Date().toISOString(),
      executionMode: 'container',
      modelProvider: 'claude',
    };
    const codexGroup: RegisteredGroup = {
      name: 'Codex Container Group',
      folder: `codex-container-${Date.now()}`,
      added_at: new Date().toISOString(),
      executionMode: 'container',
      modelProvider: 'codex',
    };

    cleanupGroupArtifacts(claudeGroup.folder);
    cleanupGroupArtifacts(codexGroup.folder);
    fs.mkdirSync(path.join(GROUPS_DIR, claudeGroup.folder), { recursive: true });
    fs.mkdirSync(path.join(GROUPS_DIR, codexGroup.folder), { recursive: true });

    const outputs: ContainerOutput[] = [];
    const noopProcess = (_proc: ChildProcess, _id: string) => {};

    const claudeResult = await runContainerAgent(
      claudeGroup,
      {
        prompt: 'claude prompt',
        groupFolder: claudeGroup.folder,
        chatJid: 'web:claude',
        isMain: false,
      },
      noopProcess,
      async (output) => {
        outputs.push(output);
      },
    );
    const codexResult = await runContainerAgent(
      codexGroup,
      {
        prompt: 'codex prompt',
        groupFolder: codexGroup.folder,
        chatJid: 'web:codex',
        isMain: false,
      },
      noopProcess,
      async (output) => {
        outputs.push(output);
      },
    );

    expect(claudeResult.status).toBe('success');
    expect(codexResult.status).toBe('success');
    expect(
      outputs.find(
        (output) =>
          output.status === 'stream' &&
          output.streamEvent?.provider === 'claude',
      ),
    ).toBeDefined();
    expect(
      outputs.find(
        (output) =>
          output.status === 'stream' &&
          output.streamEvent?.provider === 'codex',
      ),
    ).toBeDefined();

    const invocations = fs
      .readFileSync(fakeDockerState, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as {
        image: string;
        containerName: string;
        mounts: string[];
        envVars: Record<string, string>;
      });
    expect(invocations).toHaveLength(2);

    const claudeInvocation = invocations.find(
      (entry) => entry.envVars.HAPPYCLAW_MODEL_PROVIDER === 'claude',
    );
    const codexInvocation = invocations.find(
      (entry) => entry.envVars.HAPPYCLAW_MODEL_PROVIDER === 'codex',
    );

    expect(claudeInvocation?.image).toBe('happyclaw-agent:latest');
    expect(codexInvocation?.image).toBe('happyclaw-codex:latest');
    expect(claudeInvocation?.containerName).toContain('happyclaw-claude-');
    expect(codexInvocation?.containerName).toContain('happyclaw-codex-');

    expect(
      claudeInvocation?.mounts.some((mount) => mount.endsWith(':/app/src:ro')),
    ).toBe(true);
    expect(
      codexInvocation?.mounts.some((mount) =>
        mount.includes('/container/codex-runner/src:/app/src:ro'),
      ),
    ).toBe(true);

    expect(
      codexInvocation?.mounts.some((mount) =>
        mount.endsWith(':/workspace/group'),
      ),
    ).toBe(true);
    expect(
      codexInvocation?.mounts.some((mount) =>
        mount.endsWith(':/workspace/memory:ro'),
      ),
    ).toBe(true);
    expect(
      codexInvocation?.mounts.some((mount) => mount.endsWith(':/workspace/ipc')),
    ).toBe(true);
    expect(
      codexInvocation?.mounts.some((mount) =>
        mount.endsWith(':/home/node/.codex'),
      ),
    ).toBe(true);
    expect(
      codexInvocation?.mounts.some((mount) =>
        mount.endsWith(':/home/node/.codex/auth.json:ro'),
      ),
    ).toBe(true);
    expect(
      codexInvocation?.mounts.some((mount) =>
        mount.endsWith(':/home/node/.codex/config.toml:ro'),
      ),
    ).toBe(true);

    expect(codexInvocation?.envVars.CODEX_HOME).toBe('/home/node/.codex');
    expect(codexInvocation?.envVars.HAPPYCLAW_AGENT_HOME).toBe(
      '/home/node/.codex',
    );
    expect(claudeInvocation?.envVars.CLAUDE_CONFIG_DIR).toBe('/home/node/.claude');

    cleanupGroupArtifacts(claudeGroup.folder);
    cleanupGroupArtifacts(codexGroup.folder);
  });
});
