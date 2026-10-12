import { createContext, type ComponentChildren } from 'preact';
import { useCallback, useContext, useEffect, useRef, useState } from 'preact/hooks';
import { api, offline } from '../api';
import type { Me, Tier } from '../types';

// ---------- app context ----------
export interface AppCtx {
  me: Me;
  setMe: (m: Me) => void;
  refreshMe: () => Promise<void>;
  toast: (msg: string, kind?: 'ok' | 'error') => void;
  canWrite: boolean;
  isOwner: boolean;
}
export const App = createContext<AppCtx>(null as unknown as AppCtx);
export const useApp = () => useContext(App);

// ---------- data hook ----------
export function useFetch<T>(url: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!url);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    if (!url) return;
    const n = ++seq.current;
    setLoading(true);
    try {
      const d = await api.get<T>(url);
      if (n === seq.current) { setData(d); setError(null); }
    } catch (e) {
      if (n === seq.current) setError((e as Error).message);
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [url, ...deps]);
  useEffect(() => { void reload(); }, [reload]);
  // Offline edits and finished syncs change saved data: show it.
  useEffect(() => (url ? offline.onData(() => { void reload(); }) : undefined), [reload]);
  return { data, error, loading, reload, setData };
}

// ---------- layout bits ----------
export function Prompt({ title, sub, children }: { title: string; sub?: ComponentChildren; children?: ComponentChildren }) {
  return (
    <header class="prompt">
      <h1>{title}</h1>
      {sub && <span class="sub">{sub}</span>}
      {children && <div class="actions">{children}</div>}
    </header>
  );
}

export function Panel({ title, right, children, flush }: { title: ComponentChildren; right?: ComponentChildren; children: ComponentChildren; flush?: boolean }) {
  return (
    <section class="panel">
      <div class="ph"><span>{title}</span>{right && <span class="r">{right}</span>}</div>
      <div class={`pb${flush ? ' flush' : ''}`}>{children}</div>
    </section>
  );
}

export function Empty({ children }: { children: ComponentChildren }) {
  return <div class="empty">{children}</div>;
}

export function Loading({ error }: { error?: string | null }) {
  return error ? <p class="err">error: {error}</p> : <p class="muted">loading<span class="blink">…</span></p>;
}

export function Field({ label, children, hint }: { label: string; children: ComponentChildren; hint?: ComponentChildren }) {
  return (
    <label class="field">
      <span>{label}</span>
      {children}
      {hint && <small class="muted">{hint}</small>}
    </label>
  );
}

export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ComponentChildren; footer?: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', on);
    document.body.style.overflow = 'hidden';
    ref.current?.querySelector<HTMLElement>('input,select,textarea,button:not(.close)')?.focus();
    return () => { document.removeEventListener('keydown', on); document.body.style.overflow = ''; prev?.focus?.(); };
  }, []);
  return (
    <div class="modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div class="mh"><h2>{title}</h2><span style="flex:1" /><button class="ghost sm close" onClick={onClose} aria-label="Close">[x]</button></div>
        <div class="mb">{children}</div>
        {footer && <div class="mf">{footer}</div>}
      </div>
    </div>
  );
}

const TIER_LABEL: Record<Tier, string> = { expired: 'EXPIRED', soon: 'USE SOON', upcoming: '< 90d', ok: 'OK', none: 'no date' };
export function TierBadge({ tier }: { tier: Tier }) {
  return <span class={`badge t-${tier}`}>{TIER_LABEL[tier]}</span>;
}

/** Text progress bar, e.g. [████████░░░░] */
export function AsciiBar({ value, width = 12 }: { value: number; width?: number }) {
  const n = Math.round(Math.max(0, Math.min(1, value)) * width);
  return <span class="ascii-bar" aria-label={`${Math.round(value * 100)}%`}>[{'█'.repeat(n)}{'░'.repeat(width - n)}]</span>;
}

export function Sparkline({ values, width = 120, height = 28, color = 'var(--accent)', label }: { values: (number | null)[]; width?: number; height?: number; color?: string; label?: string }) {
  const pts = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] != null);
  if (pts.length < 2) return <span class="muted small">—</span>;
  const ys = pts.map((p) => p[1]);
  const min = Math.min(...ys), max = Math.max(...ys), span = max - min || 1;
  const x = (i: number) => (i / (values.length - 1)) * (width - 2) + 1;
  const y = (v: number) => height - 2 - ((v - min) / span) * (height - 4);
  const d = pts.map((p, k) => `${k ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label ?? `trend ${ys[0]} to ${ys[ys.length - 1]}`}>
      <path d={d} fill="none" stroke={color} stroke-width="1.5" />
    </svg>
  );
}

// ---------- formatting ----------
export function relDays(iso: string | null | undefined, today: string): string {
  if (!iso) return '—';
  const d = Math.round((Date.parse(iso) - Date.parse(today)) / 86400000);
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d === -1) return 'yesterday';
  return d < 0 ? `${-d}d ago` : d < 60 ? `in ${d}d` : d < 730 ? `in ${Math.round(d / 30)}mo` : `in ${(d / 365).toFixed(1)}y`;
}

export function ago(ms: number | null | undefined): string {
  if (!ms) return 'never';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const fmtQty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, ''));

export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}
