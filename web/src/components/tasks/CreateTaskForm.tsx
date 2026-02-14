import { useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

interface Group {
  jid: string;
  name: string;
  folder: string;
}

interface CreateTaskFormProps {
  groups: Group[];
  onSubmit: (data: {
    groupFolder: string;
    chatJid: string;
    prompt: string;
    scheduleType: 'cron' | 'interval' | 'once';
    scheduleValue: string;
    contextMode: 'group' | 'isolated';
  }) => Promise<void>;
  onClose: () => void;
}

export function CreateTaskForm({ groups, onSubmit, onClose }: CreateTaskFormProps) {
  const [formData, setFormData] = useState({
    groupFolder: '',
    chatJid: '',
    prompt: '',
    scheduleType: 'cron' as 'cron' | 'interval' | 'once',
    scheduleValue: '',
    contextMode: 'isolated' as 'group' | 'isolated',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const validateForm = () => {
    const newErrors: Record<string, string> = {};

    if (!formData.groupFolder) {
      newErrors.groupFolder = '请选择群组';
    }

    if (!formData.prompt.trim()) {
      newErrors.prompt = '请输入 Prompt';
    }

    if (!formData.scheduleValue.trim()) {
      newErrors.scheduleValue = '请输入调度值';
    } else {
      // Basic validation for schedule value
      if (formData.scheduleType === 'cron') {
        const parts = formData.scheduleValue.trim().split(' ');
        if (parts.length < 5) {
          newErrors.scheduleValue = 'Cron 表达式格式错误（至少需要 5 个字段）';
        }
      } else if (formData.scheduleType === 'interval') {
        const num = parseInt(formData.scheduleValue);
        if (isNaN(num) || num <= 0) {
          newErrors.scheduleValue = '间隔必须是正整数（单位：毫秒）';
        }
      } else if (formData.scheduleType === 'once') {
        const value = formData.scheduleValue.trim();
        let date: Date;
        if (/^\d+$/.test(value)) {
          date = new Date(Number.parseInt(value, 10));
        } else {
          date = new Date(value);
        }
        if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
          newErrors.scheduleValue = '请输入未来时间（ISO 时间或毫秒时间戳）';
        }
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateForm()) return;

    setSubmitting(true);
    try {
      await onSubmit(formData);
    } catch (error) {
      console.error('Failed to create task:', error);
    } finally {
      setSubmitting(false);
    }
  };

  const handleGroupChange = (value: string) => {
    const selectedGroup = groups.find((g) => g.folder === value);
    setFormData({
      ...formData,
      groupFolder: value,
      chatJid: selectedGroup?.jid || '',
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-slate-200">
          <h2 className="text-xl font-bold text-slate-900">创建定时任务</h2>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* Group Selection */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              选择群组 <span className="text-red-500">*</span>
            </label>
            <Select value={formData.groupFolder || undefined} onValueChange={handleGroupChange}>
              <SelectTrigger className={cn("w-full", errors.groupFolder && "border-red-500")}>
                <SelectValue placeholder="请选择" />
              </SelectTrigger>
              <SelectContent>
                {groups.map((group) => (
                  <SelectItem key={group.jid} value={group.folder}>
                    {group.name} ({group.folder})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.groupFolder && (
              <p className="mt-1 text-sm text-red-600">{errors.groupFolder}</p>
            )}
          </div>

          {/* Prompt */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              任务 Prompt <span className="text-red-500">*</span>
            </label>
            <Textarea
              value={formData.prompt}
              onChange={(e) => setFormData({ ...formData, prompt: e.target.value })}
              rows={4}
              className={cn("resize-none", errors.prompt && "border-red-500")}
              placeholder="输入任务的提示词..."
            />
            {errors.prompt && (
              <p className="mt-1 text-sm text-red-600">{errors.prompt}</p>
            )}
          </div>

          {/* Schedule Type */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              调度类型 <span className="text-red-500">*</span>
            </label>
            <Select
              value={formData.scheduleType}
              onValueChange={(value) =>
                setFormData({
                  ...formData,
                  scheduleType: value as 'cron' | 'interval' | 'once',
                  scheduleValue: '',
                })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cron">Cron 表达式</SelectItem>
                <SelectItem value="interval">间隔执行</SelectItem>
                <SelectItem value="once">单次执行</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Schedule Value */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              调度值 <span className="text-red-500">*</span>
            </label>
            <Input
              type="text"
              value={formData.scheduleValue}
              onChange={(e) =>
                setFormData({ ...formData, scheduleValue: e.target.value })
              }
              className={cn(errors.scheduleValue && "border-red-500")}
              placeholder={
                formData.scheduleType === 'cron'
                  ? '例如: 0 0 * * * (每天 0 点)'
                  : formData.scheduleType === 'interval'
                  ? '例如: 3600000 (每小时，单位：毫秒)'
                  : '例如: 2026-02-10T21:30:00+08:00 或 1760000000000'
              }
            />
            {errors.scheduleValue && (
              <p className="mt-1 text-sm text-red-600">{errors.scheduleValue}</p>
            )}
            <p className="mt-1 text-xs text-slate-500">
              {formData.scheduleType === 'cron' &&
                'Cron 表达式格式: 秒 分 时 日 月 星期'}
              {formData.scheduleType === 'interval' && '单位：毫秒'}
              {formData.scheduleType === 'once' && '支持 ISO 时间字符串或 Unix 毫秒时间戳'}
            </p>
          </div>

          {/* Context Mode */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              上下文模式
            </label>
            <Select
              value={formData.contextMode}
              onValueChange={(value) =>
                setFormData({
                  ...formData,
                  contextMode: value as 'group' | 'isolated',
                })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="isolated">独立执行（推荐）</SelectItem>
                <SelectItem value="group">共享群组上下文</SelectItem>
              </SelectContent>
            </Select>
            <p className="mt-1 text-xs text-slate-500">
              共享群组上下文会复用该群组会话，独立执行每次使用隔离会话
            </p>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-200">
            <Button type="button" variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting && <Loader2 className="size-4 animate-spin" />}
              {submitting ? '创建中...' : '创建任务'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
