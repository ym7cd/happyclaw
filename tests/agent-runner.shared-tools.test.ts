import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createMcpTools } from '../container/agent-runner/src/mcp-tools.js';

const tempDirs: string[] = [];
const envSnapshots = new Map<string, string | undefined>();

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function setEnv(name: string, value: string | undefined): void {
  if (!envSnapshots.has(name)) {
    envSnapshots.set(name, process.env[name]);
  }
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
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

describe('agent-runner shared mcp wrapper', () => {
  it('loads tool specs from the shared module path', () => {
    const tempDir = makeTempDir('happyclaw-shared-tools-');
    const sharedModulePath = path.join(tempDir, 'shared-tools.cjs');
    fs.writeFileSync(
      sharedModulePath,
      String.raw`module.exports = {
  createHappyClawToolSpecs() {
    return [{
      name: 'shared_probe',
      description: 'loaded from shared module',
      inputSchema: {},
      async handler() {
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    }];
  },
};
`,
    );

    setEnv('HAPPYCLAW_SHARED_MCP_TOOLS_MODULE', sharedModulePath);
    const tools = createMcpTools({
      chatJid: 'web:test',
      groupFolder: 'test-group',
      isHome: true,
      isAdminHome: false,
      workspaceIpc: '/tmp/ipc',
      workspaceGroup: '/tmp/group',
      workspaceGlobal: '/tmp/global',
      workspaceMemory: '/tmp/memory',
    });

    expect(tools).toHaveLength(1);
    expect((tools[0] as { name?: string }).name).toBe('shared_probe');
  });
});
