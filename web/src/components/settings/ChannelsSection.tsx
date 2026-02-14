import type { SettingsNotification } from './types';
import { FeishuConfigForm } from './FeishuConfigForm';
import { TelegramConfigForm } from './TelegramConfigForm';

interface ChannelsSectionProps extends SettingsNotification {}

export function ChannelsSection({ setNotice, setError }: ChannelsSectionProps) {
  return (
    <div className="space-y-6">
      <FeishuConfigForm setNotice={setNotice} setError={setError} />
      <TelegramConfigForm setNotice={setNotice} setError={setError} />
    </div>
  );
}
