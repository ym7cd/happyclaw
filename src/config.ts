import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'HappyClaw';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();

// Mount security: allowlist in project config/ directory
export const MOUNT_ALLOWLIST_PATH = path.resolve(
  PROJECT_ROOT,
  'config',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'happyclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = 20;
export const MAX_CONCURRENT_HOST_PROCESSES = parseInt(
  process.env.MAX_CONCURRENT_HOST_PROCESSES || '5',
  10,
); // 宿主机模式并发限制（更严格）

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Feishu (Lark) configuration
export const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
export const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';

// Telegram configuration
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

// Web server configuration
export const WEB_PORT = parseInt(process.env.WEB_PORT || '3000', 10);
export const WEB_USERNAME = process.env.WEB_USERNAME || 'admin';
export const WEB_PASSWORD = process.env.WEB_PASSWORD || '';
const SESSION_SECRET_FILE = path.resolve(
  process.cwd(),
  'data',
  'config',
  'session-secret.key',
);

function getOrCreateSessionSecret(): string {
  // 1. Environment variable (highest priority — allows container/operator override)
  if (process.env.WEB_SESSION_SECRET) {
    return process.env.WEB_SESSION_SECRET;
  }

  // 2. File-persisted secret (survives restarts without .env)
  try {
    if (fs.existsSync(SESSION_SECRET_FILE)) {
      const stored = fs.readFileSync(SESSION_SECRET_FILE, 'utf-8').trim();
      if (stored) return stored;
    }
  } catch {
    // ignore read errors, fall through
  }

  // 3. Generate and persist
  const generated = crypto.randomUUID();
  try {
    fs.mkdirSync(path.dirname(SESSION_SECRET_FILE), { recursive: true });
    fs.writeFileSync(SESSION_SECRET_FILE, generated + '\n', { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // non-fatal: secret works for this process, just won't survive restart
  }
  return generated;
}

export const WEB_SESSION_SECRET = getOrCreateSessionSecret();

// Login rate limiting
const _maxAttempts = parseInt(process.env.MAX_LOGIN_ATTEMPTS || '5', 10);
export const MAX_LOGIN_ATTEMPTS = Number.isFinite(_maxAttempts)
  ? _maxAttempts
  : 5;
const _lockoutMin = parseInt(process.env.LOGIN_LOCKOUT_MINUTES || '15', 10);
export const LOGIN_LOCKOUT_MINUTES = Number.isFinite(_lockoutMin)
  ? _lockoutMin
  : 15;

/**
 * Call at startup to validate required config. Exits if invalid.
 * Admin creation is handled via the web setup wizard (POST /api/auth/setup).
 */
export function validateConfig(): void {
  // No-op: admin setup handled via web wizard.
}
