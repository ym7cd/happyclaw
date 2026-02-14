import type { Permission } from '../../stores/auth';

export function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.trim()) return msg;
  }
  return fallback;
}

export function samePermissions(left: Permission[], right: Permission[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, idx) => value === b[idx]);
}

export const PERMISSION_LABELS: Record<Permission, string> = {
  manage_system_config: '系统配置管理',
  manage_group_env: '容器环境管理',
  manage_users: '用户管理',
  manage_invites: '邀请码管理',
  view_audit_log: '查看审计日志',
};

export interface TabNotification {
  setNotice: (value: string | null) => void;
  setError: (value: string | null) => void;
}
