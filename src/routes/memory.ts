// Memory management routes and utilities

import { Hono } from 'hono';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Variables } from '../web-context.js';
import { authMiddleware, systemConfigMiddleware } from '../middleware/auth.js';
import {
  MemoryFileSchema,
  MemoryGlobalSchema,
  type MemorySource,
  type MemoryFilePayload,
  type MemorySearchHit,
} from '../schemas.js';
import { getAllRegisteredGroups } from '../db.js';
import { logger } from '../logger.js';
import { GROUPS_DIR, DATA_DIR } from '../config.js';

const memoryRoutes = new Hono<{ Variables: Variables }>();

// --- Constants ---

const GLOBAL_MEMORY_DIR = path.join(GROUPS_DIR, 'global');
const GLOBAL_MEMORY_FILE = path.join(GLOBAL_MEMORY_DIR, 'CLAUDE.md');
const MAIN_MEMORY_DIR = path.join(GROUPS_DIR, 'main');
const MAIN_MEMORY_FILE = path.join(MAIN_MEMORY_DIR, 'CLAUDE.md');
const MEMORY_DATA_DIR = path.join(DATA_DIR, 'memory');
const MAX_GLOBAL_MEMORY_LENGTH = 200_000;
const MAX_MEMORY_FILE_LENGTH = 500_000;
const MEMORY_LIST_LIMIT = 500;
const MEMORY_SEARCH_LIMIT = 120;
const MEMORY_SOURCE_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.json',
  '.jsonl',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
]);

// --- Utility Functions ---

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function normalizeRelativePath(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('path must be a string');
  }
  const normalized = input.replace(/\\/g, '/').trim().replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0')) {
    throw new Error('Invalid memory path');
  }
  const parts = normalized.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) {
    throw new Error('Invalid memory path');
  }
  return normalized;
}

function resolveMemoryPath(relativePath: string): {
  absolutePath: string;
  writable: boolean;
} {
  const absolute = path.resolve(process.cwd(), relativePath);
  const inGroups = isWithinRoot(absolute, GROUPS_DIR);
  const inMemoryData = isWithinRoot(absolute, MEMORY_DATA_DIR);
  const inSessions = isWithinRoot(absolute, path.join(DATA_DIR, 'sessions'));
  const writable = inGroups || inMemoryData;
  const readable = writable || inSessions;

  if (!readable) {
    throw new Error('Memory path out of allowed scope');
  }
  return { absolutePath: absolute, writable };
}

function classifyMemorySource(
  relativePath: string,
): Pick<MemorySource, 'scope' | 'kind' | 'label'> {
  const parts = relativePath.split('/');
  if (relativePath === 'groups/global/CLAUDE.md') {
    return { scope: 'global', kind: 'claude', label: '全局记忆 / CLAUDE.md' };
  }
  if (relativePath === 'groups/main/CLAUDE.md') {
    return { scope: 'main', kind: 'claude', label: '主会话记忆 / CLAUDE.md' };
  }
  if (parts[0] === 'data' && parts[1] === 'memory') {
    const folder = parts[2] || 'unknown';
    const name = parts.slice(3).join('/') || 'memory';
    return {
      scope: folder === 'main' ? 'main' : 'flow',
      kind: 'note' as const,
      label: `${folder} / 日期记忆 / ${name}`,
    };
  }
  if (parts[0] === 'groups') {
    const folder = parts[1] || 'unknown';
    const name = parts.slice(2).join('/');
    const kind = name === 'CLAUDE.md' ? 'claude' : 'note';
    return {
      scope:
        folder === 'global' ? 'global' : folder === 'main' ? 'main' : 'flow',
      kind,
      label: `${folder} / ${name}`,
    };
  }
  const sessionRel = parts.slice(2).join('/');
  return {
    scope: 'session',
    kind: 'session',
    label: `会话自动记忆 / ${sessionRel}`,
  };
}

function readMemoryFile(relativePath: string): MemoryFilePayload {
  const normalized = normalizeRelativePath(relativePath);
  const { absolutePath, writable } = resolveMemoryPath(normalized);
  if (!fs.existsSync(absolutePath)) {
    if (!writable) {
      throw new Error('Memory file not found');
    }
    return {
      path: normalized,
      content: '',
      updatedAt: null,
      size: 0,
      writable,
    };
  }
  const content = fs.readFileSync(absolutePath, 'utf-8');
  const stat = fs.statSync(absolutePath);
  return {
    path: normalized,
    content,
    updatedAt: stat.mtime.toISOString(),
    size: Buffer.byteLength(content, 'utf-8'),
    writable,
  };
}

function writeMemoryFile(
  relativePath: string,
  content: string,
): MemoryFilePayload {
  const normalized = normalizeRelativePath(relativePath);
  const { absolutePath, writable } = resolveMemoryPath(normalized);
  if (!writable) {
    throw new Error('Memory file is read-only');
  }
  if (Buffer.byteLength(content, 'utf-8') > MAX_MEMORY_FILE_LENGTH) {
    throw new Error('Memory file is too large');
  }

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const tempPath = `${absolutePath}.tmp`;
  fs.writeFileSync(tempPath, content, 'utf-8');
  fs.renameSync(tempPath, absolutePath);

  const stat = fs.statSync(absolutePath);
  return {
    path: normalized,
    content,
    updatedAt: stat.mtime.toISOString(),
    size: Buffer.byteLength(content, 'utf-8'),
    writable,
  };
}

function walkFiles(
  baseDir: string,
  maxDepth: number,
  limit: number,
  out: string[],
  currentDepth = 0,
): void {
  if (out.length >= limit || currentDepth > maxDepth || !fs.existsSync(baseDir))
    return;
  const entries = fs.readdirSync(baseDir, { withFileTypes: true });
  for (const entry of entries) {
    if (out.length >= limit) break;
    const fullPath = path.join(baseDir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, maxDepth, limit, out, currentDepth + 1);
      continue;
    }
    out.push(fullPath);
  }
}

function isMemoryCandidateFile(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  if (base === 'settings.json') return true;
  const ext = path.extname(base);
  return MEMORY_SOURCE_EXTENSIONS.has(ext);
}

function listMemorySources(): MemorySource[] {
  const files = new Set<string>([GLOBAL_MEMORY_FILE, MAIN_MEMORY_FILE]);

  const groups = getAllRegisteredGroups();
  for (const group of Object.values(groups)) {
    files.add(path.join(GROUPS_DIR, group.folder, 'CLAUDE.md'));
  }

  const groupScanned: string[] = [];
  walkFiles(GROUPS_DIR, 4, MEMORY_LIST_LIMIT, groupScanned);
  for (const f of groupScanned) {
    if (isMemoryCandidateFile(f)) {
      files.add(f);
    }
  }

  // Scan data/memory/ for dated memory files
  const memoryDataScanned: string[] = [];
  walkFiles(MEMORY_DATA_DIR, 4, MEMORY_LIST_LIMIT, memoryDataScanned);
  for (const f of memoryDataScanned) {
    if (isMemoryCandidateFile(f)) {
      files.add(f);
    }
  }

  const sessionScanned: string[] = [];
  walkFiles(
    path.join(DATA_DIR, 'sessions'),
    7,
    MEMORY_LIST_LIMIT,
    sessionScanned,
  );
  for (const f of sessionScanned) {
    if (isMemoryCandidateFile(f)) {
      files.add(f);
    }
  }

  const sources: MemorySource[] = [];
  for (const absolutePath of files) {
    const readable =
      isWithinRoot(absolutePath, GROUPS_DIR) ||
      isWithinRoot(absolutePath, MEMORY_DATA_DIR) ||
      isWithinRoot(absolutePath, path.join(DATA_DIR, 'sessions'));
    if (!readable) continue;

    const relativePath = path
      .relative(process.cwd(), absolutePath)
      .replace(/\\/g, '/');
    const writable = isWithinRoot(absolutePath, GROUPS_DIR) || isWithinRoot(absolutePath, MEMORY_DATA_DIR);
    const exists = fs.existsSync(absolutePath);
    let updatedAt: string | null = null;
    let size = 0;
    if (exists) {
      const stat = fs.statSync(absolutePath);
      updatedAt = stat.mtime.toISOString();
      size = stat.size;
    }

    const classified = classifyMemorySource(relativePath);
    sources.push({
      path: relativePath,
      writable,
      exists,
      updatedAt,
      size,
      ...classified,
    });
  }

  const scopeRank: Record<MemorySource['scope'], number> = {
    global: 0,
    main: 1,
    flow: 2,
    session: 3,
  };
  const kindRank: Record<MemorySource['kind'], number> = {
    claude: 0,
    note: 1,
    session: 2,
  };

  sources.sort((a, b) => {
    if (scopeRank[a.scope] !== scopeRank[b.scope])
      return scopeRank[a.scope] - scopeRank[b.scope];
    if (kindRank[a.kind] !== kindRank[b.kind])
      return kindRank[a.kind] - kindRank[b.kind];
    return a.path.localeCompare(b.path, 'zh-CN');
  });

  return sources.slice(0, MEMORY_LIST_LIMIT);
}

function buildSearchSnippet(
  content: string,
  index: number,
  keywordLength: number,
): string {
  const start = Math.max(0, index - 36);
  const end = Math.min(content.length, index + keywordLength + 36);
  return content.slice(start, end).replace(/\s+/g, ' ').trim();
}

function searchMemorySources(
  keyword: string,
  limit = MEMORY_SEARCH_LIMIT,
): MemorySearchHit[] {
  const normalizedKeyword = keyword.trim().toLowerCase();
  if (!normalizedKeyword) return [];

  const maxResults = Number.isFinite(limit)
    ? Math.max(1, Math.min(MEMORY_SEARCH_LIMIT, Math.trunc(limit)))
    : MEMORY_SEARCH_LIMIT;

  const hits: MemorySearchHit[] = [];
  const sources = listMemorySources();

  for (const source of sources) {
    if (hits.length >= maxResults) break;
    if (!source.exists || source.size === 0) continue;
    if (source.size > MAX_MEMORY_FILE_LENGTH) continue;

    try {
      const payload = readMemoryFile(source.path);
      const lower = payload.content.toLowerCase();
      const firstIndex = lower.indexOf(normalizedKeyword);
      if (firstIndex === -1) continue;

      let count = 0;
      let from = 0;
      while (from < lower.length) {
        const idx = lower.indexOf(normalizedKeyword, from);
        if (idx === -1) break;
        count += 1;
        from = idx + normalizedKeyword.length;
      }

      hits.push({
        ...source,
        hits: count,
        snippet: buildSearchSnippet(
          payload.content,
          firstIndex,
          normalizedKeyword.length,
        ),
      });
    } catch {
      continue;
    }
  }

  return hits;
}

// --- Routes ---

memoryRoutes.get('/sources', authMiddleware, systemConfigMiddleware, (c) => {
  try {
    return c.json({ sources: listMemorySources() });
  } catch (err) {
    logger.error({ err }, 'Failed to list memory sources');
    return c.json({ error: 'Failed to list memory sources' }, 500);
  }
});

memoryRoutes.get('/search', authMiddleware, systemConfigMiddleware, (c) => {
  const query = c.req.query('q');
  if (!query || !query.trim()) {
    return c.json({ error: 'Missing q' }, 400);
  }
  const limitRaw = Number(c.req.query('limit'));
  const limit = Number.isFinite(limitRaw) ? limitRaw : MEMORY_SEARCH_LIMIT;
  try {
    return c.json({ hits: searchMemorySources(query, limit) });
  } catch (err) {
    logger.error({ err }, 'Failed to search memory sources');
    return c.json({ error: 'Failed to search memory sources' }, 500);
  }
});

memoryRoutes.get('/file', authMiddleware, systemConfigMiddleware, (c) => {
  const filePath = c.req.query('path');
  if (!filePath) return c.json({ error: 'Missing path' }, 400);
  try {
    return c.json(readMemoryFile(filePath));
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to read memory file';
    const status = message.includes('not found') ? 404 : 400;
    return c.json({ error: message }, status);
  }
});

memoryRoutes.put('/file', authMiddleware, systemConfigMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const validation = MemoryFileSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }
  try {
    return c.json(
      writeMemoryFile(validation.data.path, validation.data.content),
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to write memory file';
    return c.json({ error: message }, 400);
  }
});

// Legacy API for old UI.
memoryRoutes.get('/global', authMiddleware, systemConfigMiddleware, (c) => {
  try {
    return c.json(readMemoryFile('groups/global/CLAUDE.md'));
  } catch (err) {
    logger.error({ err }, 'Failed to read global memory');
    return c.json({ error: 'Failed to read global memory' }, 500);
  }
});

memoryRoutes.put('/global', authMiddleware, systemConfigMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const validation = MemoryGlobalSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }
  if (
    Buffer.byteLength(validation.data.content, 'utf-8') >
    MAX_GLOBAL_MEMORY_LENGTH
  ) {
    return c.json({ error: 'Global memory is too large' }, 400);
  }

  try {
    return c.json(
      writeMemoryFile('groups/global/CLAUDE.md', validation.data.content),
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to write global memory';
    logger.error({ err }, 'Failed to write global memory');
    return c.json({ error: message }, 400);
  }
});

export default memoryRoutes;
