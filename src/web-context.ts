// Shared state and utilities for web server

import { WebSocket } from 'ws';
import { RegisteredGroup } from './types.js';
import { GroupQueue } from './group-queue.js';
import type { AuthUser, NewMessage, MessageCursor } from './types.js';

export interface WebDeps {
  queue: GroupQueue;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  processGroupMessages: (chatJid: string) => Promise<boolean>;
  ensureTerminalContainerStarted: (chatJid: string) => boolean;
  formatMessages: (messages: NewMessage[]) => string;
  getLastAgentTimestamp: () => Record<string, MessageCursor>;
  setLastAgentTimestamp: (jid: string, cursor: MessageCursor) => void;
  advanceGlobalCursor: (cursor: MessageCursor) => void;
  reloadFeishuConnection?: (config: { appId: string; appSecret: string; enabled?: boolean }) => Promise<boolean>;
  reloadTelegramConnection?: (config: { botToken: string; enabled?: boolean }) => Promise<boolean>;
  isFeishuConnected?: () => boolean;
  isTelegramConnected?: () => boolean;
}

export type Variables = {
  user: AuthUser;
  sessionId: string;
};

let deps: WebDeps | null = null;
export const wsClients = new Map<WebSocket, string>();
export const MAX_GROUP_NAME_LEN = 40;

export function setWebDeps(d: WebDeps): void {
  deps = d;
}
export function getWebDeps(): WebDeps | null {
  return deps;
}

// lastActiveCache - 5 min debounce for session activity tracking
export const lastActiveCache = new Map<string, number>();
export const LAST_ACTIVE_DEBOUNCE_MS = 5 * 60 * 1000;
const LAST_ACTIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const lastActiveCleanupTimer = setInterval(() => {
  const cutoff = Date.now() - LAST_ACTIVE_CACHE_TTL_MS;
  for (const [sessionId, touchedAt] of lastActiveCache.entries()) {
    if (touchedAt < cutoff) lastActiveCache.delete(sessionId);
  }
}, 60 * 60 * 1000);
lastActiveCleanupTimer.unref?.();

// Cookie parser - used by middleware and WebSocket
export function parseCookie(
  cookieHeader: string | undefined,
): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const cookie of cookieHeader.split(';')) {
    const pair = cookie.trim();
    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) continue;
    const key = pair.slice(0, eqIndex).trim();
    const value = pair.slice(eqIndex + 1).trim();
    if (key) cookies[key] = value;
  }
  return cookies;
}

// Host execution helpers
export function isHostExecutionGroup(group: RegisteredGroup): boolean {
  return (group.executionMode || 'container') === 'host';
}

export function hasHostExecutionPermission(user: AuthUser): boolean {
  return user.role === 'admin';
}
