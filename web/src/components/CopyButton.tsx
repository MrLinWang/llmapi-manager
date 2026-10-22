import { useState } from 'react';
import { Icon } from './ui';

export function CopyButton({ value, label = '复制' }: { value: string; label?: string }): JSX.Element {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button type="button" className="btn-outline btn-sm shrink-0" onClick={() => void copy()}>
      <Icon name={copied ? 'check' : 'copy'} className="size-3.5" />
      {copied ? '已复制' : label}
    </button>
  );
}
