import { create } from 'zustand';
import { api } from '../api/client';

export interface GroupInfo {
  name: string;
  folder: string;
  added_at: string;
  lastMessage?: string;
  lastMessageTime?: string;
}

interface GroupsState {
  groups: Record<string, GroupInfo>;
  loading: boolean;
  error: string | null;
  loadGroups: () => Promise<void>;
}

export const useGroupsStore = create<GroupsState>((set) => ({
  groups: {},
  loading: false,
  error: null,

  loadGroups: async () => {
    set({ loading: true });
    try {
      const data = await api.get<{ groups: Record<string, GroupInfo> }>('/api/groups');
      set({ groups: data.groups, loading: false, error: null });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },
}));
