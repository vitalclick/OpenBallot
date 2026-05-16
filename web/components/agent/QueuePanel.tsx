'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { OfflineQueue, type QueuedSubmissionView } from './queue';

// Surfaces the contents of the offline queue. Lets the agent see what's
// stuck and discard items if (for example) a photo was a mis-fire.
//
// Render-only when there's something to show — empty queue collapses to
// a single line so the screen stays clean on the happy path.
export function QueuePanel({ onChange }: { onChange?: (depth: number) => void }) {
  const t = useTranslations('agent');
  const [items, setItems] = useState<QueuedSubmissionView[]>([]);

  const refresh = async () => {
    const rows = await OfflineQueue.list();
    setItems(rows);
    onChange?.(rows.length);
  };

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (items.length === 0) {
    return (
      <div className="mt-6 border-t pt-3 text-xs text-slate-500">{t('queue_empty')}</div>
    );
  }

  return (
    <div className="mt-6 border-t pt-3">
      <h2 className="text-xs font-medium text-slate-600 mb-2">{t('queue_title')}</h2>
      <ul className="space-y-2">
        {items.map((row) => (
          <li
            key={row.id}
            className="flex items-center justify-between text-xs border rounded px-3 py-2"
          >
            <div className="min-w-0">
              <div className="font-mono truncate">
                {row.pu_code} · {row.election_id}
              </div>
              <div className="text-slate-500">
                {row.submission_id
                  ? `${row.last_status ?? t('queue_pending')}`
                  : t('queue_pending')}
                {row.retries ? ` · ${t('queue_retries', { n: row.retries })}` : ''}
              </div>
            </div>
            <button
              onClick={async () => {
                if (!confirm(t('queue_discard_confirm'))) return;
                await OfflineQueue.forget(row.id);
                refresh();
              }}
              className="ml-3 text-red-600 underline"
            >
              {t('queue_discard')}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
