import { render } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import './theme.css';
import { api, ApiError, OfflineError, offline, onUnauthorized } from './api';
import { OfflineBar } from './components/OfflineBar';
import { navigate, useRoute } from './router';
import { App, useApp as useContextSafe, type AppCtx } from './components/ui';
import type { Me } from './types';
import { Login, Join, NoHousehold, RequestAccess } from './views/Auth';
import { Dashboard } from './views/Dashboard';
import { Inventory } from './views/Inventory';
import { AddItems } from './views/Add';
import { Gardens, GardenEditor } from './views/Garden';
import { Mesh } from './views/Mesh';
import { Docs } from './views/Docs';
import { Settings } from './views/Settings';
import { Armory } from './views/Armory';
import { Linked, LinkCodeLanding } from './views/Linked';

const NAV = [
  { path: '', label: 'Dashboard', short: 'Home', ico: '⌂', key: 'h' },
  { path: 'inventory', label: 'Inventory', short: 'Stock', ico: '≣', key: 'i' },
  { path: 'add', label: 'Add / Scan', short: 'Add', ico: '+', key: 'a', cls: 'scan' },
  { path: 'garden', label: 'Gardens', short: 'Garden', ico: '♣', key: 'g' },
  { path: 'armory', label: 'Armory', short: 'Armory', ico: '⌖', key: 'r' },
  { path: 'mesh', label: 'Mesh', short: 'Mesh', ico: '◉', key: 'm' },
  { path: 'linked', label: 'Linked', short: 'Linked', ico: '⇄', key: 'l' },
  { path: 'docs', label: 'Docs', short: 'Docs', ico: '?', key: 'd' },
  { path: 'settings', label: 'Settings', short: 'Settings', ico: '⚙', key: 's' },
];

function toggleTheme() {
  // Dark is the default look (terminal); light only when chosen.
  const cur = document.documentElement.dataset.theme ?? 'dark';
  const next = cur === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('bunkerr.theme', next); } catch { /* private mode */ }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', next === 'light' ? '#f4f3ec' : '#0a0e0b');
}

function Root() {
  const route = useRoute();
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<'loading' | 'anon' | 'ready'>('loading');
  const [toasts, setToasts] = useState<{ id: number; msg: string; kind: 'ok' | 'error' }[]>([]);
  const tid = useRef(0);

  const toast = useCallback((msg: string, kind: 'ok' | 'error' = 'ok') => {
    const id = ++tid.current;
    setToasts((t) => [...t.slice(-2), { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3000);
  }, []);

  const refreshMe = useCallback(async () => {
    try {
      const m = await api.get<Me>('/api/me');
      setMe(m); setState('ready');
      void offline.rememberMe(m);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { setMe(null); setState('anon'); return; }
      // Offline at startup: open with the account and data saved on this device.
      if (e instanceof OfflineError) {
        const saved = await offline.lastMe<Me>();
        if (saved) { setMe(saved); setState('ready'); } else setState('anon');
        return;
      }
      toast((e as Error).message, 'error');
    }
  }, []);

  // Saved data and queued changes are filed under user + active household.
  useEffect(() => { void offline.setScope(me ? { userId: me.user.id, householdId: me.active?.id ?? null } : null); }, [me?.user.id, me?.active?.id]);

  // Sync: send queued changes and refresh saved data on start, when the connection comes back, and every 10 min.
  useEffect(() => {
    if (state !== 'ready' || !me) return;
    const urls = () => ['/api/me', '/api/dashboard', '/api/settings', '/api/items', '/api/items/meta', '/api/power', '/api/household', '/api/gardens', '/api/plants', '/api/mesh', '/api/docs', '/api/links',
      ...(me.armoryVisible ? ['/api/armory'] : [])];
    const sync = async () => { await offline.flush(); await offline.prefetch(urls()); };
    let busy = false;
    const back = async () => {
      if (busy) return;
      busy = true;
      try { if (await offline.probe()) { await refreshMe(); await sync(); } } finally { busy = false; }
    };
    void sync();
    const fast = setInterval(() => { if (!offline.state().online) void back(); else if (offline.state().pending) void offline.flush(); }, 20000);
    const slow = setInterval(() => { if (offline.state().online) void sync(); }, 10 * 60000);
    window.addEventListener('online', back);
    return () => { clearInterval(fast); clearInterval(slow); window.removeEventListener('online', back); };
  }, [state, me?.user.id, me?.active?.id]);

  useEffect(() => { void refreshMe(); return onUnauthorized(() => { setMe(null); setState('anon'); }); }, []);

  const onAuthed = (m: Me) => {
    setMe(m); setState('ready');
    const pending = sessionStorage.getItem('bunkerr.pendingInvite');
    if (pending) { sessionStorage.removeItem('bunkerr.pendingInvite'); navigate(`/join/${pending}`); }
  };

  const toastEl = (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.map((t) => <div key={t.id} class={`toast ${t.kind}`}>{t.kind === 'error' ? '✗ ' : '✓ '}{t.msg}</div>)}
    </div>
  );

  if (state === 'loading') return <div class="auth"><p class="muted">booting bunkerr…</p></div>;
  if (route[0] === 'request' && (state === 'anon' || !me)) return <><RequestAccess token={route[1]} onAuthed={onAuthed} />{toastEl}</>;
  if (route[0] === 'link') return <LinkCodeLanding />;
  if (route[0] === 'join') return <>{<Join token={route[1] ?? ''} me={me} onAuthed={onAuthed} toast={toast} />}{toastEl}</>;
  if (state === 'anon' || !me) return <><Login onAuthed={(m) => { void offline.rememberMe(m); onAuthed(m); }} />{toastEl}</>;

  const ctx: AppCtx = {
    me, setMe, refreshMe, toast,
    canWrite: me.active?.role === 'owner' || me.active?.role === 'member',
    isOwner: me.active?.role === 'owner',
  };
  return (
    <App.Provider value={ctx}>
      <Shell route={route} />
      {toastEl}
    </App.Provider>
  );
}

function Shell({ route }: { route: string[] }) {
  const { me, setMe, toast } = useContextSafe();
  const section = route[0] ?? '';

  // "g" then a key, like vim/gmail. Ignored while typing.
  useEffect(() => {
    let armed = 0;
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(t.tagName) || t.isContentEditable) return;
      if (e.key === 'g') { armed = Date.now(); return; }
      if (Date.now() - armed < 1200) {
        const n = NAV.find((x) => x.key === e.key);
        if (n) { navigate(`/${n.path}`); armed = 0; }
      }
    };
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  }, []);

  const switchHh = async (id: number) => {
    try { setMe(await api.post<Me>('/api/households/switch', { householdId: id })); navigate('/'); }
    catch (e) { toast((e as Error).message, 'error'); }
  };

  let view;
  if (!me.active && section !== 'settings' && section !== 'docs') view = <NoHousehold />;
  else switch (section) {
    case '': view = <Dashboard />; break;
    case 'inventory': view = <Inventory tab={route[1]} />; break;
    case 'add': view = <AddItems tab={route[1]} />; break;
    case 'garden': view = route[1] ? <GardenEditor id={Number(route[1])} /> : <Gardens />; break;
    case 'mesh': view = <Mesh />; break;
    case 'armory': view = <Armory tab={route[1]} />; break;
    case 'linked': view = <Linked id={route[1] ? Number(route[1]) : undefined} />; break;
    case 'docs': view = <Docs slug={route[1]} />; break;
    case 'settings': view = <Settings />; break;
    default: view = <p>404 — <a href="#/">go home</a></p>;
  }

  const inst = me.instance;
  const nav = NAV.filter((n) => (n.path !== 'armory' || me.armoryVisible) && (n.path !== 'linked' || me.links > 0));
  return (
    <div class="shell">
      <nav class="sidebar" aria-label="Main">
        <a class="brand" href="#/">BUNKERR<span class="cursor">&nbsp;</span></a>
        {nav.map((n) => (
          <a key={n.path} class="nav" href={`#/${n.path}`} aria-current={section === n.path ? 'page' : undefined}>
            <span>{n.ico}&nbsp; {n.label}</span><kbd>g {n.key}</kbd>
          </a>
        ))}
        <div class="foot">
          signed in as<br /><strong>{me.user.name}</strong>
        </div>
      </nav>
      <div>
        <header class="topbar">
          <a class="brand" href="#/">BUNKERR<span class="cursor">&nbsp;</span></a>
          {me.households.length > 0 && (
            <select class="hh-switch" aria-label="Household" value={me.active?.id ?? ''} onChange={(e) => switchHh(Number((e.target as HTMLSelectElement).value))} style="width:auto">
              {me.households.map((h) => <option key={h.id} value={h.id}>⌂ {h.name}{h.role === 'viewer' ? ' (view)' : ''}</option>)}
            </select>
          )}
          <span class="spacer" />
          <a class="btn sm ghost only-mobile" href="#/docs" aria-label="Docs">?</a>
          <a class="btn sm ghost only-mobile" href="#/settings" aria-label="Settings">⚙</a>
          <button class="sm ghost" onClick={toggleTheme} aria-label="Toggle light/dark theme" title="Toggle theme"><svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="2" /><path d="M10 2.5a7.5 7.5 0 0 1 0 15z" fill="currentColor" /></svg></button>
        </header>
        <main class="main" id="main">
          <OfflineBar />
          {inst.role === 'primary' && inst.peerActive && (
            <div class="banner">⚠ Failover is active on the standby. This instance ({inst.node}) is fenced — changes here won’t be seen. Run the failback procedure (Docs → Failover).</div>
          )}
          {inst.role === 'standby' && !inst.active && (
            <div class="banner">⚠ You are on the standby ({inst.node}) which is not active — it is overwritten from the primary every few minutes.</div>
          )}
          {view}
          <footer class="statusline">
            <span>node:{inst.node}</span>
            <span>role:{inst.role}{inst.active ? '' : ' (inactive)'}</span>
            {me.active && <span>hh:{me.active.name} [{me.active.role}]</span>}
            <span>user:{me.user.email}</span>
          </footer>
        </main>
      </div>
      <nav class="tabbar" aria-label="Main">
        {/* Linked is reached from the dashboard on phones; six tabs is the most that fit. */}
        {nav.filter((n) => n.path !== 'docs' && n.path !== 'settings' && n.path !== 'linked').map((n) => (
          <a key={n.path} class={n.cls} href={`#/${n.path}`} aria-current={section === n.path ? 'page' : undefined}>
            <span class="ico" aria-hidden="true">{n.ico}</span>{n.short}
          </a>
        ))}
      </nav>
    </div>
  );
}

render(<Root />, document.getElementById('app')!);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
