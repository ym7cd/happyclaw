import * as lark from '@larksuiteoapi/node-sdk';
import {
  setLastGroupSync,
  storeChatMetadata,
  storeMessageDirect,
  updateChatName,
} from './db.js';
import { logger } from './logger.js';
import { broadcastNewMessage } from './web.js';

// ─── FeishuConnection Interface ────────────────────────────────

export interface FeishuConnectionConfig {
  appId: string;
  appSecret: string;
}

export interface ConnectOptions {
  onReady: () => void;
  /** 收到消息后调用，让调用方自动注册未知的飞书聊天 */
  onNewChat?: (chatJid: string, chatName: string) => void;
  /** 热重连时设置：丢弃 create_time 早于此时间戳（epoch ms）的消息，避免处理渠道关闭期间的堆积消息 */
  ignoreMessagesBefore?: number;
}

export interface FeishuConnection {
  connect(opts: ConnectOptions): Promise<boolean>;
  stop(): Promise<void>;
  sendMessage(chatId: string, text: string): Promise<void>;
  sendReaction(chatId: string, isTyping: boolean): Promise<void>;
  isConnected(): boolean;
  syncGroups(): Promise<void>;
}

// ─── Shared Helpers (pure functions, no instance state) ────────

// Max characters per markdown element in Feishu cards
const CARD_MD_LIMIT = 4000;

/**
 * Extract message content from Feishu message.
 * Returns text content and optional image keys.
 */
function extractMessageContent(
  messageType: string,
  content: string,
): { text: string; imageKeys?: string[] } {
  try {
    const parsed = JSON.parse(content);

    if (messageType === 'text') {
      return { text: parsed.text || '' };
    }

    if (messageType === 'post') {
      // Recursively extract text from post content
      const lines: string[] = [];
      const post = parsed.post;
      if (!post) return { text: '' };

      // Try zh_cn first, then en_us, then other languages
      const contentData = post.zh_cn || post.en_us || Object.values(post)[0];
      if (!contentData || !Array.isArray(contentData.content)) return { text: '' };

      for (const paragraph of contentData.content) {
        if (!Array.isArray(paragraph)) continue;
        for (const segment of paragraph) {
          if (segment.tag === 'text' && segment.text) {
            lines.push(segment.text);
          }
        }
      }

      return { text: lines.join('\n') };
    }

    if (messageType === 'image') {
      const imageKey = parsed.image_key;
      if (imageKey) {
        return { text: '[图片]', imageKeys: [imageKey] };
      }
    }

    // Ignore other message types (file, audio, etc.)
    return { text: '' };
  } catch (err) {
    logger.warn(
      { err, messageType, content },
      'Failed to parse message content',
    );
    return { text: '' };
  }
}

/**
 * Split long text at paragraph boundaries to fit within card element limits.
 */
function splitAtParagraphs(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    // Prefer splitting at double newline (paragraph break)
    let idx = remaining.lastIndexOf('\n\n', maxLen);
    if (idx < maxLen * 0.3) {
      // Fallback to single newline
      idx = remaining.lastIndexOf('\n', maxLen);
    }
    if (idx < maxLen * 0.3) {
      // Hard split as last resort
      idx = maxLen;
    }
    chunks.push(remaining.slice(0, idx).trim());
    remaining = remaining.slice(idx).trim();
  }
  if (remaining) chunks.push(remaining);

  return chunks;
}

/**
 * Build a Feishu interactive card from markdown text.
 * Extracts headings as card title, splits content into visual sections.
 */
function buildInteractiveCard(text: string): object {
  const lines = text.split('\n');
  let title = '';
  let bodyStartIdx = 0;

  // Extract title from first heading if present
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if (/^#{1,3}\s+/.test(lines[i])) {
      title = lines[i].replace(/^#+\s*/, '').trim();
      bodyStartIdx = i + 1;
    }
    break;
  }

  const body = lines.slice(bodyStartIdx).join('\n').trim();

  // Generate title if no heading found — use first line preview
  if (!title) {
    const firstLine = (lines.find((l) => l.trim()) || '')
      .replace(/[*_`#\[\]]/g, '')
      .trim();
    title =
      firstLine.length > 40
        ? firstLine.slice(0, 37) + '...'
        : firstLine || 'Reply';
  }

  // Build card elements
  const elements: Array<Record<string, unknown>> = [];
  const contentToRender = body || text.trim();

  if (contentToRender.length > CARD_MD_LIMIT) {
    // Long content: split into multiple markdown elements
    const chunks = splitAtParagraphs(contentToRender, CARD_MD_LIMIT);
    for (const chunk of chunks) {
      elements.push({ tag: 'markdown', content: chunk });
    }
  } else if (contentToRender) {
    // Split by horizontal rules for visual sections
    const sections = contentToRender.split(/\n-{3,}\n/);
    for (let i = 0; i < sections.length; i++) {
      if (i > 0) elements.push({ tag: 'hr' });
      const s = sections[i].trim();
      if (s) elements.push({ tag: 'markdown', content: s });
    }
  }

  // Ensure at least one element
  if (elements.length === 0) {
    elements.push({ tag: 'markdown', content: text.trim() });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template: 'indigo',
    },
    elements,
  };
}

// ─── Factory Function ──────────────────────────────────────────

/**
 * Create an independent Feishu connection instance.
 * Each instance manages its own client, WebSocket, and state maps.
 */
export function createFeishuConnection(config: FeishuConnectionConfig): FeishuConnection {
  // LRU deduplication cache
  const MSG_DEDUP_MAX = 1000;
  const MSG_DEDUP_TTL = 30 * 60 * 1000; // 30min

  // Per-instance state
  const msgCache = new Map<string, number>();
  const senderNameCache = new Map<string, string>();
  const lastMessageIdByChat = new Map<string, string>();
  const ackReactionByChat = new Map<string, string>();
  const typingReactionByChat = new Map<string, string>();

  let client: lark.Client | null = null;
  let wsClient: lark.WSClient | null = null;

  function isDuplicate(msgId: string): boolean {
    const now = Date.now();
    for (const [id, ts] of msgCache.entries()) {
      if (now - ts > MSG_DEDUP_TTL) {
        msgCache.delete(id);
      }
    }
    if (msgCache.size >= MSG_DEDUP_MAX) {
      const firstKey = msgCache.keys().next().value;
      if (firstKey) msgCache.delete(firstKey);
    }
    return msgCache.has(msgId);
  }

  function markSeen(msgId: string): void {
    msgCache.delete(msgId);
    msgCache.set(msgId, Date.now());
  }

  async function downloadFeishuImage(
    messageId: string,
    fileKey: string,
  ): Promise<string | null> {
    try {
      const res = await client!.im.messageResource.get({
        path: {
          message_id: messageId,
          file_key: fileKey,
        },
        params: {
          type: 'image',
        },
      });

      const stream = res.getReadableStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const buffer = Buffer.concat(chunks);
      if (buffer.length === 0) {
        logger.warn({ messageId, fileKey }, 'Empty response from image download');
        return null;
      }

      return buffer.toString('base64');
    } catch (err) {
      logger.warn({ err, messageId, fileKey }, 'Failed to download Feishu image');
      return null;
    }
  }

  function getSenderName(openId: string): string {
    return senderNameCache.get(openId) || openId;
  }

  async function addReaction(
    messageId: string,
    emojiType: string,
  ): Promise<string | null> {
    try {
      const res = (await client!.im.messageReaction.create({
        path: { message_id: messageId },
        data: {
          reaction_type: { emoji_type: emojiType },
        },
      })) as { data?: { reaction_id?: string } };
      return res.data?.reaction_id || null;
    } catch (err) {
      logger.debug({ err, messageId, emojiType }, 'Failed to add reaction');
      return null;
    }
  }

  async function removeReaction(
    messageId: string,
    reactionId: string,
  ): Promise<void> {
    try {
      await client!.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    } catch (err) {
      logger.debug({ err, messageId, reactionId }, 'Failed to remove reaction');
    }
  }

  const connection: FeishuConnection = {
    async connect(opts: ConnectOptions): Promise<boolean> {
      const { onReady, onNewChat, ignoreMessagesBefore } = opts;

      if (!config.appId || !config.appSecret) {
        logger.warn(
          'Feishu config is empty, running in Web-only mode',
        );
        return false;
      }

      // Initialize client
      client = new lark.Client({
        appId: config.appId,
        appSecret: config.appSecret,
        appType: lark.AppType.SelfBuild,
      });

      // Create event dispatcher
      const eventDispatcher = new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data) => {
          try {
            const message = data.message;
            const chatId = message.chat_id;
            const messageId = message.message_id;

            // Deduplication check
            if (isDuplicate(messageId)) {
              logger.debug({ messageId }, 'Duplicate message, skipping');
              return;
            }
            markSeen(messageId);

            // Skip stale messages from before reconnection (hot-reload scenario)
            if (ignoreMessagesBefore) {
              const createTimeMs = parseInt(message.create_time);
              if (createTimeMs < ignoreMessagesBefore) {
                logger.info(
                  { messageId, createTime: createTimeMs, threshold: ignoreMessagesBefore },
                  'Skipping stale Feishu message from before reconnection',
                );
                return;
              }
            }

            // Extract message text and image keys
            const extracted = extractMessageContent(message.message_type, message.content);
            let content = extracted.text;
            if (!content && !extracted.imageKeys) {
              logger.debug(
                { messageId, messageType: message.message_type },
                'No text or image content, skipping',
              );
              return;
            }

            // Handle @bot mentions - replace Feishu placeholder with actual names
            if (message.mentions && Array.isArray(message.mentions)) {
              for (const mention of message.mentions) {
                if (mention.key) {
                  content = content.replace(mention.key, `@${mention.name || ''}`);
                }
              }
            }

            // Download images if present
            let attachmentsJson: string | undefined;
            if (extracted.imageKeys && extracted.imageKeys.length > 0) {
              const attachments = [];
              for (const imageKey of extracted.imageKeys) {
                const base64Data = await downloadFeishuImage(messageId, imageKey);
                if (base64Data) {
                  attachments.push({
                    type: 'image',
                    data: base64Data,
                    mimeType: 'image/png',
                  });
                }
              }
              if (attachments.length > 0) {
                attachmentsJson = JSON.stringify(attachments);
              }
            }

            // Acknowledge receipt with "OnIt" reaction (will be removed after reply)
            addReaction(messageId, 'OnIt')
              .then((reactionId) => {
                if (reactionId) {
                  ackReactionByChat.set(chatId, `${messageId}:${reactionId}`);
                }
              })
              .catch(() => {});

            // Track last message_id for this chat (used for reply-to and typing)
            lastMessageIdByChat.set(chatId, messageId);

            // Get sender name
            const senderName = getSenderName(data.sender.sender_id?.open_id || '');

            // JID format
            const chatJid = `feishu:${chatId}`;
            const timestamp = new Date(parseInt(message.create_time)).toISOString();

            // 通知调用方：如果该飞书聊天未注册，自动注册
            const chatName = message.chat_type === 'p2p' ? `飞书私聊` : `飞书群聊`;
            onNewChat?.(chatJid, chatName);

            // Store to database
            storeChatMetadata(chatJid, timestamp);
            storeMessageDirect(
              messageId,
              chatJid,
              data.sender.sender_id?.open_id || '',
              senderName,
              content,
              timestamp,
              false,
              attachmentsJson,
            );

            // Broadcast to Web clients
            broadcastNewMessage(chatJid, {
              id: messageId,
              chat_jid: chatJid,
              sender: data.sender.sender_id?.open_id || '',
              sender_name: senderName,
              content,
              timestamp,
              attachments: attachmentsJson,
            });

            logger.info(
              { chatJid, sender: senderName, messageId },
              'Feishu message stored',
            );
          } catch (err) {
            logger.error({ err }, 'Error handling Feishu message');
          }
        },
      });

      // Initialize WebSocket client
      wsClient = new lark.WSClient({
        appId: config.appId,
        appSecret: config.appSecret,
        loggerLevel: lark.LoggerLevel.info,
      });

      try {
        await wsClient.start({ eventDispatcher });
        logger.info('Feishu WebSocket client started');
        onReady();
        return true;
      } catch (err) {
        logger.error(
          { err },
          'Failed to start Feishu client, running in Web-only mode',
        );
        // Clean up partially initialized state
        client = null;
        wsClient = null;
        return false;
      }
    },

    async stop(): Promise<void> {
      if (wsClient) {
        logger.info('Stopping Feishu client');
        try {
          await wsClient.close();
          logger.info('Feishu client stopped successfully');
        } catch (err) {
          logger.warn({ err }, 'Error stopping Feishu client');
        }
        wsClient = null;
      }
      client = null;
    },

    async sendMessage(chatId: string, text: string): Promise<void> {
      if (!client) {
        logger.warn(
          { chatId },
          'Feishu client not initialized, skip sending message',
        );
        return;
      }

      const clearAckReaction = () => {
        const ackStored = ackReactionByChat.get(chatId);
        if (ackStored) {
          const [ackMsgId, ackReactionId] = ackStored.split(':');
          removeReaction(ackMsgId, ackReactionId).catch(() => {});
          ackReactionByChat.delete(chatId);
        }
      };

      try {
        const card = buildInteractiveCard(text);
        const content = JSON.stringify(card);

        const lastMsgId = lastMessageIdByChat.get(chatId);
        if (lastMsgId) {
          try {
            await client.im.message.reply({
              path: { message_id: lastMsgId },
              data: { content, msg_type: 'interactive' },
            });
          } catch (err) {
            logger.warn(
              { err, chatId },
              'Feishu interactive reply failed, fallback to plain text',
            );
            await client.im.message.reply({
              path: { message_id: lastMsgId },
              data: {
                content: JSON.stringify({ text }),
                msg_type: 'text',
              },
            });
          }
        } else {
          try {
            await client.im.v1.message.create({
              params: { receive_id_type: 'chat_id' },
              data: {
                receive_id: chatId,
                msg_type: 'interactive',
                content,
              },
            });
          } catch (err) {
            logger.warn(
              { err, chatId },
              'Feishu interactive create failed, fallback to plain text',
            );
            await client.im.v1.message.create({
              params: { receive_id_type: 'chat_id' },
              data: {
                receive_id: chatId,
                msg_type: 'text',
                content: JSON.stringify({ text }),
              },
            });
          }
        }
        logger.debug({ chatId }, 'Sent Feishu card message');
        clearAckReaction();
      } catch (err) {
        logger.error({ err, chatId }, 'Failed to send Feishu card message');
        clearAckReaction();
      }
    },

    async sendReaction(chatId: string, isTyping: boolean): Promise<void> {
      if (!client) return;
      const lastMsgId = lastMessageIdByChat.get(chatId);
      if (!lastMsgId) return;

      if (isTyping) {
        const reactionId = await addReaction(lastMsgId, 'OnIt');
        if (reactionId) {
          typingReactionByChat.set(chatId, `${lastMsgId}:${reactionId}`);
        }
      } else {
        const stored = typingReactionByChat.get(chatId);
        if (stored) {
          const [msgId, reactionId] = stored.split(':');
          await removeReaction(msgId, reactionId);
          typingReactionByChat.delete(chatId);
        }
      }
    },

    isConnected(): boolean {
      return wsClient != null;
    },

    async syncGroups(): Promise<void> {
      if (!client) {
        logger.debug('Feishu client not initialized, skip group sync');
        return;
      }
      try {
        let pageToken: string | undefined;
        let hasMore = true;

        while (hasMore) {
          const res = await client.im.v1.chat.list({
            params: {
              page_size: 100,
              page_token: pageToken,
            },
          });

          const items = res.data?.items || [];
          for (const chat of items) {
            if (chat.chat_id && chat.name) {
              updateChatName(`feishu:${chat.chat_id}`, chat.name);
            }
          }

          hasMore = res.data?.has_more || false;
          pageToken = res.data?.page_token;
        }

        setLastGroupSync();
        logger.info('Feishu group sync completed');
      } catch (err) {
        logger.error({ err }, 'Failed to sync Feishu groups');
      }
    },
  };

  return connection;
}

// ─── Backward-compatible global singleton ──────────────────────
// @deprecated — 旧的顶层导出函数，内部使用一个默认全局实例。
// 后续由 imManager 替代。

let _defaultInstance: FeishuConnection | null = null;

export interface ConnectFeishuOptions {
  onReady: () => void;
  /** 收到消息后调用，让主模块自动注册未知的飞书聊天到主容器 */
  onNewChat?: (chatJid: string, chatName: string) => void;
  /** 热重连时设置：丢弃 create_time 早于此时间戳（epoch ms）的消息，避免处理渠道关闭期间的堆积消息 */
  ignoreMessagesBefore?: number;
}

/**
 * @deprecated Use createFeishuConnection() factory instead. Will be replaced by imManager.
 * Connect to Feishu via WebSocket and start receiving messages.
 */
export async function connectFeishu(opts: ConnectFeishuOptions): Promise<boolean> {
  const { getFeishuProviderConfigWithSource } = await import('./runtime-config.js');
  const { config, source } = getFeishuProviderConfigWithSource();
  if (!config.appId || !config.appSecret) {
    logger.warn(
      { source },
      'Feishu config is empty, running in Web-only mode (set it in Settings -> Feishu config)',
    );
    return false;
  }

  _defaultInstance = createFeishuConnection({
    appId: config.appId,
    appSecret: config.appSecret,
  });

  return _defaultInstance.connect(opts);
}

/**
 * @deprecated Use FeishuConnection.sendMessage() instead.
 */
export async function sendFeishuMessage(
  chatId: string,
  text: string,
): Promise<void> {
  if (!_defaultInstance) {
    logger.warn(
      { chatId },
      'Feishu client not initialized, skip sending message',
    );
    return;
  }
  return _defaultInstance.sendMessage(chatId, text);
}

/**
 * @deprecated Use FeishuConnection.sendReaction() instead.
 */
export async function setFeishuTyping(
  chatId: string,
  isTyping: boolean,
): Promise<void> {
  if (!_defaultInstance) return;
  return _defaultInstance.sendReaction(chatId, isTyping);
}

/**
 * @deprecated Use FeishuConnection.syncGroups() instead.
 */
export async function syncFeishuGroups(): Promise<void> {
  if (!_defaultInstance) {
    logger.debug('Feishu client not initialized, skip group sync');
    return;
  }
  return _defaultInstance.syncGroups();
}

/**
 * @deprecated Use FeishuConnection.isConnected() instead.
 */
export function isFeishuConnected(): boolean {
  return _defaultInstance?.isConnected() ?? false;
}

/**
 * @deprecated Use FeishuConnection.stop() instead.
 */
export async function stopFeishu(): Promise<void> {
  if (_defaultInstance) {
    await _defaultInstance.stop();
    _defaultInstance = null;
  }
}
