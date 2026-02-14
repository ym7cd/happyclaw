import { create } from 'zustand';
import { api } from '../api/client';

export interface SystemStatus {
  activeContainers: number;
  activeHostProcesses?: number;
  activeTotal?: number;
  maxConcurrentContainers: number;
  maxConcurrentHostProcesses?: number;
  queueLength: number;
  uptime: number;
  dockerImageExists: boolean;
  groups: Array<{
    jid: string;
    active: boolean;
    pendingMessages: boolean;
    pendingTasks: number;
    containerName: string | null;
    displayName: string | null;
  }>;
}

interface MonitorState {
  status: SystemStatus | null;
  loading: boolean;
  error: string | null;
  building: boolean;
  buildResult: { success: boolean; error?: string; stdout?: string; stderr?: string } | null;
  loadStatus: () => Promise<void>;
  buildDockerImage: () => Promise<void>;
  clearBuildResult: () => void;
}

export const useMonitorStore = create<MonitorState>((set) => ({
  status: null,
  loading: false,
  error: null,
  building: false,
  buildResult: null,

  loadStatus: async () => {
    set({ loading: true });
    try {
      const status = await api.get<SystemStatus>('/api/status');
      set({ status, loading: false, error: null });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  buildDockerImage: async () => {
    set({ building: true, buildResult: null });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000); // 10 分钟超时
    try {
      const res = await fetch('/api/docker/build', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: controller.signal,
      });
      const result = await res.json();
      set({ building: false, buildResult: result });
    } catch (err) {
      set({
        building: false,
        buildResult: {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    } finally {
      clearTimeout(timeout);
    }
  },

  clearBuildResult: () => set({ buildResult: null }),
}));
