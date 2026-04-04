import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

import { afterEach, describe, expect, it } from 'vitest';

const PROJECT_ROOT = process.cwd();
const CODEX_RUNNER_ENTRY = path.join(
  PROJECT_ROOT,
  'container',
  'codex-runner',
  'dist',
  'index.js',
);
const HAPPYCLAW_MCP_SERVER_ENTRY = path.join(
  PROJECT_ROOT,
  'container',
  'shared',
  'mcp-server.cjs',
);
const require = createRequire(import.meta.url);
const MCP_CLIENT_INDEX = require.resolve(
  '@modelcontextprotocol/sdk/client/index.js',
);
const MCP_CLIENT_STDIO = require.resolve(
  '@modelcontextprotocol/sdk/client/stdio.js',
);
const OUTPUT_START_MARKER = '---HAPPYCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---HAPPYCLAW_OUTPUT_END---';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeExecutable(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function parseOutputs(stdout: string): Array<Record<string, unknown>> {
  const outputs: Array<Record<string, unknown>> = [];
  let cursor = 0;
  while (cursor < stdout.length) {
    const start = stdout.indexOf(OUTPUT_START_MARKER, cursor);
    if (start === -1) break;
    const end = stdout.indexOf(OUTPUT_END_MARKER, start);
    if (end === -1) break;
    const jsonText = stdout
      .slice(start + OUTPUT_START_MARKER.length, end)
      .trim();
    outputs.push(JSON.parse(jsonText) as Record<string, unknown>);
    cursor = end + OUTPUT_END_MARKER.length;
  }
  return outputs;
}

async function runCodexRunner(params: {
  cwd: string;
  input: Record<string, unknown>;
  mockCodexSource: string;
  env?: Record<string, string>;
}): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  outputs: Array<Record<string, unknown>>;
}> {
  const sandboxDir = makeTempDir('happyclaw-codex-runner-');
  const codexHome = path.join(sandboxDir, '.codex-home');
  const mockCodexPath = path.join(sandboxDir, 'mock-codex.cjs');
  writeExecutable(mockCodexPath, params.mockCodexSource);

  return new Promise((resolve, reject) => {
    const child = spawn('node', [CODEX_RUNNER_ENTRY], {
      cwd: params.cwd,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        HAPPYCLAW_CODEX_BIN: mockCodexPath,
        HAPPYCLAW_MCP_SERVER_ENTRY,
        ...params.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code,
        stdout,
        stderr,
        outputs: parseOutputs(stdout),
      });
    });

    child.stdin.end(JSON.stringify(params.input));
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('codex-runner integration', () => {
  it('maps session resume, text deltas, tool lifecycle, cwd file access, and skip-git-repo-check', async () => {
    const workspaceDir = makeTempDir('happyclaw-codex-workspace-');
    fs.writeFileSync(path.join(workspaceDir, 'note.txt'), 'workspace-ready\n');

    const mockCodexSource = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const outputIdx = args.indexOf('--output-last-message');
const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : null;
if (!args.includes('mcp_servers.happyclaw.command="node"')) {
  console.error('missing happyclaw MCP command override');
  process.exit(7);
}
const mcpArgsEntry = args.find((arg) => arg.startsWith('mcp_servers.happyclaw.args='));
if (!mcpArgsEntry || !mcpArgsEntry.includes('mcp-server.cjs')) {
  console.error('missing happyclaw MCP args override');
  process.exit(6);
}
if (!args.includes('--skip-git-repo-check')) {
  console.error('missing --skip-git-repo-check');
  process.exit(9);
}

const resumeIdx = args.indexOf('resume');
const isResume = resumeIdx >= 0;
const threadId = isResume ? args[resumeIdx + 1] : 'thread-1';
const prompt = args[args.length - 1];
const notePath = path.join(process.cwd(), 'note.txt');
if (!fs.existsSync(notePath)) {
  console.error('workspace note missing');
  process.exit(8);
}
const note = fs.readFileSync(notePath, 'utf8').trim();

console.log(JSON.stringify({ type: 'thread.started', thread_id: threadId }));
console.log(JSON.stringify({ type: 'reasoning_content_delta', delta: 'SHOULD_NOT_APPEAR' }));
console.log(JSON.stringify({ type: 'exec_command_begin', process_id: 'proc-1', cmd: 'cat note.txt' }));
console.log(JSON.stringify({ type: 'exec_command_output_delta', process_id: 'proc-1', chunk: note }));
console.log(JSON.stringify({ type: 'agent_message_delta', delta: 'reply:' + note + ':' + prompt }));
console.log(JSON.stringify({ type: 'exec_command_end', process_id: 'proc-1', exit_code: 0, duration_ms: 25 }));

if (outputPath) {
  fs.writeFileSync(outputPath, 'final:' + threadId + ':' + prompt);
}
process.exit(0);
`;

    const firstRun = await runCodexRunner({
      cwd: workspaceDir,
      input: {
        prompt: 'first-turn',
        groupFolder: 'codex-group',
        chatJid: 'chat-1',
        turnId: 'turn-1',
      },
      mockCodexSource,
    });

    expect(firstRun.code).toBe(0);
    const firstStreamEvents = firstRun.outputs
      .filter((output) => output.status === 'stream')
      .map((output) => output.streamEvent as Record<string, unknown>);
    expect(firstStreamEvents.map((event) => event.eventType)).toEqual([
      'status',
      'tool_use_start',
      'tool_progress',
      'text_delta',
      'tool_use_end',
    ]);
    expect(firstStreamEvents[0]?.statusText).toBe('codex_thread_started');
    expect(firstStreamEvents[1]?.toolName).toBe('exec_command');
    expect(firstStreamEvents[1]?.toolInputSummary).toBe('cat note.txt');
    expect(firstStreamEvents[2]?.toolUseId).toBe(firstStreamEvents[1]?.toolUseId);
    expect(firstStreamEvents[3]?.text).toBe('reply:workspace-ready:first-turn');
    expect(firstStreamEvents[4]?.toolUseId).toBe(firstStreamEvents[1]?.toolUseId);
    expect(
      firstStreamEvents.some((event) => event.text === 'SHOULD_NOT_APPEAR'),
    ).toBe(false);

    const firstFinal = firstRun.outputs.at(-1);
    expect(firstFinal?.status).toBe('success');
    expect(firstFinal?.newSessionId).toBe('thread-1');
    expect(firstFinal?.result).toBe('final:thread-1:first-turn');

    const secondRun = await runCodexRunner({
      cwd: workspaceDir,
      input: {
        prompt: 'second-turn',
        sessionId: 'thread-1',
        groupFolder: 'codex-group',
        chatJid: 'chat-1',
        turnId: 'turn-2',
      },
      mockCodexSource,
    });

    expect(secondRun.code).toBe(0);
    const secondFinal = secondRun.outputs.at(-1);
    expect(secondFinal?.status).toBe('success');
    expect(secondFinal?.newSessionId).toBe('thread-1');
    expect(secondFinal?.result).toBe('final:thread-1:second-turn');
  });

  it('surfaces retry/failure errors without leaking reasoning into text', async () => {
    const workspaceDir = makeTempDir('happyclaw-codex-error-workspace-');
    fs.writeFileSync(path.join(workspaceDir, 'note.txt'), 'workspace-ready\n');

    const mockCodexSource = String.raw`#!/usr/bin/env node
const fs = require('node:fs');

const args = process.argv.slice(2);
const outputIdx = args.indexOf('--output-last-message');
const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : null;

console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-err' }));
console.log(JSON.stringify({ type: 'reasoning_content_delta', delta: 'internal-secret' }));
console.log(JSON.stringify({ type: 'agent_message_delta', delta: 'partial-answer' }));
console.log(JSON.stringify({ type: 'error', message: 'Reconnecting... 1/5' }));
console.log(JSON.stringify({ type: 'turn.failed', error: { message: 'fatal failure' } }));
if (outputPath) {
  fs.writeFileSync(outputPath, 'partial-answer');
}
process.exit(1);
`;

    const result = await runCodexRunner({
      cwd: workspaceDir,
      input: {
        prompt: 'will-fail',
        groupFolder: 'codex-group',
        chatJid: 'chat-err',
        turnId: 'turn-err',
      },
      mockCodexSource,
    });

    expect(result.code).toBe(1);
    const streamEvents = result.outputs
      .filter((output) => output.status === 'stream')
      .map((output) => output.streamEvent as Record<string, unknown>);
    expect(streamEvents.map((event) => event.eventType)).toEqual([
      'status',
      'text_delta',
      'status',
    ]);
    expect(streamEvents[1]?.text).toBe('partial-answer');
    expect(
      streamEvents.some((event) => event.text === 'internal-secret'),
    ).toBe(false);

    const finalOutput = result.outputs.at(-1);
    expect(finalOutput?.status).toBe('error');
    expect(finalOutput?.newSessionId).toBe('thread-err');
    expect(finalOutput?.result).toBe('partial-answer');
    expect(finalOutput?.error).toBe('fatal failure');
  });

  it('lets codex-runner expose shared memory tools via the injected happyclaw MCP server', async () => {
    const workspaceDir = makeTempDir('happyclaw-codex-memory-workspace-');
    const workspaceGlobal = makeTempDir('happyclaw-codex-memory-global-');
    const workspaceMemory = makeTempDir('happyclaw-codex-memory-store-');
    const workspaceIpc = makeTempDir('happyclaw-codex-memory-ipc-');
    fs.mkdirSync(path.join(workspaceIpc, 'messages'), { recursive: true });
    fs.mkdirSync(path.join(workspaceIpc, 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(workspaceGlobal, 'CLAUDE.md'), 'global line\n');

    const mockCodexSource = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const { Client } = require(${JSON.stringify(MCP_CLIENT_INDEX)});
const { StdioClientTransport } = require(${JSON.stringify(MCP_CLIENT_STDIO)});

async function main() {
  const args = process.argv.slice(2);
  const outputIdx = args.indexOf('--output-last-message');
  const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : null;
  const mcpArgsEntry = args.find((arg) => arg.startsWith('mcp_servers.happyclaw.args='));
  if (!mcpArgsEntry) {
    console.error('missing happyclaw mcp args');
    process.exit(5);
  }
  const mcpArgs = JSON.parse(mcpArgsEntry.split('=')[1]);
  const serverPath = mcpArgs[0];

  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'memory-thread-1' }));
  console.log(JSON.stringify({ type: 'mcp_tool_call_begin', invocation: { tool_name: 'memory_append', call_id: 'mem-1' } }));

  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverPath],
    env: {
      ...process.env,
      HAPPYCLAW_IS_HOME: 'true',
      HAPPYCLAW_IS_ADMIN_HOME: 'false',
      HAPPYCLAW_IS_SCHEDULED_TASK: 'false',
    },
  });
  const client = new Client({ name: 'mock-codex', version: '1.0.0' });
  await client.connect(transport);
  try {
    await client.callTool({
      name: 'memory_append',
      arguments: { content: 'codex-memory-pass', date: '2026-04-03' },
    });
    console.log(JSON.stringify({ type: 'mcp_tool_call_end', invocation: { tool_name: 'memory_append', call_id: 'mem-1' } }));
    console.log(JSON.stringify({ type: 'mcp_tool_call_begin', invocation: { tool_name: 'memory_search', call_id: 'mem-2' } }));
    const search = await client.callTool({
      name: 'memory_search',
      arguments: { query: 'codex-memory-pass', max_results: 5 },
    });
    console.log(JSON.stringify({ type: 'mcp_tool_call_end', invocation: { tool_name: 'memory_search', call_id: 'mem-2' } }));
    console.log(JSON.stringify({ type: 'mcp_tool_call_begin', invocation: { tool_name: 'memory_get', call_id: 'mem-3' } }));
    const get = await client.callTool({
      name: 'memory_get',
      arguments: { file: '[memory] 2026-04-03.md', lines: 20 },
    });
    console.log(JSON.stringify({ type: 'mcp_tool_call_end', invocation: { tool_name: 'memory_get', call_id: 'mem-3' } }));

    const searchText = search.content[0]?.text || '';
    const getText = get.content[0]?.text || '';
    const finalText = 'search=' + searchText + '\nget=' + getText;
    console.log(JSON.stringify({ type: 'agent_message_delta', delta: finalText }));
    if (outputPath) {
      fs.writeFileSync(outputPath, finalText);
    }
  } finally {
    await client.close();
    await transport.close();
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
`;

    const result = await runCodexRunner({
      cwd: workspaceDir,
      input: {
        prompt: 'memory-tools',
        groupFolder: 'codex-group',
        chatJid: 'chat-memory',
        turnId: 'turn-memory',
      },
      mockCodexSource,
      env: {
        HAPPYCLAW_WORKSPACE_GROUP: workspaceDir,
        HAPPYCLAW_WORKSPACE_GLOBAL: workspaceGlobal,
        HAPPYCLAW_WORKSPACE_MEMORY: workspaceMemory,
        HAPPYCLAW_WORKSPACE_IPC: workspaceIpc,
        HAPPYCLAW_CHAT_JID: 'chat-memory',
        HAPPYCLAW_GROUP_FOLDER: 'codex-group',
      },
    });

    expect(result.code).toBe(0);
    const streamEvents = result.outputs
      .filter((output) => output.status === 'stream')
      .map((output) => output.streamEvent as Record<string, unknown>);
    expect(streamEvents.map((event) => event.eventType)).toEqual([
      'status',
      'tool_use_start',
      'tool_use_end',
      'tool_use_start',
      'tool_use_end',
      'tool_use_start',
      'tool_use_end',
      'text_delta',
    ]);
    const finalOutput = result.outputs.at(-1);
    expect(finalOutput?.status).toBe('success');
    expect(String(finalOutput?.result)).toContain('codex-memory-pass');
    expect(
      fs.readFileSync(path.join(workspaceMemory, '2026-04-03.md'), 'utf8'),
    ).toContain('codex-memory-pass');
  });
});
