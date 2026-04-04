import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const PROJECT_ROOT = process.cwd();
const MCP_SERVER_ENTRY = path.join(
  PROJECT_ROOT,
  'container',
  'shared',
  'mcp-server.cjs',
);

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function withClient(
  env: Record<string, string>,
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [MCP_SERVER_ENTRY],
    env,
    stderr: 'pipe',
  });
  const client = new Client({
    name: 'happyclaw-test-client',
    version: '1.0.0',
  });

  await client.connect(transport);
  try {
    await run(client);
  } finally {
    await client.close();
    await transport.close();
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('shared happyclaw mcp server', () => {
  it('exposes memory tools over stdio for Codex-compatible MCP clients', async () => {
    const workspaceRoot = makeTempDir('happyclaw-shared-mcp-');
    const workspaceGroup = path.join(workspaceRoot, 'group');
    const workspaceGlobal = path.join(workspaceRoot, 'global');
    const workspaceMemory = path.join(workspaceRoot, 'memory');
    const workspaceIpc = path.join(workspaceRoot, 'ipc');
    fs.mkdirSync(workspaceGroup, { recursive: true });
    fs.mkdirSync(workspaceGlobal, { recursive: true });
    fs.mkdirSync(workspaceMemory, { recursive: true });
    fs.mkdirSync(path.join(workspaceIpc, 'messages'), { recursive: true });
    fs.mkdirSync(path.join(workspaceIpc, 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(workspaceGlobal, 'CLAUDE.md'), 'global-memory-line\n');

    await withClient(
      {
        ...process.env,
        HAPPYCLAW_WORKSPACE_GROUP: workspaceGroup,
        HAPPYCLAW_WORKSPACE_GLOBAL: workspaceGlobal,
        HAPPYCLAW_WORKSPACE_MEMORY: workspaceMemory,
        HAPPYCLAW_WORKSPACE_IPC: workspaceIpc,
        HAPPYCLAW_CHAT_JID: 'web:test',
        HAPPYCLAW_GROUP_FOLDER: 'test-group',
        HAPPYCLAW_IS_HOME: 'true',
        HAPPYCLAW_IS_ADMIN_HOME: 'false',
        HAPPYCLAW_IS_SCHEDULED_TASK: 'false',
      },
      async (client) => {
        const tools = await client.listTools();
        const toolNames = tools.tools.map((tool) => tool.name);
        expect(toolNames).toContain('memory_append');
        expect(toolNames).toContain('memory_search');
        expect(toolNames).toContain('memory_get');

        const appendResult = await client.callTool({
          name: 'memory_append',
          arguments: {
            content: 'remember-shared-mcp',
            date: '2026-04-03',
          },
        });
        expect(appendResult.isError).toBeFalsy();
        expect(
          fs.readFileSync(path.join(workspaceMemory, '2026-04-03.md'), 'utf8'),
        ).toContain('remember-shared-mcp');

        const searchResult = await client.callTool({
          name: 'memory_search',
          arguments: {
            query: 'remember-shared-mcp',
          },
        });
        const searchText = String(searchResult.content?.[0]?.text || '');
        expect(searchText).toContain('remember-shared-mcp');
        expect(searchText).toContain('[memory] 2026-04-03.md');

        const getResult = await client.callTool({
          name: 'memory_get',
          arguments: {
            file: '[memory] 2026-04-03.md:1',
            lines: 20,
          },
        });
        const getText = String(getResult.content?.[0]?.text || '');
        expect(getText).toContain('remember-shared-mcp');
      },
    );
  });
});
