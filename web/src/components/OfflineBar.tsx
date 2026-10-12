import { useEffect, useState } from 'preact/hooks';
import { offline } from '../api';
import type { OfflineState } from '../offline/core';

const at = (t: number | null) => {
  if (!t) return 'earlier';
  const d = new Date(t);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? `at ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : `on ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
};

export function useOfflineState() {
  const [s, setS] = useState<OfflineState>(offline.state());
  useEffect(() => offline.subscribe(setS), []);
  return s;
}

/** Offline / syncing / sync-problem banner above every page. */
export function OfflineBar() {
  const s = useOfflineState();
  const changes = (n: number) => `${n} change${n === 1 ? '' : 's'}`;
  return (
    <>
      {!s.online && (
        <div class="banner offline" role="status">
          <strong>○ offline</strong> · showing data saved {at(s.syncedAt)}.{' '}
          {s.pending > 0 ? `${changes(s.pending)} will sync when you’re back online.` : 'Inventory changes you make are saved on this device and sync later.'}
        </div>
      )}
      {s.online && s.pending > 0 && <div class="banner sync" role="status">↻ {s.syncing ? 'syncing' : 'waiting to sync'} {changes(s.pending)}…</div>}
      {s.problems.length > 0 && (
        <div class="banner" role="alert">
          ⚠ Some offline changes couldn’t be applied:
          <ul style="margin:4px 0 4px 18px;padding:0">{s.problems.map((p) => <li key={p}>{p}</li>)}</ul>
          <button class="sm" onClick={() => offline.dismissProblems()}>dismiss</button>
        </div>
      )}
    </>
  );
}
