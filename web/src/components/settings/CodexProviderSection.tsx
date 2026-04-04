import { useCallback, useEffect, useState } from 'react';
import {
  FileJson,
  FolderCog,
  KeyRound,
  Loader2,
  Save,
  ShieldCheck,
  Trash2,
} from 'lucide-react';

import { api } from '../../api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { CodexConfigPublic } from './types';
import { getErrorMessage } from './types';

interface CodexProviderSectionProps {
  setNotice: (msg: string | null) => void;
  setError: (msg: string | null) => void;
}

function sourceLabel(source: CodexConfigPublic['source']): string {
  switch (source) {
    case 'runtime':
      return '受管配置';
    case 'env':
      return '环境变量';
    case 'home':
      return '用户目录';
    default:
      return '未配置';
  }
}

export function CodexProviderSection({
  setNotice,
  setError,
}: CodexProviderSectionProps) {
  const [config, setConfig] = useState<CodexConfigPublic | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [authJson, setAuthJson] = useState('');
  const [configToml, setConfigToml] = useState('');
  const [openaiApiKey, setOpenaiApiKey] = useState('');

  const loadConfig = useCallback(async () => {
    try {
      const data = await api.get<CodexConfigPublic>('/api/config/codex');
      setConfig(data);
    } catch (err) {
      setError(getErrorMessage(err, '加载 Codex 配置失败'));
    } finally {
      setLoading(false);
    }
  }, [setError]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const handleSave = useCallback(async () => {
    const body: Record<string, string> = {};
    if (authJson.trim()) body.authJson = authJson;
    if (configToml.trim()) body.configToml = configToml;
    if (openaiApiKey.trim()) body.openaiApiKey = openaiApiKey.trim();

    if (Object.keys(body).length === 0) {
      setError('请至少填写一项 Codex 配置后再保存');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const saved = await api.put<CodexConfigPublic>('/api/config/codex', body);
      setConfig(saved);
      setAuthJson('');
      setConfigToml('');
      setOpenaiApiKey('');
      setNotice('Codex 配置已保存');
    } catch (err) {
      setError(getErrorMessage(err, '保存 Codex 配置失败'));
    } finally {
      setSaving(false);
    }
  }, [authJson, configToml, openaiApiKey, setError, setNotice]);

  const handleClearManagedConfig = useCallback(async () => {
    setClearing(true);
    setError(null);
    try {
      const cleared = await api.put<CodexConfigPublic>('/api/config/codex', {
        clearAuthJson: true,
        clearConfigToml: true,
        clearOpenaiApiKey: true,
      });
      setConfig(cleared);
      setAuthJson('');
      setConfigToml('');
      setOpenaiApiKey('');
      setNotice('Codex 受管配置已清空');
    } catch (err) {
      setError(getErrorMessage(err, '清空 Codex 配置失败'));
    } finally {
      setClearing(false);
    }
  }, [setError, setNotice]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const busy = saving || clearing;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border px-4 py-3 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">Codex 运行时来源</span>
          <span className="inline-flex items-center rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-primary">
            {sourceLabel(config?.source || 'none')}
          </span>
          {config?.updatedAt && (
            <span className="text-xs text-muted-foreground">
              最近更新：{new Date(config.updatedAt).toLocaleString('zh-CN')}
            </span>
          )}
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-lg border border-border/80 bg-card px-3 py-3">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <FileJson className="w-4 h-4 text-muted-foreground" />
              auth.json
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {config?.hasAuthJson ? '已保存或可读取' : '未检测到'}
            </div>
          </div>
          <div className="rounded-lg border border-border/80 bg-card px-3 py-3">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <FolderCog className="w-4 h-4 text-muted-foreground" />
              config.toml
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {config?.hasConfigToml ? '已保存或可读取' : '未检测到'}
            </div>
          </div>
          <div className="rounded-lg border border-border/80 bg-card px-3 py-3">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <KeyRound className="w-4 h-4 text-muted-foreground" />
              OPENAI_API_KEY
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {config?.hasOpenaiApiKey
                ? `已保存 ${config.openaiApiKeyMasked || ''}`
                : '未保存'}
            </div>
          </div>
        </div>
        <div className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-2 text-foreground">
            <ShieldCheck className="w-4 h-4 text-muted-foreground" />
            有效 home
          </div>
          <div className="mt-1 font-mono break-all">{config?.homePath || '-'}</div>
          <div className="mt-2">
            显式设置 `CODEX_HOME` 时优先使用外部目录；否则优先使用这里保存的受管配置，再回退到当前用户的 `~/.codex`。
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border px-4 py-4 space-y-4">
        <div>
          <h3 className="text-sm font-medium text-foreground">更新 Codex 凭证</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            为了避免把敏感内容回显到前端，已保存的 `auth.json` / `config.toml` 不会原样返回。这里只接受覆盖式更新。
          </p>
        </div>

        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">
            auth.json
          </label>
          <Textarea
            value={authJson}
            onChange={(e) => setAuthJson(e.target.value)}
            placeholder='粘贴 Codex CLI 的 auth.json 内容，例如 {"OPENAI_API_KEY":"..."}'
            className="min-h-32 font-mono text-xs"
          />
        </div>

        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">
            config.toml
          </label>
          <Textarea
            value={configToml}
            onChange={(e) => setConfigToml(e.target.value)}
            placeholder={'model = "gpt-5"\napproval_policy = "never"'}
            className="min-h-28 font-mono text-xs"
          />
        </div>

        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">
            OPENAI_API_KEY
          </label>
          <Input
            type="password"
            value={openaiApiKey}
            onChange={(e) => setOpenaiApiKey(e.target.value)}
            placeholder="可选。用于补齐某些 Codex CLI 场景对环境变量的要求"
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={handleSave} disabled={busy}>
            {saving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            保存 Codex 配置
          </Button>
          <Button
            variant="outline"
            onClick={handleClearManagedConfig}
            disabled={busy}
          >
            {clearing ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Trash2 className="w-4 h-4" />
            )}
            清空受管配置
          </Button>
        </div>
      </div>
    </div>
  );
}
