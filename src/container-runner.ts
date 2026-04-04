/**
 * Container Runner for happyclaw
 * Spawns agent execution in Docker container and handles IPC
 */
import {
  ChildProcess,
  exec,
  execFile,
  execFileSync,
  spawn,
} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CLAUDE_CONTAINER_IMAGE,
  CODEX_CONTAINER_IMAGE,
  DATA_DIR,
  GROUPS_DIR,
} from './config.js';
import { logger } from './logger.js';
import {
  loadMountAllowlist,
  validateAdditionalMounts,
} from './mount-security.js';
import {
  buildContainerEnvLines,
  getClaudeProviderConfig,
  getContainerEnvConfig,
  getCodexRuntimeEnvVars,
  getEffectiveCodexHomeDir,
  getEnabledProviders,
  getBalancingConfig,
  getSystemSettings,
  mergeClaudeEnvConfig,
  resolveProviderById,
  shellQuoteEnvLines,
  writeCredentialsFile,
} from './runtime-config.js';
import { providerPool } from './provider-pool.js';
import { isApiError } from './agent-output-parser.js';
import type { ClaudeProviderConfig } from './runtime-config.js';
import { loadUserMcpServers } from './mcp-utils.js';
import {
  MessageSourceKind,
  ModelProvider,
  RegisteredGroup,
  StreamEvent,
} from './types.js';
import {
  attachStderrHandler,
  attachStdoutHandler,
  createStderrState,
  createStdoutParserState,
  handleNonZeroExit,
  handleSuccessClose,
  handleTimeoutClose,
  writeRunLog,
  type CloseHandlerContext,
} from './agent-output-parser.js';

/**
 * Required env flags for settings.json — 每次容器/进程启动时强制写入，不可被用户覆盖。
 * 合并模式：仅覆盖这些 key，保留用户自定义的其他 key。
 */
const REQUIRED_SETTINGS_ENV: Record<string, string> = {
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '0',
  CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
};

/** Read existing settings.json, deep-merge required env keys and mcpServers, write only if changed */
function ensureSettingsJson(
  settingsFile: string,
  mcpServers?: Record<string, Record<string, unknown>>,
): void {
  let existing: Record<string, unknown> = {};
  try {
    if (fs.existsSync(settingsFile)) {
      existing = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    }
  } catch {
    /* ignore parse errors, overwrite */
  }

  const existingEnv = (existing.env as Record<string, string>) || {};
  const mergedEnv = { ...existingEnv, ...REQUIRED_SETTINGS_ENV };
  const merged: Record<string, unknown> = { ...existing, env: mergedEnv };

  // Merge user-configured MCP servers into settings
  if (mcpServers && Object.keys(mcpServers).length > 0) {
    const existingMcp = (existing.mcpServers as Record<string, unknown>) || {};
    merged.mcpServers = { ...existingMcp, ...mcpServers };
  }

  const newContent = JSON.stringify(merged, null, 2) + '\n';

  // Only write when content actually changed
  try {
    if (fs.existsSync(settingsFile)) {
      const current = fs.readFileSync(settingsFile, 'utf8');
      if (current === newContent) return;
    }
  } catch {
    /* write anyway */
  }

  fs.writeFileSync(settingsFile, newContent, { mode: 0o644 });
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  /** @deprecated Use isHome + isAdminHome instead */
  isMain: boolean;
  turnId?: string;
  isHome?: boolean;
  isAdminHome?: boolean;
  isScheduledTask?: boolean;
  /** Isolated task run ID — determines IPC namespace (tasks-run/{taskRunId}/) */
  taskRunId?: string;
  images?: Array<{ data: string; mimeType?: string }>;
  agentId?: string;
  agentName?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error' | 'stream' | 'closed';
  result: string | null;
  newSessionId?: string;
  error?: string;
  streamEvent?: StreamEvent;
  turnId?: string;
  sessionId?: string;
  sdkMessageUuid?: string;
  sourceKind?: Exclude<MessageSourceKind, 'user_command'>;
  finalizationReason?: 'completed' | 'interrupted' | 'error';
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

/**
 * Create directory with 0o777 permissions for container volume mounts.
 * Fixes uid mismatch between host user and container node user (uid 1000),
 * especially in rootless podman where uid remapping causes permission denied.
 */
function mkdirForContainer(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
  try {
    fs.chmodSync(dirPath, 0o777);
  } catch {
    // Ignore — may fail on read-only filesystem or special mounts
  }
}

interface ResolvedProvider {
  config: ClaudeProviderConfig;
  customEnv: Record<string, string>;
}

interface HostRunnerDescriptor {
  provider: ModelProvider;
  sessionDirName: '.claude' | '.codex';
  runnerRoot: string;
  distEntry: string;
  sharedToolsModulePath: string;
  mcpServerEntryPath: string;
  setupBuildHint: string;
  setupInstallHint?: string;
  customEntry: boolean;
}

interface ContainerRunnerDescriptor {
  provider: ModelProvider;
  sessionDirName: '.claude' | '.codex';
  sessionHomePath: '/home/node/.claude' | '/home/node/.codex';
  imageName: string;
  runnerAppDir: '/app' | '/app-codex';
  runnerSrcDir: string;
  sharedToolsModulePath: string;
  mcpServerEntryPath: string;
}

const CODEX_SHARED_HOME_ENTRIES = [
  'auth.json',
  'config.toml',
  'AGENTS.md',
  'rules',
  'agents',
] as const;
const DEFAULT_CODEX_BIN_CONTAINER_PATH = '/tmp/happyclaw-codex-bin';
const DEFAULT_CODEX_BIN_SCRIPT_CONTAINER_PATH = '/tmp/happyclaw-codex-script.cjs';

function normalizeModelProvider(modelProvider?: string): ModelProvider {
  if (modelProvider === undefined || modelProvider === 'claude') {
    return 'claude';
  }
  if (modelProvider === 'codex') {
    return 'codex';
  }
  throw new Error(`Unsupported model provider: ${modelProvider}`);
}

function getHostRunnerDescriptor(
  modelProvider?: string,
): HostRunnerDescriptor {
  const provider = normalizeModelProvider(modelProvider);
  const projectRoot = process.cwd();
  const sharedToolsModulePath = path.join(
    projectRoot,
    'container',
    'shared',
    'mcp-tool-specs.cjs',
  );
  const mcpServerEntryPath = path.join(
    projectRoot,
    'container',
    'shared',
    'mcp-server.cjs',
  );
  const overrideEntry = provider === 'codex'
    ? process.env.HAPPYCLAW_CODEX_RUNNER_ENTRY
    : process.env.HAPPYCLAW_CLAUDE_RUNNER_ENTRY;

  if (overrideEntry) {
    const distEntry = path.resolve(overrideEntry);
    return {
      provider,
      sessionDirName: provider === 'codex' ? '.codex' : '.claude',
      runnerRoot: path.dirname(distEntry),
      distEntry,
      sharedToolsModulePath,
      mcpServerEntryPath,
      setupBuildHint: `使用自定义 ${provider} runner entry：${distEntry}`,
      setupInstallHint: undefined,
      customEntry: true,
    };
  }

  if (provider === 'codex') {
    const runnerRoot = path.join(projectRoot, 'container', 'codex-runner');
    return {
      provider,
      sessionDirName: '.codex',
      runnerRoot,
      distEntry: path.join(runnerRoot, 'dist', 'index.js'),
      sharedToolsModulePath,
      mcpServerEntryPath,
      setupBuildHint: 'npm --prefix container/codex-runner run build',
      setupInstallHint: 'npm --prefix container/codex-runner install',
      customEntry: false,
    };
  }

  const runnerRoot = path.join(projectRoot, 'container', 'agent-runner');
  return {
    provider,
    sessionDirName: '.claude',
    runnerRoot,
    distEntry: path.join(runnerRoot, 'dist', 'index.js'),
    sharedToolsModulePath,
    mcpServerEntryPath,
    setupBuildHint: 'npm --prefix container/agent-runner run build',
    setupInstallHint: 'npm --prefix container/agent-runner install',
    customEntry: false,
  };
}

function getContainerRunnerDescriptor(
  modelProvider?: string,
): ContainerRunnerDescriptor {
  const provider = normalizeModelProvider(modelProvider);
  const projectRoot = process.cwd();

  if (provider === 'codex') {
    return {
      provider,
      sessionDirName: '.codex',
      sessionHomePath: '/home/node/.codex',
      imageName: CODEX_CONTAINER_IMAGE,
      runnerAppDir: '/app-codex',
      runnerSrcDir: path.join(projectRoot, 'container', 'codex-runner', 'src'),
      sharedToolsModulePath: '/app/shared/mcp-tool-specs.cjs',
      mcpServerEntryPath: '/app/shared/mcp-server.cjs',
    };
  }

  return {
    provider,
    sessionDirName: '.claude',
    sessionHomePath: '/home/node/.claude',
    imageName: CLAUDE_CONTAINER_IMAGE,
    runnerAppDir: '/app',
    runnerSrcDir: path.join(projectRoot, 'container', 'agent-runner', 'src'),
    sharedToolsModulePath: '/app/shared/mcp-tool-specs.cjs',
    mcpServerEntryPath: '/app/shared/mcp-server.cjs',
  };
}

function ensureSymlink(targetPath: string, linkPath: string): void {
  try {
    const existing = fs.lstatSync(linkPath);
    if (existing.isSymbolicLink()) {
      const currentTarget = fs.readlinkSync(linkPath);
      const resolvedCurrent = path.resolve(path.dirname(linkPath), currentTarget);
      if (resolvedCurrent === targetPath) return;
    }
    fs.rmSync(linkPath, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  fs.symlinkSync(targetPath, linkPath);
}

function ensureCodexHomeBootstrap(groupSessionsDir: string): void {
  const sourceCodexHome = getEffectiveCodexHomeDir();

  fs.mkdirSync(groupSessionsDir, { recursive: true });
  for (const entry of CODEX_SHARED_HOME_ENTRIES) {
    const sourcePath = path.join(sourceCodexHome, entry);
    const linkPath = path.join(groupSessionsDir, entry);
    if (sourcePath === linkPath) continue;
    if (!fs.existsSync(sourcePath)) continue;
    ensureSymlink(sourcePath, linkPath);
  }
}

function withProviderAnnotatedOutput(
  provider: ModelProvider,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): ((output: ContainerOutput) => Promise<void>) | undefined {
  if (!onOutput) return undefined;
  return async (output: ContainerOutput) => {
    if (output.status === 'stream' && output.streamEvent) {
      await onOutput({
        ...output,
        streamEvent: {
          ...output.streamEvent,
          provider,
        } as StreamEvent,
      });
      return;
    }
    await onOutput(output);
  };
}

/**
 * Try to select a provider from the pool. Returns profileId + resolved config,
 * or null if pool mode is off (≤1 enabled) / group has provider override / selection fails.
 */
function trySelectPoolProvider(
  groupFolder: string,
): { profileId: string; resolved: ResolvedProvider } | null {
  const override = getContainerEnvConfig(groupFolder);
  const hasOverride = !!(
    override.anthropicApiKey ||
    override.anthropicAuthToken ||
    override.anthropicBaseUrl
  );
  if (hasOverride) return null;

  // Refresh pool state from V4 config
  const enabledProviders = getEnabledProviders();
  if (enabledProviders.length <= 1) return null; // No pool needed for 0-1 providers

  const balancing = getBalancingConfig();
  providerPool.refreshFromConfig(enabledProviders, balancing);

  try {
    const profileId = providerPool.selectProvider();
    const resolved = resolveProviderById(profileId);
    providerPool.acquireSession(profileId);
    return {
      profileId,
      resolved: { config: resolved.config, customEnv: resolved.customEnv },
    };
  } catch (err) {
    logger.warn({ err }, 'Provider pool selection failed, falling back to active profile');
    return null;
  }
}

function buildVolumeMounts(
  group: RegisteredGroup,
  descriptor: ContainerRunnerDescriptor,
  isAdminHome: boolean,
  mountUserSkills = true,
  agentId?: string,
  ownerHomeFolder?: string,
  taskRunId?: string,
  resolvedProvider?: ResolvedProvider,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();

  // Per-user global memory directory:
  // Each user gets their own user-global/{userId}/ mounted as /workspace/global
  const ownerId = group.created_by;
  if (ownerId) {
    const userGlobalDir = path.join(GROUPS_DIR, 'user-global', ownerId);
    mkdirForContainer(userGlobalDir);
    mounts.push({
      hostPath: userGlobalDir,
      containerPath: '/workspace/global',
      readonly: !group.is_home,
    });
  } else {
    // Legacy fallback for rows without created_by.
    const legacyGlobalDir = path.join(GROUPS_DIR, 'global');
    mkdirForContainer(legacyGlobalDir);
    mounts.push({
      hostPath: legacyGlobalDir,
      containerPath: '/workspace/global',
      readonly: !isAdminHome,
    });
  }

  if (isAdminHome) {
    // Admin home gets the entire project root mounted
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: false,
    });

    // Admin home also gets its group folder as the working directory
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Member home and non-home groups only get their own folder
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false,
    });
  }

  // Memory directory: home containers write their own; non-home containers read owner's home memory
  const memoryFolder = group.is_home
    ? group.folder
    : ownerHomeFolder || group.folder;
  const memoryDir = path.join(DATA_DIR, 'memory', memoryFolder);
  mkdirForContainer(memoryDir);
  mounts.push({
    hostPath: memoryDir,
    containerPath: '/workspace/memory',
    readonly: !group.is_home,
  });

  // Per-group provider session directory (isolated from other groups)
  // Sub-agents get their own session dir under agents/{agentId}/.{provider}/
  const groupSessionsDir = agentId
    ? path.join(
        DATA_DIR,
        'sessions',
        group.folder,
        'agents',
        agentId,
        descriptor.sessionDirName,
      )
    : path.join(DATA_DIR, 'sessions', group.folder, descriptor.sessionDirName);
  mkdirForContainer(groupSessionsDir);

  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: descriptor.sessionHomePath,
    readonly: false,
  });

  if (descriptor.provider === 'claude') {
    const settingsFile = path.join(groupSessionsDir, 'settings.json');
    const mcpServers = ownerId ? loadUserMcpServers(ownerId) : {};
    ensureSettingsJson(settingsFile, mcpServers);
  } else {
    const sourceCodexHome = getEffectiveCodexHomeDir();
    for (const entry of CODEX_SHARED_HOME_ENTRIES) {
      const sourcePath = path.join(sourceCodexHome, entry);
      if (!fs.existsSync(sourcePath)) continue;
      mounts.push({
        hostPath: sourcePath,
        containerPath: path.posix.join(descriptor.sessionHomePath, entry),
        readonly: true,
      });
    }

    const codexBinHostPath = process.env.HAPPYCLAW_CODEX_BIN_HOST_PATH;
    const codexBinScriptHostPath =
      process.env.HAPPYCLAW_CODEX_BIN_SCRIPT_HOST_PATH;
    if (codexBinHostPath) {
      const resolvedCodexBinHostPath = path.resolve(codexBinHostPath);
      if (fs.existsSync(resolvedCodexBinHostPath)) {
        mounts.push({
          hostPath: resolvedCodexBinHostPath,
          containerPath:
            process.env.HAPPYCLAW_CODEX_BIN_CONTAINER_PATH ||
            DEFAULT_CODEX_BIN_CONTAINER_PATH,
          readonly: true,
        });
      }
    }
    if (codexBinScriptHostPath) {
      const resolvedCodexBinScriptHostPath = path.resolve(codexBinScriptHostPath);
      if (fs.existsSync(resolvedCodexBinScriptHostPath)) {
        mounts.push({
          hostPath: resolvedCodexBinScriptHostPath,
          containerPath:
            process.env.HAPPYCLAW_CODEX_BIN_SCRIPT_CONTAINER_PATH ||
            DEFAULT_CODEX_BIN_SCRIPT_CONTAINER_PATH,
          readonly: true,
        });
      }
    }
  }

  // Skills：以只读卷挂载宿主机目录（由 entrypoint 创建符号链接）
  // 用户的所有 skills 在其所有工作区中全量生效
  const projectSkillsDir = path.join(projectRoot, 'container', 'skills');
  const userSkillsDir =
    mountUserSkills && ownerId ? path.join(DATA_DIR, 'skills', ownerId) : null;

  // Ensure user skills directory exists so it can always be mounted.
  // Skills may be installed after the group is created; without pre-creating,
  // the existsSync check would skip mounting and the container would never see them.
  if (userSkillsDir) {
    fs.mkdirSync(userSkillsDir, { recursive: true });
  }

  // 全量挂载：用户的所有 skills 在所有工作区中生效
  if (fs.existsSync(projectSkillsDir)) {
    mounts.push({
      hostPath: projectSkillsDir,
      containerPath: '/workspace/project-skills',
      readonly: true,
    });
  }
  if (userSkillsDir) {
    mounts.push({
      hostPath: userSkillsDir,
      containerPath: '/workspace/user-skills',
      readonly: true,
    });
  }

  // Per-group IPC namespace: each group gets its own IPC directory
  // Sub-agents get their own IPC subdirectory under agents/{agentId}/
  // Isolated tasks get their own IPC subdirectory under tasks-run/{taskRunId}/
  // Use 0o777 so container (node/1000) and host (agent/1002) can both read/write.
  const groupIpcDir = agentId
    ? path.join(DATA_DIR, 'ipc', group.folder, 'agents', agentId)
    : taskRunId
      ? path.join(DATA_DIR, 'ipc', group.folder, 'tasks-run', taskRunId)
      : path.join(DATA_DIR, 'ipc', group.folder);
  mkdirForContainer(groupIpcDir);
  // All agents (main + sub/conversation) get agents/ subdir for spawn/message IPC
  // Use chmod 777 so both host (agent/1002) and container (node/1000) can write
  for (const sub of ['messages', 'tasks', 'input', 'agents'] as const) {
    const subDir = path.join(groupIpcDir, sub);
    fs.mkdirSync(subDir, { recursive: true });
    try {
      fs.chmodSync(subDir, 0o777);
    } catch {
      /* ignore if already correct */
    }
  }
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  if (descriptor.provider === 'claude') {
    // Per-container environment file (keeps credentials out of process listings)
    // Global config merged with per-container overrides.
    const envDir = path.join(DATA_DIR, 'env', group.folder);
    fs.mkdirSync(envDir, { recursive: true });
    const globalConfig = resolvedProvider?.config ?? getClaudeProviderConfig();
    const containerOverride = getContainerEnvConfig(group.folder);
    const envLines = buildContainerEnvLines(
      globalConfig,
      containerOverride,
      resolvedProvider?.customEnv,
    );
    if (envLines.length > 0) {
      const envFilePath = path.join(envDir, 'env');
      const quotedLines = shellQuoteEnvLines(envLines);
      fs.writeFileSync(envFilePath, quotedLines.join('\n') + '\n', {
        mode: 0o600,
      });
      try {
        fs.chmodSync(envFilePath, 0o600);
      } catch (err) {
        logger.warn(
          { group: group.name, err },
          'Failed to enforce env file permissions',
        );
      }
      mounts.push({
        hostPath: envDir,
        containerPath: '/workspace/env-dir',
        readonly: true,
      });
    }

    // Write .credentials.json for OAuth credentials (session dir is already mounted)
    const mergedConfig = mergeClaudeEnvConfig(globalConfig, containerOverride);
    if (mergedConfig.claudeOAuthCredentials) {
      try {
        writeCredentialsFile(groupSessionsDir, mergedConfig);
      } catch (err) {
        logger.warn(
          { group: group.name, err },
          'Failed to write .credentials.json',
        );
      }
    }
  }

  mounts.push({
    hostPath: descriptor.runnerSrcDir,
    containerPath: '/app/src',
    readonly: true,
  });

  // Admin's ~/.claude/ config: mount CLAUDE.md and rules/ into /workspace/
  // so the SDK's directory traversal (cwd → root) discovers them at /workspace/ level.
  // Only for admin-created workspaces (ownerHomeFolder === 'main').
  const isCreatorAdmin =
    descriptor.provider === 'claude' && ownerHomeFolder === 'main';
  if (isCreatorAdmin) {
    const hostClaudeDir = path.join(os.homedir(), '.claude');
    const hostClaudeMd = path.join(hostClaudeDir, 'CLAUDE.md');
    const hostRulesDir = path.join(hostClaudeDir, 'rules');

    if (fs.existsSync(hostClaudeMd)) {
      mounts.push({
        hostPath: hostClaudeMd,
        containerPath: '/workspace/CLAUDE.md',
        readonly: true,
      });
    }
    if (fs.existsSync(hostRulesDir)) {
      mounts.push({
        hostPath: hostRulesDir,
        containerPath: '/workspace/.claude/rules',
        readonly: true,
      });
    }
  }

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isAdminHome,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  descriptor: ContainerRunnerDescriptor,
  runtimeEnv: Record<string, string>,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  args.push('-e', `HAPPYCLAW_MODEL_PROVIDER=${descriptor.provider}`);
  args.push('-e', `HAPPYCLAW_AGENT_HOME=${descriptor.sessionHomePath}`);
  args.push('-e', `HAPPYCLAW_RUNNER_APP_DIR=${descriptor.runnerAppDir}`);
  args.push(
    '-e',
    `HAPPYCLAW_SHARED_MCP_TOOLS_MODULE=${descriptor.sharedToolsModulePath}`,
  );
  args.push('-e', `HAPPYCLAW_MCP_SERVER_ENTRY=${descriptor.mcpServerEntryPath}`);
  for (const [key, value] of Object.entries(runtimeEnv)) {
    args.push('-e', `${key}=${value}`);
  }
  if (descriptor.provider === 'codex') {
    args.push('-e', `CODEX_HOME=${descriptor.sessionHomePath}`);
    if (
      process.env.HAPPYCLAW_CODEX_BIN_HOST_PATH ||
      process.env.HAPPYCLAW_CODEX_BIN
    ) {
      args.push(
        '-e',
        `HAPPYCLAW_CODEX_BIN=${
          process.env.HAPPYCLAW_CODEX_BIN ||
          process.env.HAPPYCLAW_CODEX_BIN_CONTAINER_PATH ||
          DEFAULT_CODEX_BIN_CONTAINER_PATH
        }`,
      );
    }
    if (process.env.HAPPYCLAW_CODEX_BIN_SCRIPT_HOST_PATH) {
      args.push(
        '-e',
        `HAPPYCLAW_CODEX_BIN_SCRIPT_PATH=${
          process.env.HAPPYCLAW_CODEX_BIN_SCRIPT_CONTAINER_PATH ||
          DEFAULT_CODEX_BIN_SCRIPT_CONTAINER_PATH
        }`,
      );
    }
  } else {
    args.push('-e', `CLAUDE_CONFIG_DIR=${descriptor.sessionHomePath}`);
  }

  // Docker: -v with :ro suffix for readonly
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}:ro`);
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(descriptor.imageName);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  ownerHomeFolder?: string,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const descriptor = getContainerRunnerDescriptor(group.modelProvider);

  const groupDir = path.join(GROUPS_DIR, group.folder);
  mkdirForContainer(groupDir);

  // ─── Provider Pool selection ───
  const poolResult = descriptor.provider === 'claude'
    ? trySelectPoolProvider(group.folder)
    : null;
  const selectedProfileId = poolResult?.profileId ?? null;
  const resolvedProvider = poolResult?.resolved;
  const providerAwareOnOutput = withProviderAnnotatedOutput(
    descriptor.provider,
    onOutput,
  );

  try {
    // Determine if this is an admin home container (full privileges)
    const isAdminHome = !!group.is_home && group.folder === 'main';
    // Per-user skills: always mount if the group has an owner
    const shouldMountUserSkills = !!group.created_by;
    const mounts = buildVolumeMounts(
      group,
      descriptor,
      isAdminHome,
      shouldMountUserSkills,
      input.agentId,
      ownerHomeFolder,
      input.taskRunId,
      resolvedProvider,
    );
    const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
    const agentSuffix = input.agentId
      ? `-${input.agentId.replace(/[^a-zA-Z0-9-]/g, '-')}`
      : '';
    const containerName =
      `happyclaw-${descriptor.provider}-${safeName}${agentSuffix}-${Date.now()}`;
    const runtimeEnv = {
      HAPPYCLAW_CHAT_JID: input.chatJid,
      HAPPYCLAW_GROUP_FOLDER: group.folder,
      HAPPYCLAW_IS_HOME: String(!!group.is_home),
      HAPPYCLAW_IS_ADMIN_HOME: String(isAdminHome),
      HAPPYCLAW_IS_SCHEDULED_TASK: String(!!input.isScheduledTask),
      ...(descriptor.provider === 'codex' ? getCodexRuntimeEnvVars() : {}),
    };
    const containerArgs = buildContainerArgs(
      mounts,
      containerName,
      descriptor,
      runtimeEnv,
    );

    logger.debug(
      {
        group: group.name,
        provider: descriptor.provider,
        image: descriptor.imageName,
        containerName,
        mounts: mounts.map(
          (m) =>
            `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
        ),
        containerArgs: containerArgs.join(' '),
      },
      'Container mount configuration',
    );

    logger.info(
      {
        group: group.name,
        provider: descriptor.provider,
        image: descriptor.imageName,
        containerName,
        mountCount: mounts.length,
        isMain: input.isMain,
      },
      'Spawning container agent',
    );

    const logsDir = path.join(GROUPS_DIR, group.folder, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });

    const result = await new Promise<ContainerOutput>((resolve) => {
      const container = spawn('docker', containerArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      onProcess(container, containerName);

      const stdoutState = createStdoutParserState();
      const stderrState = createStderrState();

      // Write input and close stdin (容器需要 EOF 来刷新 stdin 管道)
      container.stdin.on('error', (err) => {
        logger.error(
          { group: group.name, err },
          'Container stdin write failed',
        );
        container.kill();
      });
      container.stdin.write(JSON.stringify(input));
      container.stdin.end();

      let timedOut = false;
      const timeoutMs =
        group.containerConfig?.timeout || getSystemSettings().containerTimeout;

      const killOnTimeout = () => {
        timedOut = true;
        logger.error(
          { group: group.name, containerName },
          'Container timeout, stopping gracefully',
        );
        execFile(
          'docker',
          ['stop', containerName],
          { timeout: 15000 },
          (err) => {
            if (err) {
              logger.warn(
                { group: group.name, containerName, err },
                'Graceful stop failed, force killing',
              );
              container.kill('SIGKILL');
            }
          },
        );
      };

      let timeout = setTimeout(killOnTimeout, timeoutMs);

      const resetTimeout = () => {
        clearTimeout(timeout);
        timeout = setTimeout(killOnTimeout, timeoutMs);
      };

      // Attach stdout/stderr handlers using shared parser
      attachStdoutHandler(container.stdout, stdoutState, {
        groupName: group.name,
        label: 'Container',
        onOutput: providerAwareOnOutput,
        resetTimeout,
      });
      attachStderrHandler(container.stderr, stderrState, group.name, {
        container: group.folder,
      });

      container.on('close', (code, signal) => {
        clearTimeout(timeout);
        const duration = Date.now() - startTime;

        const closeCtx: CloseHandlerContext = {
          groupName: group.name,
          label: 'Container',
          filePrefix: 'container',
          identifier: containerName,
          logsDir,
          input,
          stdoutState,
          stderrState,
          onOutput: providerAwareOnOutput,
          resolvePromise: resolve,
          startTime,
          timeoutMs,
          extraSummaryLines: [
            ``,
            `=== Mounts ===`,
            mounts
              .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
              .join('\n'),
          ],
          extraVerboseLines: [
            `=== Container Args ===`,
            containerArgs.join(' '),
            ``,
            `=== Mounts (detailed) ===`,
            mounts
              .map(
                (m) =>
                  `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
              )
              .join('\n'),
          ],
        };

        if (handleTimeoutClose(closeCtx, code, duration, timedOut)) return;
        const logFile = writeRunLog(closeCtx, code, duration);
        if (handleNonZeroExit(closeCtx, code, signal, duration, logFile))
          return;
        handleSuccessClose(closeCtx, duration);
      });

      container.on('error', (err) => {
        clearTimeout(timeout);
        logger.error(
          { group: group.name, containerName, error: err },
          'Container spawn error',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Container spawn error: ${err.message}`,
        });
      });
    });

    // ─── Provider Pool health reporting ───
    if (selectedProfileId) {
      if (result.status === 'success' || result.status === 'closed') {
        providerPool.reportSuccess(selectedProfileId);
      } else if (result.status === 'error' && isApiError(result.error || '')) {
        providerPool.reportFailure(selectedProfileId);
      }
    }

    return result;
  } finally {
    // Guarantee session release even if buildVolumeMounts/spawn throws
    if (selectedProfileId) {
      providerPool.releaseSession(selectedProfileId);
    }
  }
}

export function writeTasksSnapshot(
  groupFolder: string,
  isAdminHome: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Admin home sees all tasks, others only see their own
  const filteredTasks = isAdminHome
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  // 删除后重建：容器创建的文件归属 node(1000) 用户，宿主机进程无法覆写
  try {
    fs.unlinkSync(tasksFile);
  } catch {
    /* ignore */
  }
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only admin home can see all available groups (for activation).
 * Other groups see nothing (they can't activate groups).
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isAdminHome: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Admin home sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isAdminHome ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  try {
    fs.unlinkSync(groupsFile);
  } catch {
    /* ignore */
  }
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

/**
 * 杀死进程及其所有子进程。
 * 如果进程以 detached 模式启动（独立进程组），使用负 PID 杀整个进程组。
 */
export function killProcessTree(
  proc: ChildProcess,
  signal: NodeJS.Signals = 'SIGTERM',
): boolean {
  try {
    if (proc.pid) {
      process.kill(-proc.pid, signal);
      return true;
    }
  } catch {
    try {
      proc.kill(signal);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Run agent directly on the host machine (no Docker container).
 * Used for host execution mode — the agent gets full access to the host filesystem.
 */
export async function runHostAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, identifier: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  ownerHomeFolder?: string,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const descriptor = getHostRunnerDescriptor(group.modelProvider);
  const isCodexProvider = descriptor.provider === 'codex';
  const providerAwareOnOutput = withProviderAnnotatedOutput(
    descriptor.provider,
    onOutput,
  );
  const setupInstallHint = descriptor.setupInstallHint;
  const setupBuildHint = descriptor.setupBuildHint;
  const hostModeSetupError = (message: string): ContainerOutput => ({
    status: 'error',
    result: `宿主机模式启动失败：${message}`,
    error: message,
  });
  const isAdminHome = !!group.is_home && group.folder === 'main';

  // 1. 确定工作目录
  const defaultGroupDir = path.join(GROUPS_DIR, group.folder);
  if (!group.customCwd) {
    fs.mkdirSync(defaultGroupDir, { recursive: true });
    // 确保 group 目录是独立 git root，防止 Claude Code 向上找到父项目的 .git
    const gitDir = path.join(defaultGroupDir, '.git');
    if (!fs.existsSync(gitDir)) {
      try {
        execFileSync('git', ['init'], {
          cwd: defaultGroupDir,
          stdio: 'ignore',
        });
        logger.info(
          { folder: group.folder },
          'Initialized git repository for group',
        );
      } catch (err) {
        // Non-fatal: agent still works, just reports wrong working directory
        logger.warn(
          { folder: group.folder, err },
          'Failed to initialize git repository',
        );
      }
    }
  }
  let groupDir = group.customCwd || defaultGroupDir;
  if (!path.isAbsolute(groupDir)) {
    return hostModeSetupError(`工作目录必须是绝对路径：${groupDir}`);
  }
  // Resolve symlinks to prevent TOCTOU attacks
  try {
    groupDir = fs.realpathSync(groupDir);
  } catch {
    return hostModeSetupError(`工作目录不存在或无法解析：${groupDir}`);
  }
  if (!fs.statSync(groupDir).isDirectory()) {
    return hostModeSetupError(`工作目录不是目录：${groupDir}`);
  }

  // Runtime allowlist validation for custom CWD (defense-in-depth: web.ts validates at creation,
  // but re-check here in case allowlist was tightened or path was injected via DB)
  if (group.customCwd) {
    const allowlist = loadMountAllowlist();
    if (
      allowlist &&
      allowlist.allowedRoots &&
      allowlist.allowedRoots.length > 0
    ) {
      let allowed = false;
      for (const root of allowlist.allowedRoots) {
        const expandedRoot = root.path.startsWith('~')
          ? path.join(
              process.env.HOME || '/Users/user',
              root.path.slice(root.path.startsWith('~/') ? 2 : 1),
            )
          : path.resolve(root.path);

        let realRoot: string;
        try {
          realRoot = fs.realpathSync(expandedRoot);
        } catch {
          continue;
        }

        const relative = path.relative(realRoot, groupDir);
        if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
          allowed = true;
          break;
        }
      }

      if (!allowed) {
        return hostModeSetupError(
          `工作目录 ${groupDir} 不在允许的根目录下，请检查 mount-allowlist.json`,
        );
      }
    }
  }

  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'memory', group.folder), {
    recursive: true,
  });

  // 2. 确保目录结构（宿主机模式下限制目录权限）
  // Sub-agents get their own IPC and session directories
  // Isolated tasks get their own IPC subdirectory under tasks-run/{taskRunId}/
  const groupIpcDir = input.agentId
    ? path.join(DATA_DIR, 'ipc', group.folder, 'agents', input.agentId)
    : input.taskRunId
      ? path.join(DATA_DIR, 'ipc', group.folder, 'tasks-run', input.taskRunId)
      : path.join(DATA_DIR, 'ipc', group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), {
    recursive: true,
    mode: 0o700,
  });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), {
    recursive: true,
    mode: 0o700,
  });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), {
    recursive: true,
    mode: 0o700,
  });
  // All agents (main + sub/conversation) get agents/ subdir for spawn/message IPC
  fs.mkdirSync(path.join(groupIpcDir, 'agents'), {
    recursive: true,
    mode: 0o700,
  });

  const groupSessionsDir = input.agentId
    ? path.join(
        DATA_DIR,
        'sessions',
        group.folder,
        'agents',
        input.agentId,
        descriptor.sessionDirName,
      )
    : path.join(DATA_DIR, 'sessions', group.folder, descriptor.sessionDirName);
  fs.mkdirSync(groupSessionsDir, { recursive: true });

  // 3. 写入 provider 对应的会话目录初始化
  if (isCodexProvider) {
    try {
      ensureCodexHomeBootstrap(groupSessionsDir);
    } catch (err) {
      logger.warn(
        { folder: group.folder, err },
        '宿主机模式 Codex home 初始化失败',
      );
    }
  } else {
    const settingsFile = path.join(groupSessionsDir, 'settings.json');
    const hostMcpServers = group.created_by
      ? loadUserMcpServers(group.created_by)
      : {};
    ensureSettingsJson(settingsFile, hostMcpServers);

    // 4. Skills 自动链接到 session 目录
    // 链接顺序：项目级 → 用户级(覆盖同名项目级)
    // 用户的所有 skills 在所有工作区中生效
    try {
      const skillsDir = path.join(groupSessionsDir, 'skills');
      fs.mkdirSync(skillsDir, { recursive: true });
      for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        const entryPath = path.join(skillsDir, entry.name);
        try {
          if (entry.isSymbolicLink() || entry.isDirectory()) {
            fs.rmSync(entryPath, { recursive: true, force: true });
          }
        } catch {
          /* ignore */
        }
      }

      const linkSkillEntries = (sourceDir: string) => {
        if (!fs.existsSync(sourceDir)) return;
        for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
          const linkPath = path.join(skillsDir, entry.name);
          try {
            if (fs.existsSync(linkPath)) {
              fs.rmSync(linkPath, { recursive: true, force: true });
            }
            fs.symlinkSync(path.join(sourceDir, entry.name), linkPath);
          } catch {
            /* ignore */
          }
        }
      };

      const projectRoot = process.cwd();
      linkSkillEntries(path.join(projectRoot, 'container', 'skills'));
      const ownerId = group.created_by;
      if (ownerId) {
        linkSkillEntries(path.join(DATA_DIR, 'skills', ownerId));
      }
    } catch (err) {
      logger.warn(
        { folder: group.folder, err },
        '宿主机模式 skills 符号链接失败',
      );
    }
  }

  // 5. 构建环境变量
  const hostEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };

  const containerOverride = isCodexProvider
    ? null
    : getContainerEnvConfig(group.folder);
  const hostPoolResult = isCodexProvider
    ? null
    : trySelectPoolProvider(group.folder);
  const hostSelectedProfileId = hostPoolResult?.profileId ?? null;
  const globalConfig = hostPoolResult?.resolved.config ?? getClaudeProviderConfig();

  try {
    if (!isCodexProvider && containerOverride) {
      const envLines = buildContainerEnvLines(
        globalConfig,
        containerOverride,
        hostPoolResult?.resolved.customEnv,
      );
      for (const line of envLines) {
        const eqIdx = line.indexOf('=');
        if (eqIdx > 0) {
          hostEnv[line.slice(0, eqIdx)] = line.slice(eqIdx + 1);
        }
      }
    }

    if (!isCodexProvider && containerOverride) {
      const mergedConfig = mergeClaudeEnvConfig(globalConfig, containerOverride);
      if (mergedConfig.claudeOAuthCredentials) {
        try {
          writeCredentialsFile(groupSessionsDir, mergedConfig);
        } catch (err) {
          logger.warn(
            { folder: group.folder, err },
            'Failed to write .credentials.json for host agent',
          );
        }
      }
    }

    // 路径映射
    hostEnv['HAPPYCLAW_WORKSPACE_GROUP'] = groupDir;
    // Per-user global memory
    const ownerId = group.created_by;
    if (ownerId) {
      const userGlobalDir = path.join(GROUPS_DIR, 'user-global', ownerId);
      fs.mkdirSync(userGlobalDir, { recursive: true });
      hostEnv['HAPPYCLAW_WORKSPACE_GLOBAL'] = userGlobalDir;
    } else {
      const legacyGlobalDir = path.join(GROUPS_DIR, 'global');
      fs.mkdirSync(legacyGlobalDir, { recursive: true });
      hostEnv['HAPPYCLAW_WORKSPACE_GLOBAL'] = legacyGlobalDir;
    }
    const memoryFolder = group.is_home
      ? group.folder
      : ownerHomeFolder || group.folder;
    hostEnv['HAPPYCLAW_WORKSPACE_MEMORY'] = path.join(
      DATA_DIR,
      'memory',
      memoryFolder,
    );
    hostEnv['HAPPYCLAW_WORKSPACE_IPC'] = groupIpcDir;
    hostEnv['HAPPYCLAW_MODEL_PROVIDER'] = descriptor.provider;
    hostEnv['HAPPYCLAW_CHAT_JID'] = input.chatJid;
    hostEnv['HAPPYCLAW_GROUP_FOLDER'] = group.folder;
    hostEnv['HAPPYCLAW_IS_HOME'] = String(!!group.is_home);
    hostEnv['HAPPYCLAW_IS_ADMIN_HOME'] = String(isAdminHome);
    hostEnv['HAPPYCLAW_IS_SCHEDULED_TASK'] = String(
      !!input.isScheduledTask,
    );
    hostEnv['HAPPYCLAW_SHARED_MCP_TOOLS_MODULE'] =
      descriptor.sharedToolsModulePath;
    hostEnv['HAPPYCLAW_MCP_SERVER_ENTRY'] = descriptor.mcpServerEntryPath;
    if (isCodexProvider) {
      hostEnv['CODEX_HOME'] = groupSessionsDir;
      Object.assign(hostEnv, getCodexRuntimeEnvVars());
    } else {
      hostEnv['CLAUDE_CONFIG_DIR'] = groupSessionsDir;
      hostEnv['DEBUG_CLAUDE_AGENT_SDK'] = '1';
      if (typeof process.getuid === 'function' && process.getuid() === 0) {
        hostEnv['IS_SANDBOX'] = '1';
      }
    }

    // 6. 编译检查
    const runnerNodeModules = path.join(descriptor.runnerRoot, 'node_modules');
    if (!isCodexProvider && !descriptor.customEntry) {
      const requiredDeps = ['@anthropic-ai/claude-agent-sdk'];
      const missingDeps = requiredDeps.filter((dep) => {
        const depJson = path.join(
          runnerNodeModules,
          ...dep.split('/'),
          'package.json',
        );
        return !fs.existsSync(depJson);
      });
      if (missingDeps.length > 0) {
        const missing = missingDeps.join(', ');
        logger.error(
          { group: group.name, missingDeps },
          'Host agent preflight failed: dependencies missing',
        );
        return hostModeSetupError(
          `缺少 agent-runner 依赖（${missing}）。请先执行：${setupInstallHint}`,
        );
      }
    }
    if (!fs.existsSync(descriptor.distEntry)) {
      logger.error(
        { group: group.name, distEntry: descriptor.distEntry, provider: descriptor.provider },
        'Host agent preflight failed: dist not found',
      );
      return hostModeSetupError(
        `${descriptor.provider === 'codex' ? 'codex-runner' : 'agent-runner'} 未编译。请先执行：${setupBuildHint}`,
      );
    }

    // Auto-rebuild if dist is stale (src newer than dist)
    try {
      const distMtime = fs.statSync(descriptor.distEntry).mtimeMs;
      const srcDir = path.join(descriptor.runnerRoot, 'src');
      if (!descriptor.customEntry && fs.existsSync(srcDir)) {
        const srcFiles = fs.readdirSync(srcDir);
        const newestSrc = Math.max(
          ...srcFiles.map((f) => fs.statSync(path.join(srcDir, f)).mtimeMs),
        );
        if (newestSrc > distMtime) {
          logger.info(
            { group: group.name, provider: descriptor.provider },
            `${descriptor.provider === 'codex' ? 'codex-runner' : 'agent-runner'} dist 已过期，自动重新编译...`,
          );
          try {
            const { execSync } = await import('child_process');
            execSync('npm run build', {
              cwd: descriptor.runnerRoot,
              stdio: 'pipe',
              timeout: 30_000,
            });
            logger.info(
              { group: group.name, provider: descriptor.provider },
              `${descriptor.provider === 'codex' ? 'codex-runner' : 'agent-runner'} 自动编译完成`,
            );
          } catch (buildErr) {
            logger.warn(
              { group: group.name, err: buildErr, provider: descriptor.provider },
              `${descriptor.provider === 'codex' ? 'codex-runner' : 'agent-runner'} 自动编译失败，使用旧版 dist。手动执行：${setupBuildHint}`,
            );
          }
        }
      }
    } catch {
      // Best effort, don't block execution
    }

    logger.info(
      {
        group: group.name,
        workingDir: groupDir,
        isMain: input.isMain,
        provider: descriptor.provider,
      },
      'Spawning host runner',
    );

    const logsDir = path.join(groupDir, 'logs');

    const hostResult = await new Promise<ContainerOutput>((resolve) => {
      let settled = false;
      const resolveOnce = (output: ContainerOutput): void => {
        if (settled) return;
        settled = true;
        resolve(output);
      };

      // 7. 启动进程
      const proc = spawn('node', [descriptor.distEntry], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: hostEnv,
        cwd: groupDir,
        detached: true,
      });

      const processId = `host-${group.folder}-${Date.now()}`;
      onProcess(proc, processId);

      const stdoutState = createStdoutParserState();
      const stderrState = createStderrState();

      // 8. stdin 输入
      proc.stdin.on('error', (err) => {
        logger.error(
          { group: group.name, err },
          'Host agent stdin write failed',
        );
        killProcessTree(proc);
      });
      proc.stdin.write(JSON.stringify(input));
      proc.stdin.end();

      // 9. 超时管理
      let timedOut = false;
      const timeoutMs =
        group.containerConfig?.timeout || getSystemSettings().containerTimeout;

      let killTimer: ReturnType<typeof setTimeout> | null = null;

      const killOnTimeout = () => {
        timedOut = true;
        logger.error(
          { group: group.name, processId },
          'Host agent timeout, killing',
        );
        killProcessTree(proc, 'SIGTERM');
        killTimer = setTimeout(() => {
          if (proc.exitCode === null && proc.signalCode === null) {
            killProcessTree(proc, 'SIGKILL');
          }
        }, 5000);
      };

      let timeout = setTimeout(killOnTimeout, timeoutMs);

      const resetTimeout = () => {
        clearTimeout(timeout);
        timeout = setTimeout(killOnTimeout, timeoutMs);
      };

      // 10. stdout/stderr 解析
      attachStdoutHandler(proc.stdout, stdoutState, {
        groupName: group.name,
        label: 'Host agent',
        onOutput: providerAwareOnOutput,
        resetTimeout,
      });
      attachStderrHandler(proc.stderr, stderrState, group.name, {
        host: group.folder,
      });

      // 11. close 事件处理
      proc.on('close', (code, signal) => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        const duration = Date.now() - startTime;

        const closeCtx: CloseHandlerContext = {
          groupName: group.name,
          label: 'Host Agent',
          filePrefix: 'host',
          identifier: processId,
          logsDir,
          input,
          stdoutState,
          stderrState,
          onOutput: providerAwareOnOutput,
          resolvePromise: resolveOnce,
          startTime,
          timeoutMs,
          extraSummaryLines: [`Working Directory: ${groupDir}`],
          enrichError: (stderrContent, exitLabel) => {
            const missingPackageMatch = stderrContent.match(
              /Cannot find package '([^']+)' imported from/u,
            );
            const userFacingError = missingPackageMatch
              ? `宿主机模式启动失败：缺少依赖 ${missingPackageMatch[1]}。请先执行：${setupInstallHint}`
              : null;
            return {
              result: userFacingError,
              error: `Host agent exited with ${exitLabel}: ${stderrContent.slice(-200)}`,
            };
          },
        };

        if (handleTimeoutClose(closeCtx, code, duration, timedOut)) return;
        const logFile = writeRunLog(closeCtx, code, duration);
        if (handleNonZeroExit(closeCtx, code, signal, duration, logFile))
          return;
        handleSuccessClose(closeCtx, duration);
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        logger.error(
          { group: group.name, processId, error: err },
          'Host agent spawn error',
        );
        resolveOnce({
          status: 'error',
          result: null,
          error: `Host agent spawn error: ${err.message}`,
        });
      });
    });

    // ─── Provider Pool health reporting (host mode) ───
    if (hostSelectedProfileId) {
      if (hostResult.status === 'success' || hostResult.status === 'closed') {
        providerPool.reportSuccess(hostSelectedProfileId);
      } else if (
        hostResult.status === 'error' &&
        isApiError(hostResult.error || '')
      ) {
        providerPool.reportFailure(hostSelectedProfileId);
      }
    }

    return hostResult;
  } finally {
    // Guarantee session release even if spawn/setup throws
    if (hostSelectedProfileId) {
      providerPool.releaseSession(hostSelectedProfileId);
    }
  }
}
