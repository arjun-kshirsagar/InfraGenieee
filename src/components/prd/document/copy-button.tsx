'use client';

import { useCallback, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * A copy-to-clipboard button with transient "Copied" feedback. Degrades safely
 * if the Clipboard API is unavailable (older browsers, insecure context) by
 * showing a brief error state instead of throwing.
 */
export function CopyButton({
  value,
  label = 'Copy',
  size = 'sm',
  variant = 'outline',
}: {
  value: string;
  label?: string;
  size?: 'sm' | 'default';
  variant?: 'outline' | 'secondary' | 'default' | 'ghost';
}) {
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(async () => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(value);
      } else {
        throw new Error('Clipboard API unavailable');
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Fallback: select-and-copy via a temporary textarea.
      try {
        const el = document.createElement('textarea');
        el.value = value;
        el.style.position = 'fixed';
        el.style.opacity = '0';
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      } catch {
        // Give up silently; never crash the page over a copy.
      }
    }
  }, [value]);

  return (
    <Button type="button" size={size} variant={variant} onClick={onCopy}>
      {copied ? <Check className="text-emerald-500" /> : <Copy />}
      {copied ? 'Copied' : label}
    </Button>
  );
}
