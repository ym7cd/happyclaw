const fs = require('node:fs');
const path = require('node:path');

const { z } = require('zod');
const { CronExpressionParser } = require('cron-parser');

const { detectImageMimeTypeFromBase64Strict } = require('./image-detector.cjs');
const { createRequestId, pollIpcResult, writeIpcFile } = require('./ipc.cjs');

const MEMORY_EXTENSIONS = new Set(['.md', '.txt']);
const MEMORY_SUBDIRS = new Set(['memory', 'conversations']);
const MEMORY_SKIP_DIRS = new Set(['logs', '.claude', '.codex', 'node_modules', '.git']);
const MAX_MEMORY_FILE_SIZE = 512 * 1024;
const MAX_MEMORY_APPEND_SIZE = 16 * 1024;
const MEMORY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function buildTextResult(text, isError = false) {
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
}

function collectMemoryFiles(baseDir, out, maxDepth, depth = 0) {
  if (depth > maxDepth || !fs.existsSync(baseDir)) return;
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(baseDir, entry.name);
      if (entry.isDirectory()) {
        if (MEMORY_SKIP_DIRS.has(entry.name)) continue;
        if (depth === 0 || MEMORY_SUBDIRS.has(entry.name)) {
          collectMemoryFiles(fullPath, out, maxDepth, depth + 1);
        }
      } else if (entry.isFile()) {
        if (
          entry.name === 'CLAUDE.md' ||
          entry.name === 'AGENTS.md' ||
          MEMORY_EXTENSIONS.has(path.extname(entry.name))
        ) {
          out.push(fullPath);
        }
      }
    }
  } catch {
    // ignore unreadable files
  }
}

function createToRelativePath(ctx) {
  return (filePath) => {
    if (
      filePath === ctx.workspaceGlobal ||
      filePath.startsWith(ctx.workspaceGlobal + path.sep)
    ) {
      return `[global] ${path.relative(ctx.workspaceGlobal, filePath)}`;
    }
    if (
      filePath === ctx.workspaceMemory ||
      filePath.startsWith(ctx.workspaceMemory + path.sep)
    ) {
      return `[memory] ${path.relative(ctx.workspaceMemory, filePath)}`;
    }
    return path.relative(ctx.workspaceGroup, filePath);
  };
}

function parseMemoryFileReference(fileRef) {
  const trimmed = fileRef.trim();
  const lineRefMatch = trimmed.match(/^(.*?):(\d+)$/);
  if (!lineRefMatch) return { pathRef: trimmed };

  const lineFromRef = Number(lineRefMatch[2]);
  if (!Number.isInteger(lineFromRef) || lineFromRef <= 0) {
    return { pathRef: trimmed };
  }
  return { pathRef: lineRefMatch[1].trim(), lineFromRef };
}

function isWithinWorkspace(resolvedPath, workspaceRoot) {
  return (
    resolvedPath === workspaceRoot ||
    resolvedPath.startsWith(workspaceRoot + path.sep)
  );
}

function createHappyClawToolSpecs(ctx) {
  const messagesDir = path.join(ctx.workspaceIpc, 'messages');
  const tasksDir = path.join(ctx.workspaceIpc, 'tasks');
  const hasCrossGroupAccess = ctx.isAdminHome;
  const toRelativePath = createToRelativePath(ctx);

  const specs = [
    {
      name: 'send_message',
      description:
        "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate with the user or group.",
      inputSchema: {
        text: z.string().describe('The message text to send'),
      },
      handler: async (args) => {
        const data = {
          type: 'message',
          chatJid: ctx.chatJid,
          text: args.text,
          groupFolder: ctx.groupFolder,
          timestamp: new Date().toISOString(),
        };
        if (ctx.isScheduledTask) {
          data.isScheduledTask = true;
        }
        writeIpcFile(messagesDir, data);
        return buildTextResult('Message sent.');
      },
    },
    {
      name: 'send_image',
      description:
        "Send an image file from the workspace to the user or group via IM (Feishu/Telegram/DingTalk). The file must be an image (PNG, JPEG, GIF, WebP, etc.) and must exist in the workspace. Use this when you've generated or downloaded an image and want to share it with the user. Optionally include a caption.",
      inputSchema: {
        file_path: z
          .string()
          .describe(
            'Path to the image file in the workspace (relative to workspace root or absolute)',
          ),
        caption: z
          .string()
          .optional()
          .describe('Optional caption text to send with the image'),
      },
      handler: async (args) => {
        const absPath = path.isAbsolute(args.file_path)
          ? args.file_path
          : path.join(ctx.workspaceGroup, args.file_path);
        const resolved = path.resolve(absPath);
        if (!isWithinWorkspace(resolved, ctx.workspaceGroup)) {
          return buildTextResult(
            'Error: file path must be within workspace directory.',
            true,
          );
        }
        if (!fs.existsSync(resolved)) {
          return buildTextResult(`Error: file not found: ${args.file_path}`, true);
        }

        const stat = fs.statSync(resolved);
        if (stat.size > 10 * 1024 * 1024) {
          return buildTextResult(
            `Error: image file too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Maximum is 10MB.`,
            true,
          );
        }
        if (stat.size === 0) {
          return buildTextResult('Error: image file is empty.', true);
        }

        const buffer = fs.readFileSync(resolved);
        const base64 = buffer.toString('base64');
        const mimeType = detectImageMimeTypeFromBase64Strict(base64);
        if (!mimeType) {
          return buildTextResult(
            'Error: file does not appear to be a supported image format (PNG, JPEG, GIF, WebP, TIFF, BMP).',
            true,
          );
        }

        const data = {
          type: 'image',
          chatJid: ctx.chatJid,
          imageBase64: base64,
          mimeType,
          caption: args.caption || undefined,
          fileName: path.basename(resolved),
          groupFolder: ctx.groupFolder,
          timestamp: new Date().toISOString(),
        };
        if (ctx.isScheduledTask) {
          data.isScheduledTask = true;
        }
        writeIpcFile(messagesDir, data);
        return buildTextResult(
          `Image sent: ${path.basename(resolved)} (${mimeType}, ${(stat.size / 1024).toFixed(1)}KB)`,
        );
      },
    },
    {
      name: 'send_file',
      description:
        'Send a file to the current chat (the user you\'re talking to) via IM (Feishu/Telegram/DingTalk). The file path is relative to the workspace/group directory.\nSupports: PDF, DOC, XLS, PPT, MP4, ZIP, SO, etc. Max file size: 30MB.',
      inputSchema: {
        filePath: z
          .string()
          .describe(
            'File path relative to workspace/group (e.g., "output/report.pdf")',
          ),
        fileName: z
          .string()
          .describe('File name to display (e.g., "report.pdf")'),
      },
      handler: async (args) => {
        let resolvedPath;
        let relativePath;

        if (path.isAbsolute(args.filePath)) {
          resolvedPath = path.resolve(args.filePath);
          if (!isWithinWorkspace(resolvedPath, ctx.workspaceGroup)) {
            return buildTextResult(
              'Error: file must be within the workspace/group directory.',
              true,
            );
          }
          relativePath = path.relative(ctx.workspaceGroup, resolvedPath);
        } else {
          relativePath = args.filePath;
          resolvedPath = path.resolve(ctx.workspaceGroup, args.filePath);
          if (!isWithinWorkspace(resolvedPath, ctx.workspaceGroup)) {
            return buildTextResult(
              'Error: file must be within the workspace/group directory.',
              true,
            );
          }
        }

        if (!fs.existsSync(resolvedPath)) {
          return buildTextResult(`Error: file not found: ${args.filePath}`, true);
        }

        writeIpcFile(tasksDir, {
          type: 'send_file',
          chatJid: ctx.chatJid,
          filePath: relativePath,
          fileName: args.fileName,
          timestamp: new Date().toISOString(),
        });
        return buildTextResult(`Sending file "${args.fileName}"...`);
      },
    },
    {
      name: 'schedule_task',
      description:
        `Schedule a recurring or one-time task.

EXECUTION TYPE:
• "agent" (default): Task runs as a full agent with access to all tools.
• "script" (admin only): Task runs a shell command directly on the host.

EXECUTION MODE:
• "host": Task runs directly on the host machine. Admin only.
• "container" (default for non-admin): Task runs in a Docker container.

CONTEXT MODE (agent mode only):
• "group": Task runs in the group's conversation context.
• "isolated": Task runs in a fresh session.

MESSAGING BEHAVIOR:
• Agent mode: output is sent via MCP tool or stdout.
• Script mode: stdout is sent as the result.

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
• cron: Standard cron expression
• interval: Milliseconds between runs
• once: Local time WITHOUT "Z" suffix`,
      inputSchema: {
        prompt: z.string().optional().default(''),
        schedule_type: z.enum(['cron', 'interval', 'once']),
        schedule_value: z.string(),
        execution_type: z.enum(['agent', 'script']).default('agent'),
        script_command: z.string().max(4096).optional(),
        execution_mode: z.enum(['host', 'container']).optional(),
        context_mode: z.enum(['group', 'isolated']).default('group'),
        target_group_jid: z.string().optional(),
      },
      handler: async (args) => {
        const execType = args.execution_type || 'agent';
        if (execType === 'agent' && !args.prompt?.trim()) {
          return buildTextResult(
            'Agent mode requires a prompt. Provide instructions for what the agent should do.',
            true,
          );
        }
        if (execType === 'script' && !args.script_command?.trim()) {
          return buildTextResult(
            'Script mode requires script_command. Provide the shell command to execute.',
            true,
          );
        }
        if (execType === 'script' && !ctx.isAdminHome) {
          return buildTextResult(
            'Only admin home container can create script tasks.',
            true,
          );
        }

        if (args.schedule_type === 'cron') {
          try {
            CronExpressionParser.parse(args.schedule_value, {
              tz: process.env.TZ || 'Asia/Shanghai',
            });
          } catch {
            return buildTextResult(
              `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" or "*/5 * * * *".`,
              true,
            );
          }
        } else if (args.schedule_type === 'interval') {
          const ms = parseInt(args.schedule_value, 10);
          if (Number.isNaN(ms) || ms <= 0) {
            return buildTextResult(
              `Invalid interval: "${args.schedule_value}". Must be positive milliseconds.`,
              true,
            );
          }
        } else if (args.schedule_type === 'once') {
          const date = new Date(args.schedule_value);
          if (Number.isNaN(date.getTime())) {
            return buildTextResult(
              `Invalid timestamp: "${args.schedule_value}". Use ISO 8601 format like "2026-02-01T15:30:00".`,
              true,
            );
          }
        }

        const targetJid =
          hasCrossGroupAccess && args.target_group_jid
            ? args.target_group_jid
            : ctx.chatJid;

        const data = {
          type: 'schedule_task',
          prompt: args.prompt || '',
          schedule_type: args.schedule_type,
          schedule_value: args.schedule_value,
          context_mode: args.context_mode || 'isolated',
          execution_type: execType,
          targetJid,
          createdBy: ctx.groupFolder,
          timestamp: new Date().toISOString(),
        };
        if (execType === 'script') {
          data.script_command = args.script_command;
        }
        if (args.execution_mode) {
          data.execution_mode = args.execution_mode;
        }

        const filename = writeIpcFile(tasksDir, data);
        return buildTextResult(
          `Task scheduled [${execType === 'script' ? 'script' : 'agent'}] (${filename}): ${args.schedule_type} - ${args.schedule_value}`,
        );
      },
    },
    {
      name: 'list_tasks',
      description:
        "List all scheduled tasks. From admin home: shows all tasks. From other groups: shows only that group's tasks.",
      inputSchema: {},
      handler: async () => {
        try {
          const result = await pollIpcResult(
            tasksDir,
            {
              type: 'list_tasks',
              requestId: createRequestId(),
              groupFolder: ctx.groupFolder,
              isAdminHome: hasCrossGroupAccess,
              timestamp: new Date().toISOString(),
            },
            'list_tasks_result',
          );
          if (!result.success) {
            return buildTextResult(
              `Error listing tasks: ${result.error || 'Unknown error'}`,
              true,
            );
          }
          const tasks = result.tasks || [];
          if (tasks.length === 0) {
            return buildTextResult('No scheduled tasks found.');
          }
          const formatted = tasks
            .map(
              (t) =>
                `- [${t.id}] ${String(t.prompt || '').slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
            )
            .join('\n');
          return buildTextResult(`Scheduled tasks:\n${formatted}`);
        } catch {
          return buildTextResult('Timeout waiting for task list response.', true);
        }
      },
    },
    {
      name: 'pause_task',
      description: 'Pause a scheduled task. It will not run until resumed.',
      inputSchema: {
        task_id: z.string().describe('The task ID to pause'),
      },
      handler: async (args) => {
        writeIpcFile(tasksDir, {
          type: 'pause_task',
          taskId: args.task_id,
          groupFolder: ctx.groupFolder,
          isMain: hasCrossGroupAccess,
          timestamp: new Date().toISOString(),
        });
        return buildTextResult(`Task ${args.task_id} pause requested.`);
      },
    },
    {
      name: 'resume_task',
      description: 'Resume a paused task.',
      inputSchema: {
        task_id: z.string().describe('The task ID to resume'),
      },
      handler: async (args) => {
        writeIpcFile(tasksDir, {
          type: 'resume_task',
          taskId: args.task_id,
          groupFolder: ctx.groupFolder,
          isMain: hasCrossGroupAccess,
          timestamp: new Date().toISOString(),
        });
        return buildTextResult(`Task ${args.task_id} resume requested.`);
      },
    },
    {
      name: 'cancel_task',
      description: 'Cancel and delete a scheduled task.',
      inputSchema: {
        task_id: z.string().describe('The task ID to cancel'),
      },
      handler: async (args) => {
        writeIpcFile(tasksDir, {
          type: 'cancel_task',
          taskId: args.task_id,
          groupFolder: ctx.groupFolder,
          isMain: hasCrossGroupAccess,
          timestamp: new Date().toISOString(),
        });
        return buildTextResult(`Task ${args.task_id} cancellation requested.`);
      },
    },
    {
      name: 'register_group',
      description:
        'Register a new group so the agent can respond to messages there. Admin home only.',
      inputSchema: {
        jid: z.string().describe('The chat JID (e.g., "feishu:oc_xxxx")'),
        name: z.string().describe('Display name for the group'),
        folder: z
          .string()
          .describe('Folder name for group files (lowercase, hyphens)'),
        execution_mode: z
          .enum(['container', 'host'])
          .optional()
          .describe('Execution mode'),
      },
      handler: async (args) => {
        if (!hasCrossGroupAccess) {
          return buildTextResult(
            'Only the admin home container can register new groups.',
            true,
          );
        }
        writeIpcFile(tasksDir, {
          type: 'register_group',
          jid: args.jid,
          name: args.name,
          folder: args.folder,
          executionMode: args.execution_mode,
          timestamp: new Date().toISOString(),
        });
        return buildTextResult(
          `Group "${args.name}" registered. It will start receiving messages immediately.`,
        );
      },
    },
  ];

  if (ctx.isHome) {
    specs.push(
      {
        name: 'install_skill',
        description:
          'Install a skill from the skills registry (skills.sh). The skill will be available in future conversations.',
        inputSchema: {
          package: z
            .string()
            .describe('The skill package to install, format: owner/repo or owner/repo@skill'),
        },
        handler: async (args) => {
          const pkg = args.package.trim();
          if (
            !/^[\w\-]+\/[\w\-.]+(?:[@#][\w\-.\/]+)?$/.test(pkg) &&
            !/^https?:\/\//.test(pkg)
          ) {
            return buildTextResult(
              `Invalid package format: "${pkg}". Expected format: owner/repo or owner/repo@skill`,
              true,
            );
          }

          try {
            const result = await pollIpcResult(
              tasksDir,
              {
                type: 'install_skill',
                package: pkg,
                requestId: createRequestId(),
                groupFolder: ctx.groupFolder,
                timestamp: new Date().toISOString(),
              },
              'install_skill_result',
              120_000,
            );
            if (result.success) {
              const installed = (result.installed || []).join(', ') || pkg;
              return buildTextResult(
                `Skill installed successfully: ${installed}\n\nNote: The skill will be available in the next conversation (new container/process).`,
              );
            }
            return buildTextResult(
              `Failed to install skill "${pkg}": ${result.error || 'Unknown error'}`,
              true,
            );
          } catch {
            return buildTextResult(
              'Timeout waiting for skill installation result (120s). The installation may still be in progress.',
              true,
            );
          }
        },
      },
      {
        name: 'uninstall_skill',
        description:
          'Uninstall a user-level skill by its ID. Project-level skills cannot be uninstalled.',
        inputSchema: {
          skill_id: z
            .string()
            .describe('The skill ID to uninstall (directory name)'),
        },
        handler: async (args) => {
          const skillId = args.skill_id.trim();
          if (!skillId || !/^[\w\-]+$/.test(skillId)) {
            return buildTextResult(
              `Invalid skill ID: "${skillId}". Must be alphanumeric with hyphens/underscores.`,
              true,
            );
          }

          try {
            const result = await pollIpcResult(
              tasksDir,
              {
                type: 'uninstall_skill',
                skillId,
                requestId: createRequestId(),
                groupFolder: ctx.groupFolder,
                timestamp: new Date().toISOString(),
              },
              'uninstall_skill_result',
            );
            if (result.success) {
              return buildTextResult(`Skill "${skillId}" uninstalled successfully.`);
            }
            return buildTextResult(
              `Failed to uninstall skill "${skillId}": ${result.error || 'Unknown error'}`,
              true,
            );
          } catch {
            return buildTextResult(
              'Timeout waiting for skill uninstall result.',
              true,
            );
          }
        },
      },
      {
        name: 'memory_append',
        description:
          '将时效性记忆追加到 memory/YYYY-MM-DD.md。仅用于短期信息；长期偏好或规则应写入 /workspace/global/CLAUDE.md。',
        inputSchema: {
          content: z.string().describe('要追加的记忆内容'),
          date: z.string().optional().describe('目标日期，格式 YYYY-MM-DD'),
        },
        handler: async (args) => {
          const normalizedContent = args.content.replace(/\r\n?/g, '\n').trim();
          if (!normalizedContent) {
            return buildTextResult('内容不能为空。', true);
          }
          const appendBytes = Buffer.byteLength(normalizedContent, 'utf-8');
          if (appendBytes > MAX_MEMORY_APPEND_SIZE) {
            return buildTextResult(
              `内容过大：${appendBytes} 字节（上限 ${MAX_MEMORY_APPEND_SIZE}）。`,
              true,
            );
          }
          const date = (args.date ?? new Date().toISOString().split('T')[0]).trim();
          if (!MEMORY_DATE_PATTERN.test(date)) {
            return buildTextResult(
              `日期格式无效：“${date}”，请使用 YYYY-MM-DD。`,
              true,
            );
          }
          const resolvedPath = path.normalize(
            path.join(ctx.workspaceMemory, `${date}.md`),
          );
          if (!isWithinWorkspace(resolvedPath, ctx.workspaceMemory)) {
            return buildTextResult('访问被拒绝：路径超出工作区范围。', true);
          }
          try {
            fs.mkdirSync(ctx.workspaceMemory, { recursive: true });
            const fileExists = fs.existsSync(resolvedPath);
            const currentSize = fileExists ? fs.statSync(resolvedPath).size : 0;
            const separator = currentSize > 0 ? '\n---\n\n' : '';
            const entry = `${separator}### ${new Date().toISOString()}\n${normalizedContent}\n`;
            const nextSize = currentSize + Buffer.byteLength(entry, 'utf-8');
            if (nextSize > MAX_MEMORY_FILE_SIZE) {
              return buildTextResult(
                `记忆文件将超过 ${MAX_MEMORY_FILE_SIZE} 字节上限，请缩短内容。`,
                true,
              );
            }
            fs.appendFileSync(resolvedPath, entry, 'utf-8');
            return buildTextResult(
              `已追加到 memory/${date}.md（${appendBytes} 字节）。`,
            );
          } catch (err) {
            return buildTextResult(
              `追加记忆时出错：${err instanceof Error ? err.message : String(err)}`,
              true,
            );
          }
        },
      },
    );
  }

  specs.push(
    {
      name: 'memory_search',
      description:
        '在工作区的记忆文件中搜索（CLAUDE.md、AGENTS.md、memory/、conversations/ 及其他 .md/.txt 文件）。',
      inputSchema: {
        query: z.string().describe('搜索关键词或短语'),
        max_results: z.number().optional().default(20).describe('最大结果数'),
      },
      handler: async (args) => {
        if (!args.query.trim()) {
          return buildTextResult('搜索关键词不能为空。', true);
        }
        const maxResults = Math.min(Math.max(args.max_results ?? 20, 1), 50);
        const queryLower = args.query.toLowerCase();
        const files = [];
        collectMemoryFiles(ctx.workspaceMemory, files, 4);
        collectMemoryFiles(ctx.workspaceGroup, files, 4);
        collectMemoryFiles(ctx.workspaceGlobal, files, 4);
        const uniqueFiles = Array.from(new Set(files));
        if (uniqueFiles.length === 0) {
          return buildTextResult('未找到记忆文件。');
        }
        const results = [];
        let skippedLarge = 0;
        for (const filePath of uniqueFiles) {
          if (results.length >= maxResults) break;
          try {
            const stat = fs.statSync(filePath);
            if (stat.size > MAX_MEMORY_FILE_SIZE) {
              skippedLarge++;
              continue;
            }
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n');
            let lastEnd = -1;
            for (let i = 0; i < lines.length; i++) {
              if (results.length >= maxResults) break;
              if (lines[i].toLowerCase().includes(queryLower)) {
                const start = Math.max(0, i - 1);
                if (start <= lastEnd) continue;
                const end = Math.min(lines.length, i + 2);
                lastEnd = end;
                results.push(
                  `${toRelativePath(filePath)}:${i + 1}\n${lines.slice(start, end).join('\n')}`,
                );
              }
            }
          } catch {
            // ignore unreadable
          }
        }
        const skippedNote =
          skippedLarge > 0 ? `（跳过 ${skippedLarge} 个大文件）` : '';
        if (results.length === 0) {
          return buildTextResult(
            `在 ${uniqueFiles.length} 个记忆文件中未找到“${args.query}”的匹配。${skippedNote}`,
          );
        }
        return buildTextResult(
          `找到 ${results.length} 条匹配${skippedNote}：\n\n${results.join('\n---\n')}`,
        );
      },
    },
    {
      name: 'memory_get',
      description: '读取记忆文件或指定行范围。',
      inputSchema: {
        file: z
          .string()
          .describe('相对路径，可带 :行号，如 "CLAUDE.md:12" 或 "[memory] 2026-01-15.md"'),
        from_line: z.number().optional().describe('起始行号（从 1 开始）'),
        lines: z.number().optional().describe('读取行数（上限 200）'),
      },
      handler: async (args) => {
        const { pathRef, lineFromRef } = parseMemoryFileReference(args.file);
        let resolvedPath;
        if (pathRef.startsWith('[global] ')) {
          resolvedPath = path.join(
            ctx.workspaceGlobal,
            pathRef.slice('[global] '.length),
          );
        } else if (pathRef.startsWith('[memory] ')) {
          resolvedPath = path.join(
            ctx.workspaceMemory,
            pathRef.slice('[memory] '.length),
          );
        } else {
          resolvedPath = path.join(ctx.workspaceGroup, pathRef);
        }
        resolvedPath = path.normalize(resolvedPath);
        if (
          !isWithinWorkspace(resolvedPath, ctx.workspaceGroup) &&
          !isWithinWorkspace(resolvedPath, ctx.workspaceGlobal) &&
          !isWithinWorkspace(resolvedPath, ctx.workspaceMemory)
        ) {
          return buildTextResult('访问被拒绝：路径超出工作区范围。', true);
        }
        if (!fs.existsSync(resolvedPath)) {
          return buildTextResult(`文件未找到：${pathRef}`, true);
        }
        try {
          const content = fs.readFileSync(resolvedPath, 'utf-8');
          const allLines = content.split('\n');
          const fromLine = Math.max((args.from_line ?? lineFromRef ?? 1) - 1, 0);
          const maxLines = Math.min(args.lines ?? allLines.length, 200);
          const slice = allLines.slice(fromLine, fromLine + maxLines);
          return buildTextResult(
            `${pathRef}（第 ${fromLine + 1}-${fromLine + slice.length} 行，共 ${allLines.length} 行）\n\n${slice.join('\n')}`,
          );
        } catch (err) {
          return buildTextResult(
            `读取文件时出错：${err instanceof Error ? err.message : String(err)}`,
            true,
          );
        }
      },
    },
  );

  return specs;
}

module.exports = {
  createHappyClawToolSpecs,
};
