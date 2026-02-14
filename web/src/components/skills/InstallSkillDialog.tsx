import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface InstallSkillDialogProps {
  open: boolean;
  onClose: () => void;
  onInstall: (pkg: string) => Promise<void>;
  installing: boolean;
}

export function InstallSkillDialog({
  open,
  onClose,
  onInstall,
  installing,
}: InstallSkillDialogProps) {
  const [pkg, setPkg] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = pkg.trim();
    if (!trimmed) {
      setError('请输入技能包名称');
      return;
    }

    try {
      setError(null);
      await onInstall(trimmed);
      setPkg('');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '安装失败');
    }
  };

  const handleClose = () => {
    if (!installing) {
      setPkg('');
      setError(null);
      onClose();
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>安装技能</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="skill-pkg" className="block text-sm font-medium text-foreground mb-2">
              技能包名称
            </label>
            <Input
              id="skill-pkg"
              type="text"
              value={pkg}
              onChange={(e) => setPkg(e.target.value)}
              placeholder="owner/repo 或 owner/repo@skill"
              disabled={installing}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              支持格式：owner/repo 或 owner/repo@skill
            </p>
          </div>

          {error && (
            <div className="p-3 bg-error-bg border border-destructive/20 rounded-lg">
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={handleClose}
              disabled={installing}
            >
              取消
            </Button>
            <Button
              type="submit"
              disabled={installing || !pkg.trim()}
            >
              {installing && <Loader2 className="size-4 animate-spin" />}
              安装
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
