import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './ui';

/**
 * 复制按钮。
 *
 * `label` 由调用方传入（"复制网关地址"之类的具体说法），默认取通用「复制」；
 * 「已复制」是自身状态文案，始终走字典。
 */
export function CopyButton({ value, label }: { value: string; label?: string }): JSX.Element {
  const { t } = useTranslation();
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
      {copied ? t('common.copied') : (label ?? t('common.copy'))}
    </button>
  );
}
