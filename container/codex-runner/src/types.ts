export type StreamEventType =
  | 'text_delta'
  | 'thinking_delta'
  | 'tool_use_start'
  | 'tool_use_end'
  | 'tool_progress'
  | 'status';

export interface StreamEvent {
  eventType: StreamEventType;
  turnId?: string;
  sessionId?: string;
  isSynthetic?: boolean;
  text?: string;
  statusText?: string;
  toolName?: string;
  toolUseId?: string;
  parentToolUseId?: string | null;
  toolInputSummary?: string;
  elapsedSeconds?: number;
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  turnId?: string;
  groupFolder: string;
  chatJid: string;
  isMain?: boolean;
  isHome?: boolean;
  isAdminHome?: boolean;
  isScheduledTask?: boolean;
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
  sourceKind?:
    | 'sdk_final'
    | 'sdk_send_message'
    | 'interrupt_partial'
    | 'overflow_partial'
    | 'compact_partial'
    | 'legacy'
    | 'auto_continue';
  finalizationReason?: 'completed' | 'interrupted' | 'error';
}
