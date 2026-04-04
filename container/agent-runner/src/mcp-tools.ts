/**
 * Claude SDK MCP adapter for HappyClaw shared tool handlers.
 *
 * The actual tool business logic lives in container/shared/ so Claude and
 * Codex can expose the same HappyClaw tool surface without copying IPC/MCP
 * handlers into each runner.
 */

import { createRequire } from 'node:module';
import path from 'node:path';

import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { z } from 'zod';

const require = createRequire(import.meta.url);

/** Context required by HappyClaw MCP tools. */
export interface McpContext {
  chatJid: string;
  groupFolder: string;
  isHome: boolean;
  isAdminHome: boolean;
  isScheduledTask?: boolean;
  workspaceIpc: string;
  workspaceGroup: string;
  workspaceGlobal: string;
  workspaceMemory: string;
}

interface SharedToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  handler: (
    args: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }>;
}

function resolveSharedToolSpecsModule(): string {
  const configured = process.env.HAPPYCLAW_SHARED_MCP_TOOLS_MODULE;
  if (configured) return configured;
  return path.join(process.cwd(), 'container', 'shared', 'mcp-tool-specs.cjs');
}

function loadSharedToolSpecsModule(): {
  createHappyClawToolSpecs: (ctx: McpContext) => SharedToolSpec[];
} {
  return require(resolveSharedToolSpecsModule()) as {
    createHappyClawToolSpecs: (ctx: McpContext) => SharedToolSpec[];
  };
}

export function createMcpTools(ctx: McpContext): SdkMcpToolDefinition<any>[] {
  const { createHappyClawToolSpecs } = loadSharedToolSpecsModule();
  return createHappyClawToolSpecs(ctx).map((spec) =>
    tool(spec.name, spec.description, spec.inputSchema, spec.handler),
  );
}
