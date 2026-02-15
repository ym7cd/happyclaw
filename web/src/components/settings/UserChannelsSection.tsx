import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api } from '../../api/client';
import type { SettingsNotification } from './types';
import { getErrorMessage } from './types';

interface UserFeishuConfig {
  appId: string;
  hasAppSecret: boolean;
  appSecretMasked: string | null;
}

interface UserTelegramConfig {
  hasBotToken: boolean;
  botTokenMasked: string | null;
}

interface UserChannelsSectionProps extends SettingsNotification {}

export function UserChannelsSection({ setNotice, setError }: UserChannelsSectionProps) {
  // Feishu state
  const [feishuConfig, setFeishuConfig] = useState<UserFeishuConfig | null>(null);
  const [feishuAppId, setFeishuAppId] = useState('');
  const [feishuAppSecret, setFeishuAppSecret] = useState('');
  const [feishuLoading, setFeishuLoading] = useState(true);
  const [feishuSaving, setFeishuSaving] = useState(false);

  // Telegram state
  const [telegramConfig, setTelegramConfig] = useState<UserTelegramConfig | null>(null);
  const [telegramBotToken, setTelegramBotToken] = useState('');
  const [telegramLoading, setTelegramLoading] = useState(true);
  const [telegramSaving, setTelegramSaving] = useState(false);

  const loadFeishu = useCallback(async () => {
    setFeishuLoading(true);
    try {
      const data = await api.get<UserFeishuConfig>('/api/config/user-im/feishu');
      setFeishuConfig(data);
      setFeishuAppId(data.appId || '');
      setFeishuAppSecret('');
    } catch {
      // API may not exist yet; treat as unconfigured
      setFeishuConfig(null);
    } finally {
      setFeishuLoading(false);
    }
  }, []);

  const loadTelegram = useCallback(async () => {
    setTelegramLoading(true);
    try {
      const data = await api.get<UserTelegramConfig>('/api/config/user-im/telegram');
      setTelegramConfig(data);
      setTelegramBotToken('');
    } catch {
      setTelegramConfig(null);
    } finally {
      setTelegramLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFeishu();
    loadTelegram();
  }, [loadFeishu, loadTelegram]);

  const handleSaveFeishu = async () => {
    setFeishuSaving(true);
    setError(null);
    setNotice(null);
    try {
      const appId = feishuAppId.trim();
      const appSecret = feishuAppSecret.trim();

      // Validate: if App ID is provided, Secret must also be provided (for first-time setup)
      if (appId && !appSecret && !feishuConfig?.hasAppSecret) {
        setError('首次配置飞书需要同时提供 App ID 和 App Secret');
        setFeishuSaving(false);
        return;
      }

      // No-op when user leaves fields empty while existing config is present.
      if (!appId && !appSecret) {
        if (feishuConfig?.appId || feishuConfig?.hasAppSecret) {
          setNotice('飞书配置未变更');
        } else {
          setError('请填写飞书 App ID 和 App Secret');
        }
        setFeishuSaving(false);
        return;
      }

      const payload: Record<string, string | boolean> = { enabled: true };
      if (appId) payload.appId = appId;
      if (appSecret) payload.appSecret = appSecret;
      await api.put('/api/config/user-im/feishu', payload);
      setNotice('飞书配置已保存');
      await loadFeishu();
    } catch (err) {
      setError(getErrorMessage(err, '保存飞书配置失败'));
    } finally {
      setFeishuSaving(false);
    }
  };

  const handleSaveTelegram = async () => {
    setTelegramSaving(true);
    setError(null);
    setNotice(null);
    try {
      const token = telegramBotToken.trim();
      if (!token) {
        if (telegramConfig?.hasBotToken) {
          setNotice('Telegram 配置未变更');
        } else {
          setError('请输入 Telegram Bot Token');
        }
        setTelegramSaving(false);
        return;
      }

      await api.put('/api/config/user-im/telegram', {
        botToken: token,
        enabled: true,
      });
      setNotice('Telegram 配置已保存');
      await loadTelegram();
    } catch (err) {
      setError(getErrorMessage(err, '保存 Telegram 配置失败'));
    } finally {
      setTelegramSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Feishu */}
      <div>
        <h3 className="text-base font-semibold text-slate-900 mb-3">飞书</h3>
        {feishuLoading ? (
          <div className="text-sm text-slate-500">加载中...</div>
        ) : (
          <>
            {feishuConfig?.hasAppSecret && (
              <div className="text-xs text-slate-500 mb-2">
                当前 Secret: {feishuConfig.appSecretMasked || '已配置'}
              </div>
            )}
            <div className="grid md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-500 mb-1">App ID</label>
                <Input
                  type="text"
                  value={feishuAppId}
                  onChange={(e) => setFeishuAppId(e.target.value)}
                  placeholder="输入飞书 App ID"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">App Secret</label>
                <Input
                  type="password"
                  value={feishuAppSecret}
                  onChange={(e) => setFeishuAppSecret(e.target.value)}
                  placeholder={feishuConfig?.hasAppSecret ? '留空不修改' : '输入飞书 App Secret'}
                />
              </div>
            </div>
            <div className="mt-3">
              <Button onClick={handleSaveFeishu} disabled={feishuSaving}>
                {feishuSaving && <Loader2 className="size-4 animate-spin" />}
                保存飞书配置
              </Button>
            </div>
          </>
        )}
      </div>

      {/* Divider */}
      <div className="border-t border-slate-200" />

      {/* Telegram */}
      <div>
        <h3 className="text-base font-semibold text-slate-900 mb-3">Telegram</h3>
        {telegramLoading ? (
          <div className="text-sm text-slate-500">加载中...</div>
        ) : (
          <>
            {telegramConfig?.hasBotToken && (
              <div className="text-xs text-slate-500 mb-2">
                当前 Token: {telegramConfig.botTokenMasked || '已配置'}
              </div>
            )}
            <div>
              <label className="block text-xs text-slate-500 mb-1">Bot Token</label>
              <Input
                type="password"
                value={telegramBotToken}
                onChange={(e) => setTelegramBotToken(e.target.value)}
                placeholder={telegramConfig?.hasBotToken ? '留空不修改' : '输入 Telegram Bot Token'}
              />
            </div>
            <div className="mt-3">
              <Button onClick={handleSaveTelegram} disabled={telegramSaving}>
                {telegramSaving && <Loader2 className="size-4 animate-spin" />}
                保存 Telegram 配置
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
