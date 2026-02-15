export interface GroupInfo {
  name: string;
  folder: string;
  added_at: string;
  kind?: 'main' | 'feishu' | 'web';
  editable?: boolean;
  deletable?: boolean;
  lastMessage?: string;
  lastMessageTime?: string;
  execution_mode?: 'container' | 'host';
  custom_cwd?: string;
  created_by?: string;
}
