#!/usr/bin/env node

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const { createHappyClawToolSpecs } = require('./mcp-tool-specs.cjs');

function normalizeFlag(value) {
  return value === '1' || value === 'true';
}

async function main() {
  const workspaceIpc = process.env.HAPPYCLAW_WORKSPACE_IPC;
  const workspaceGroup = process.env.HAPPYCLAW_WORKSPACE_GROUP;
  const workspaceGlobal = process.env.HAPPYCLAW_WORKSPACE_GLOBAL;
  const workspaceMemory = process.env.HAPPYCLAW_WORKSPACE_MEMORY;
  const chatJid = process.env.HAPPYCLAW_CHAT_JID;
  const groupFolder = process.env.HAPPYCLAW_GROUP_FOLDER;

  if (!workspaceIpc || !workspaceGroup || !workspaceGlobal || !workspaceMemory) {
    throw new Error('Missing HappyClaw workspace env for MCP server');
  }
  if (!chatJid || !groupFolder) {
    throw new Error('Missing HappyClaw chat/group env for MCP server');
  }

  const ctx = {
    chatJid,
    groupFolder,
    isHome: normalizeFlag(process.env.HAPPYCLAW_IS_HOME),
    isAdminHome: normalizeFlag(process.env.HAPPYCLAW_IS_ADMIN_HOME),
    isScheduledTask: normalizeFlag(process.env.HAPPYCLAW_IS_SCHEDULED_TASK),
    workspaceIpc,
    workspaceGroup,
    workspaceGlobal,
    workspaceMemory,
  };

  const server = new McpServer({
    name: 'happyclaw',
    version: '1.0.0',
  });

  for (const spec of createHappyClawToolSpecs(ctx)) {
    server.tool(
      spec.name,
      spec.description,
      spec.inputSchema,
      async (args) => spec.handler(args || {}),
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(
    `[happyclaw-mcp-server] ${err instanceof Error ? err.stack || err.message : String(err)}`,
  );
  process.exit(1);
});
