import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { ContainerInput, ContainerOutput } from './types.js';

const OUTPUT_START_MARKER = '---HAPPYCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---HAPPYCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[codex-runner] ${message}`);
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function buildCommand(
  input: ContainerInput,
  outputLastMessagePath: string,
): { cmd: string; args: string[] } {
  const cmd = process.env.HAPPYCLAW_CODEX_BIN || 'codex';
  const wrapperScriptPath = process.env.HAPPYCLAW_CODEX_BIN_SCRIPT_PATH;
  const mcpServerPath = process.env.HAPPYCLAW_MCP_SERVER_ENTRY;
  const baseArgs = [
    ...(wrapperScriptPath ? [wrapperScriptPath] : []),
    'exec',
    '--json',
    '--color',
    'never',
    '--skip-git-repo-check',
    '--output-last-message',
    outputLastMessagePath,
    '-c',
    'approval_policy="never"',
    '-c',
    'sandbox_mode="workspace-write"',
    ...(mcpServerPath
      ? [
          '-c',
          'mcp_servers.happyclaw.command="node"',
          '-c',
          `mcp_servers.happyclaw.args=${JSON.stringify([mcpServerPath])}`,
        ]
      : []),
  ];

  if (input.sessionId) {
    return {
      cmd,
      args: [...baseArgs, 'resume', input.sessionId, input.prompt],
    };
  }

  return {
    cmd,
    args: [...baseArgs, input.prompt],
  };
}

function tryParseJson(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeEventType(event: Record<string, unknown>): string {
  return readString(event.type) || readString(event.event_type) || '';
}

function extractThreadId(event: Record<string, unknown>): string | undefined {
  return (
    readString(event.thread_id) ||
    readString(event.session_id) ||
    readString(event.id)
  );
}

function extractErrorMessage(event: Record<string, unknown>): string | undefined {
  const nestedError = readRecord(event.error);
  return (
    readString(event.message) ||
    readString(event.error) ||
    readString(event.details) ||
    readString(event.status_message) ||
    readString(nestedError?.message) ||
    readString(nestedError?.details)
  );
}

function extractAgentTextDelta(event: Record<string, unknown>): string | undefined {
  const type = normalizeEventType(event);
  if (
    !type.includes('agentMessage') &&
    !type.includes('agent_message') &&
    type !== 'message.delta' &&
    type !== 'agent_message_delta' &&
    type !== 'agent_message_content_delta' &&
    type !== 'text_delta'
  ) {
    return undefined;
  }

  const direct =
    readString(event.delta) ||
    readString(event.text) ||
    readString(event.content) ||
    readString(event.chunk);
  if (direct) return direct;

  const delta = readRecord(event.delta);
  if (delta) {
    const nested =
      readString(delta.text) ||
      readString(delta.content) ||
      readString(delta.chunk);
    if (nested) return nested;
  }

  const payload = readRecord(event.payload);
  if (payload) {
    return (
      readString(payload.text) ||
      readString(payload.content) ||
      readString(payload.chunk)
    );
  }

  return undefined;
}

function isReasoningEventType(eventType: string): boolean {
  return (
    eventType.includes('reasoning') ||
    eventType === 'thinking_delta' ||
    eventType === 'reasoning_content_delta' ||
    eventType === 'reasoning_raw_content_delta'
  );
}

function isStatusErrorEventType(eventType: string): boolean {
  return (
    eventType === 'error' ||
    eventType === 'stream_error' ||
    eventType === 'turn.failed' ||
    eventType === 'turn_failed' ||
    eventType === 'turn.aborted' ||
    eventType === 'turn_aborted'
  );
}

function summarizeParsedCommand(
  parsedCmd: Record<string, unknown> | undefined,
): string | undefined {
  if (!parsedCmd) return undefined;
  const type = readString(parsedCmd.type) || readString(parsedCmd.kind);
  const query = readString(parsedCmd.query);
  const pathValue = readString(parsedCmd.path);
  const cmd = readString(parsedCmd.cmd);

  if (cmd) return cmd;
  if (type && query) return `${type}: ${query}`;
  if (type && pathValue) return `${type}: ${pathValue}`;
  return type;
}

function truncateSummary(value: string | undefined, max = 120): string | undefined {
  if (!value) return undefined;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function extractToolSummary(event: Record<string, unknown>): string | undefined {
  return truncateSummary(
    readString(event.cmd) ||
      readString(event.stdin) ||
      summarizeParsedCommand(readRecord(event.parsed_cmd)) ||
      readString(readRecord(event.invocation)?.tool_name) ||
      readString(readRecord(event.invocation)?.server_name) ||
      readString(event.status_message),
  );
}

function deriveToolName(eventType: string, event: Record<string, unknown>): string {
  if (eventType.startsWith('exec_command')) return 'exec_command';
  if (eventType.startsWith('patch_apply')) return 'apply_patch';
  if (eventType.startsWith('web_search')) return 'web_search';
  if (eventType.startsWith('image_generation')) return 'image_generation';
  if (eventType === 'view_image_tool_call') return 'view_image';
  if (eventType.startsWith('mcp_tool_call')) {
    const invocation = readRecord(event.invocation);
    return (
      readString(invocation?.tool_name) ||
      readString(invocation?.server_name) ||
      'mcp_tool'
    );
  }
  return eventType;
}

function extractToolKey(
  eventType: string,
  event: Record<string, unknown>,
): string | undefined {
  const invocation = readRecord(event.invocation);
  return (
    readString(event.tool_use_id) ||
    readString(event.call_id) ||
    readString(event.process_id) ||
    readString(event.id) ||
    readString(event.item_id) ||
    readString(invocation?.call_id) ||
    readString(invocation?.id) ||
    (eventType.startsWith('web_search') ? 'web_search' : undefined) ||
    (eventType.startsWith('image_generation') ? 'image_generation' : undefined) ||
    (eventType.startsWith('patch_apply') ? 'apply_patch' : undefined)
  );
}

function extractElapsedSeconds(event: Record<string, unknown>): number | undefined {
  const durationMs =
    readNumber(event.duration_ms) ||
    readNumber(readRecord(event.context)?.duration_ms);
  return durationMs !== undefined ? durationMs / 1000 : undefined;
}

async function main(): Promise<void> {
  let input: ContainerInput;
  try {
    const stdinData = await readStdin();
    input = JSON.parse(stdinData) as ContainerInput;
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
    return;
  }

  if (!input.prompt || !input.groupFolder || !input.chatJid) {
    writeOutput({
      status: 'error',
      result: null,
      error: 'Invalid input: prompt, groupFolder, and chatJid are required',
    });
    process.exit(1);
    return;
  }

  const codexHome = process.env.CODEX_HOME;
  if (!codexHome) {
    writeOutput({
      status: 'error',
      result: null,
      error: 'Missing CODEX_HOME for codex-runner',
    });
    process.exit(1);
    return;
  }

  fs.mkdirSync(codexHome, { recursive: true });
  const outputLastMessagePath = path.join(codexHome, '.happyclaw-last-message.txt');
  try {
    fs.rmSync(outputLastMessagePath, { force: true });
  } catch {
    /* ignore */
  }

  const { cmd, args } = buildCommand(input, outputLastMessagePath);
  const child = spawn(cmd, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let settled = false;
  let latestSessionId = input.sessionId;
  let stdoutBuffer = '';
  let stderrBuffer = '';
  let aggregatedText = '';
  const codexErrors: string[] = [];
  const activeToolUseIds = new Map<string, string>();
  let syntheticToolSeq = 0;

  const emitStreamEvent = (
    streamEvent: NonNullable<ContainerOutput['streamEvent']>,
  ): void => {
    writeOutput({
      status: 'stream',
      result: null,
      newSessionId: latestSessionId,
      sessionId: latestSessionId,
      turnId: input.turnId,
      streamEvent: {
        ...streamEvent,
        turnId: input.turnId,
        sessionId: latestSessionId,
        isSynthetic: true,
      },
    });
  };

  const flushStdoutLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const parsed = tryParseJson(trimmed);
    if (!parsed) return;

    const eventType = normalizeEventType(parsed);
    if (
      eventType === 'thread.started' ||
      eventType === 'thread_started' ||
      eventType === 'session_configured'
    ) {
      const threadId = extractThreadId(parsed);
      if (threadId && threadId !== latestSessionId) {
        latestSessionId = threadId;
        emitStreamEvent({
          eventType: 'status',
          statusText: 'codex_thread_started',
        });
      }
      return;
    }

    const delta = extractAgentTextDelta(parsed);
    if (delta) {
      aggregatedText += delta;
      emitStreamEvent({
        eventType: 'text_delta',
        text: delta,
      });
      return;
    }

    if (isReasoningEventType(eventType)) {
      return;
    }

    const toolKey = extractToolKey(eventType, parsed);
    if (
      eventType === 'exec_command_begin' ||
      eventType === 'mcp_tool_call_begin' ||
      eventType === 'patch_apply_begin' ||
      eventType === 'web_search_begin' ||
      eventType === 'image_generation_begin'
    ) {
      const toolUseId =
        activeToolUseIds.get(toolKey || '') ||
        toolKey ||
        `codex-tool-${++syntheticToolSeq}`;
      if (toolKey) activeToolUseIds.set(toolKey, toolUseId);
      emitStreamEvent({
        eventType: 'tool_use_start',
        toolName: deriveToolName(eventType, parsed),
        toolUseId,
        toolInputSummary: extractToolSummary(parsed),
      });
      return;
    }

    if (eventType === 'view_image_tool_call') {
      const toolUseId = toolKey || `codex-tool-${++syntheticToolSeq}`;
      emitStreamEvent({
        eventType: 'tool_use_start',
        toolName: deriveToolName(eventType, parsed),
        toolUseId,
        toolInputSummary: extractToolSummary(parsed),
      });
      emitStreamEvent({
        eventType: 'tool_use_end',
        toolName: deriveToolName(eventType, parsed),
        toolUseId,
      });
      return;
    }

    if (eventType === 'exec_command_output_delta') {
      const toolUseId = toolKey ? activeToolUseIds.get(toolKey) : undefined;
      if (toolUseId) {
        emitStreamEvent({
          eventType: 'tool_progress',
          toolName: 'exec_command',
          toolUseId,
          toolInputSummary: extractToolSummary(parsed),
        });
      }
      return;
    }

    if (
      eventType === 'exec_command_end' ||
      eventType === 'mcp_tool_call_end' ||
      eventType === 'patch_apply_end' ||
      eventType === 'web_search_end' ||
      eventType === 'image_generation_end'
    ) {
      const toolUseId =
        (toolKey ? activeToolUseIds.get(toolKey) : undefined) || toolKey;
      if (toolKey) activeToolUseIds.delete(toolKey);
      if (toolUseId) {
        emitStreamEvent({
          eventType: 'tool_use_end',
          toolName: deriveToolName(eventType, parsed),
          toolUseId,
          elapsedSeconds: extractElapsedSeconds(parsed),
        });
      }
      return;
    }

    if (eventType === 'error' || eventType === 'stream_error') {
      const message = extractErrorMessage(parsed);
      if (message) {
        codexErrors.push(message);
        emitStreamEvent({
          eventType: 'status',
          statusText: message,
        });
      }
      return;
    }

    if (eventType === 'turn.failed' || eventType === 'turn_failed') {
      const message = extractErrorMessage(parsed);
      if (message) codexErrors.push(message);
      return;
    }

    if (eventType === 'turn.aborted' || eventType === 'turn_aborted') {
      const message = extractErrorMessage(parsed);
      if (message) {
        codexErrors.push(message);
        emitStreamEvent({
          eventType: 'status',
          statusText: message,
        });
      }
    }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      flushStdoutLine(stdoutBuffer.slice(0, newlineIndex));
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrBuffer += chunk;
  });

  child.on('error', (err) => {
    if (settled) return;
    settled = true;
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to spawn codex CLI: ${err.message}`,
    });
    process.exit(1);
  });

  child.on('close', (code) => {
    if (settled) return;
    settled = true;
    if (stdoutBuffer.trim()) {
      flushStdoutLine(stdoutBuffer);
    }

    let finalMessage: string | null = null;
    try {
      if (fs.existsSync(outputLastMessagePath)) {
        const content = fs.readFileSync(outputLastMessagePath, 'utf8').trim();
        if (content) finalMessage = content;
      }
    } catch (err) {
      log(
        `Failed to read output-last-message: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!finalMessage && aggregatedText.trim()) {
      finalMessage = aggregatedText.trim();
    }

    if (code === 0) {
      writeOutput({
        status: 'success',
        result: finalMessage,
        newSessionId: latestSessionId,
        sessionId: latestSessionId,
        turnId: input.turnId,
        sourceKind: 'sdk_final',
        finalizationReason: 'completed',
      });
      process.exit(0);
      return;
    }

    const errorMessage =
      codexErrors.at(-1) ||
      stderrBuffer.trim().split('\n').filter(Boolean).at(-1) ||
      `Codex exited with code ${code ?? 'unknown'}`;
    writeOutput({
      status: 'error',
      result: finalMessage,
      newSessionId: latestSessionId,
      sessionId: latestSessionId,
      turnId: input.turnId,
      error: errorMessage,
      finalizationReason: 'error',
    });
    process.exit(code ?? 1);
  });
}

void main().catch((err) => {
  try {
    writeOutput({
      status: 'error',
      result: null,
      error: err instanceof Error ? err.message : String(err),
    });
  } catch {
    /* ignore */
  }
  process.exit(1);
});
