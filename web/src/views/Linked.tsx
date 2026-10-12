import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { api } from '../api';
import { navigate } from '../router';
import { Empty, Field, Loading, Modal, Panel, Prompt, ago, copyText, fmtQty, localToday, relDays, useApp, useFetch } from '../components/ui';
import type { Link, LinkFeed, LinkShare, LinkSummary, LinksData } from '../types';

const days = (n: number | null | undefined) => (n == null ? '—' : n >= 365 ? `${(n / 365).toFixed(1)}y` : `${Math.floor(n)}d`);
/** Older than this, the other server has probably been unreachable for a while. */
const STALE_MS = 60 * 60000;

const SHARE_LABELS: { key: keyof LinkShare; label: string; hint: string }[] = [
  { key: 'summary', label: 'readiness summary', hint: 'days of food & water, counts per section, how much is expiring' },
  { key: 'inventory', label: 'inventory', hint: 'item names, amounts and expiry dates. Never locations or notes' },
  { key: 'power', label: 'power equipment', hint: 'devices, capacity, charge level, next upkeep' },
  { key: 'mesh', label: 'mesh node status', hint: 'online, battery, last heard. Never positions' },
];

const sharedList = (s: LinkShare) => SHARE_LABELS.filter((x) => s[x.key]).map((x) => x.label).join(', ') || 'nothing';

export function SummaryStats({ s }: { s: LinkSummary }) {
  return (
    <div class="grid stats">
      <div class="stat cyan"><div class="k">food</div><div class="v">{days(s.foodDays)}</div><div class="n">for {s.people} {s.people === 1 ? 'person' : 'people'}</div></div>
      <div class="stat cyan"><div class="k">water</div><div class="v">{days(s.waterDays)}</div><div class="n">{s.waterGallons ? `${fmtQty(+s.waterGallons.toFixed(1))} gal` : 'none tracked'}</div></div>
      <div class={`stat ${s.expired ? 'red' : 'green'}`}><div class="k">expired</div><div class="v">{s.expired}</div><div class="n">batches</div></div>
      <div class={`stat ${s.soon ? 'amber' : 'green'}`}><div class="k">use soon</div><div class="v">{s.soon}</div><div class="n">batches</div></div>
    </div>
  );
}

function Freshness({ l }: { l: Link }) {
  if (l.status === 'ended') return <span class="err">link ended by them</span>;
  const stale = !l.feed_at || Date.now() - l.feed_at > STALE_MS;
  return (
    <span class={l.pull_error || stale ? 'warn' : 'muted'}>
      {l.feed_at ? `updated ${ago(l.feed_at)}` : 'waiting for first update'}
      {l.pull_error && ` · last try failed: ${l.pull_error}`}
    </span>
  );
}

// ---------------- #/linked and #/linked/:id ----------------
export function Linked({ id }: { id?: number }) {
  const { me } = useApp();
  const { data, error, reload, setData } = useFetch<LinksData>('/api/links', [me.active?.id]);
  if (!data) return <><Prompt title="linked" /><Loading error={error} /></>;
  if (id) {
    const l = data.links.find((x) => x.id === id);
    if (!l) return <><Prompt title="linked" /><p>That link isn’t here any more. <a href="#/linked">All linked households</a></p></>;
    return <LinkDetail l={l} onRefreshed={(n) => setData((d) => d && { ...d, links: d.links.map((x) => (x.id === n.id ? n : x)) })} />;
  }
  return (
    <>
      <Prompt title="linked" sub="households on other Bunkerr servers">
        <button class="sm" onClick={reload}>reload</button>
      </Prompt>
      {data.links.length === 0 && (
        <Panel title="nobody linked yet">
          <p class="muted" style="margin:0">Link with a friend’s or relative’s household on their own Bunkerr server to see what they choose to share. {me.active?.role === 'owner' ? <a href="#/settings">Settings → linked households</a> : 'A household owner can set it up in Settings.'}</p>
        </Panel>
      )}
      <div class="grid c2">
        {data.links.map((l) => (
          <Panel key={l.id} title={<a href={`#/linked/${l.id}`}>{l.peer_household || l.peer_host}</a>} right={<span class="muted small">{l.peer_host}</span>}>
            <p class="small" style="margin:0 0 8px"><Freshness l={l} /></p>
            {l.summary ? <SummaryStats s={l.summary} /> : <p class="muted small">{l.status === 'ended' ? 'Nothing is shared any more.' : `They share: ${l.feed ? sharedList(l.feed.shares) : '…'}`}</p>}
            <div class="toolbar" style="margin:8px 0 0"><a class="btn sm" href={`#/linked/${l.id}`}>open →</a></div>
          </Panel>
        ))}
      </div>
    </>
  );
}

type Tab = 'overview' | 'stock' | 'power' | 'mesh';

function LinkDetail({ l, onRefreshed }: { l: Link; onRefreshed: (l: Link) => void }) {
  const { toast, isOwner } = useApp();
  const f = l.feed ?? null;
  const tabs: [Tab, string, number | null][] = [
    ['overview', 'overview', null],
    ...(f?.items ? [['stock', 'stock', f.items.length] as [Tab, string, number]] : []),
    ...(f?.power ? [['power', 'power', f.power.length] as [Tab, string, number]] : []),
    ...(f?.mesh ? [['mesh', 'mesh', f.mesh.length] as [Tab, string, number]] : []),
  ];
  const [tab, setTab] = useState<Tab>('overview');
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    try { const n = await api.post<Link>(`/api/links/${l.id}/refresh`); onRefreshed(n); if (n.pull_error) toast(n.pull_error, 'error'); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const current = tabs.some((t) => t[0] === tab) ? tab : 'overview';

  return (
    <>
      <Prompt title={l.peer_household || l.peer_host} sub={<>{l.peer_host} · <Freshness l={l} /></>}>
        <a class="btn sm" href="#/linked">← all</a>
        {l.status === 'active' && <button class="sm" disabled={busy} onClick={refresh}>{busy ? 'updating…' : 'update now'}</button>}
      </Prompt>
      {l.status === 'ended' && <div class="banner">They removed this link, so nothing is shared either way. {isOwner && 'Remove it in Settings → linked households.'}</div>}
      {l.status === 'active' && l.feed_at && Date.now() - l.feed_at > STALE_MS && (
        <div class="banner">⚠ Showing their data from {ago(l.feed_at)}. Their server or the connection may be down; it updates by itself when it’s back.</div>
      )}
      {!f ? <Panel title="nothing yet"><p class="muted" style="margin:0">{l.status === 'ended' ? 'Nothing is shared.' : 'No data from them yet. It arrives within a few minutes of linking.'}</p></Panel> : (
        <>
          {tabs.length > 1 && (
            <div class="tabs" role="tablist" aria-label="Shared sections">
              {tabs.map(([t, label, n]) => (
                <button key={t} role="tab" class="chip" aria-selected={current === t} aria-pressed={current === t} onClick={() => setTab(t)}>{label}{n != null && <span class="tab-n">{n}</span>}</button>
              ))}
            </div>
          )}
          {current === 'overview' && <Overview f={f} />}
          {current === 'stock' && <Stock items={f.items ?? []} />}
          {current === 'power' && <PowerList power={f.power ?? []} />}
          {current === 'mesh' && <NodeList nodes={f.mesh ?? []} />}
        </>
      )}
      <p class="muted small">You share with them: <strong>{sharedList(l.share)}</strong>.{isOwner && <> Change it in <a href="#/settings">Settings → linked households</a>.</>}</p>
    </>
  );
}

function Overview({ f }: { f: LinkFeed }) {
  const s = f.summary;
  return (
    <>
      {s ? (
        <>
          <div style="margin-bottom:14px"><SummaryStats s={s} /></div>
          <Panel title="stock by section">
            {s.counts.length === 0 ? <p class="muted" style="margin:0">Their inventory is empty.</p> : (
              <div class="chips">{s.counts.map((c) => <span key={c.category} class="chip">{c.category} · {c.batches}</span>)}</div>
            )}
            <p class="small muted" style="margin:8px 0 0">
              {s.lowStock} below minimum · {s.power.devices} power devices{s.power.due ? `, ${s.power.due} need upkeep` : ''}{s.mesh.total ? ` · mesh ${s.mesh.online}/${s.mesh.total} online` : ''}
            </p>
          </Panel>
        </>
      ) : <Panel title="summary"><p class="muted" style="margin:0">They don’t share their summary.</p></Panel>}
      <p class="muted small">They share: {sharedList(f.shares)}.</p>
    </>
  );
}

function Stock({ items }: { items: NonNullable<LinkFeed['items']> }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const today = localToday();
  const soon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const cats = useMemo(() => [...new Set(items.map((i) => i.category))], [items]);
  const shown = items.filter((i) => (!cat || i.category === cat) && (!q || i.name.toLowerCase().includes(q.toLowerCase())));
  return (
    <Panel title="their stock" right={<span class="muted small">{shown.length} batches</span>} flush>
      <div class="toolbar" style="padding:10px 12px;margin:0">
        <input type="search" placeholder="search their items" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} aria-label="Search their items" style="flex:1;min-width:140px" />
        <select style="width:auto" value={cat} onChange={(e) => setCat((e.target as HTMLSelectElement).value)} aria-label="Section">
          <option value="">all sections</option>{cats.map((c) => <option key={c}>{c}</option>)}
        </select>
      </div>
      {shown.length === 0 ? <Empty>nothing matches</Empty> : (
        <ul class="list">
          {shown.slice(0, 500).map((i, n) => {
            const cls = !i.expires_on ? 'muted' : i.expires_on < today ? 't-expired' : i.expires_on <= soon ? 't-soon' : 'muted';
            return (
              <li key={n}>
                <div class="grow"><div class="title">{i.name}</div><div class="meta">{fmtQty(i.qty)} {i.unit} · {i.category}{i.min_qty != null && i.qty < i.min_qty ? <span class="warn"> · low</span> : ''}</div></div>
                <span class={`small ${cls}`}>{i.expires_on ? relDays(i.expires_on, today) : 'no date'}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function PowerList({ power }: { power: NonNullable<LinkFeed['power']> }) {
  const today = localToday();
  return (
    <Panel title="their power equipment" flush>
      {power.length === 0 ? <Empty>no devices</Empty> : (
        <ul class="list">
          {power.map((e, n) => (
            <li key={n}>
              <span aria-hidden="true">⚡</span>
              <div class="grow">
                <div class="title">{e.name}</div>
                <div class="meta">{[e.kind.replace('_', ' '), [e.brand, e.model].filter(Boolean).join(' '), e.capacity_wh ? `${fmtQty(e.capacity_wh)} Wh` : '', e.output_w ? `${fmtQty(e.output_w)} W` : '', e.fuel].filter(Boolean).join(' · ')}</div>
                {e.next_task && <div class="meta">{e.next_task} <span class={e.next_due_on && e.next_due_on <= today ? 't-expired' : ''}>{relDays(e.next_due_on, today)}</span></div>}
              </div>
              {e.charge_pct != null && <span class="small">{e.charge_pct}%</span>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function NodeList({ nodes, title = 'their mesh nodes', right }: { nodes: NonNullable<LinkFeed['mesh']>; title?: string; right?: ComponentChildren }) {
  return (
    <Panel title={title} right={right} flush>
      {nodes.length === 0 ? <Empty>no nodes</Empty> : (
        <ul class="list">
          {nodes.map((n) => (
            <li key={n.node_id}>
              <span class={`dot ${n.last_heard == null ? 'unk' : n.online ? 'on' : 'off'}`} aria-label={n.online ? 'online' : 'offline'} />
              <div class="grow">
                <div class="title">{n.name} {n.short_name && <span class="muted">[{n.short_name}]</span>}</div>
                <div class="meta">{n.node_id}{n.site ? ` · ${n.site}` : ''}{n.hw_model ? ` · ${n.hw_model}` : ''} · heard {ago(n.last_heard)}</div>
              </div>
              {n.battery != null && <span class="small">{n.battery > 100 ? 'USB' : `${Math.round(n.battery)}%`}</span>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ---------------- Settings → linked households ----------------
export function LinksPanel() {
  const { me, isOwner, toast, refreshMe } = useApp();
  const { data, reload, setData } = useFetch<LinksData>('/api/links', [me.active?.id]);
  const [code, setCode] = useState<{ url: string; expires_at: number } | null>(null);
  const [paste, setPaste] = useState('');
  const [busy, setBusy] = useState(false);
  if (!data) return <Panel title="linked households"><Loading /></Panel>;

  const replace = (n: Link) => setData((d) => d && { ...d, links: d.links.map((x) => (x.id === n.id ? n : x)) });
  const makeCode = async () => {
    try { setCode(await api.post('/api/links/codes')); reload(); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const connect = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    try {
      const l = await api.post<Link>('/api/links/connect', { code: paste });
      toast(`Linked with ${l.peer_household || l.peer_host}`);
      setPaste(''); reload(); await refreshMe();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };

  return (
    <Panel title="linked households" right={data.links.length > 0 && <a href="#/linked">view →</a>}>
      <div class="form">
        <p class="muted small" style="margin:0">
          Link with a household on another Bunkerr server, like a friend’s or a relative’s. Each side chooses what it shares and sees the other’s under <a href="#/linked">Linked</a>,
          even when their server is down (the last copy is kept). The armory is never shared.
        </p>
        {!data.enabled && <p class="warn small" style="margin:0">Turned off on this server (FEDERATION=off).</p>}
        {data.enabled && isOwner && (
          <>
            <div class="toolbar" style="margin:0">
              <button class="primary" onClick={makeCode}>create link code</button>
              <span class="muted small">for them to paste into their Bunkerr</span>
            </div>
            <form class="toolbar" style="margin:0" onSubmit={connect}>
              <input style="flex:1;min-width:180px" placeholder="or paste a link code from their Bunkerr" value={paste} onInput={(e) => setPaste((e.target as HTMLInputElement).value.trim())} aria-label="Link code from another Bunkerr" autocapitalize="off" spellcheck={false} />
              <button disabled={busy || !paste}>{busy ? 'linking…' : 'connect'}</button>
            </form>
            {data.codes.map((c) => (
              <div key={c.id} class="toolbar small" style="margin:0">
                <span class="grow">unused code made {ago(c.created_at)} · expires {relDays(new Date(c.expires_at).toISOString().slice(0, 10), localToday())}</span>
                <button class="sm" onClick={async () => { try { await api.del(`/api/links/codes/${c.id}`); reload(); } catch (e) { toast((e as Error).message, 'error'); } }}>revoke</button>
              </div>
            ))}
          </>
        )}
        {data.links.map((l) => <LinkSettings key={l.id} l={l} relay={data.relay} onChange={replace} onRemoved={() => { reload(); void refreshMe(); }} />)}
      </div>
      {code && <CodeModal {...code} onClose={() => setCode(null)} />}
    </Panel>
  );
}

function CodeModal({ url, onClose }: { url: string; expires_at: number; onClose: () => void }) {
  const { toast } = useApp();
  const share = async () => {
    if (navigator.share) { try { await navigator.share({ title: 'Bunkerr link code', text: url }); return; } catch { /* cancelled */ } }
    toast((await copyText(url)) ? 'Code copied' : 'Copy failed — select it manually');
  };
  return (
    <Modal title="link code" onClose={onClose} footer={<><button onClick={onClose}>done</button><button class="primary" onClick={share}>share / copy</button></>}>
      <p style="margin-top:0">Send this to the other household’s owner. They paste it into <em>Settings → linked households → connect</em> on their own Bunkerr.</p>
      <input readOnly value={url} onFocus={(e) => (e.target as HTMLInputElement).select()} aria-label="Link code" />
      <p class="muted small">It works once and expires in 7 days. At first only your readiness summary is shared; you choose the rest after linking.</p>
    </Modal>
  );
}

function LinkSettings({ l, relay, onChange, onRemoved }: { l: Link; relay: LinksData['relay']; onChange: (l: Link) => void; onRemoved: () => void }) {
  const { isOwner, toast } = useApp();
  const [channels, setChannels] = useState(l.relay_channels.join(', '));
  useEffect(() => setChannels(l.relay_channels.join(', ')), [l.relay_channels.join(',')]);
  const patch = async (body: object, msg?: string) => {
    try { onChange(await api.patch<Link>(`/api/links/${l.id}`, body)); if (msg) toast(msg); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const theyRelay = l.feed?.relay_channels ?? [];
  const ended = l.status === 'ended';

  return (
    <fieldset class="panel" style="margin:0;padding:10px 12px">
      <legend class="small" style="padding:0 6px"><strong>{l.peer_household || '…'}</strong> <span class="muted">@ {l.peer_host}</span> {ended && <span class="badge t-expired">ended</span>}</legend>
      <p class="small" style="margin:0 0 6px"><Freshness l={l} />{l.seen_at && <span class="muted"> · they last checked in {ago(l.seen_at)}</span>}</p>
      {!ended && (
        <>
          <div class="muted small" style="margin-bottom:4px">YOU SHARE</div>
          {SHARE_LABELS.map((x) => (
            <label key={x.key} class="check">
              <input type="checkbox" checked={l.share[x.key]} disabled={!isOwner} onChange={(e) => patch({ share: { [x.key]: (e.target as HTMLInputElement).checked } })} />
              <span>{x.label} <span class="muted small">({x.hint})</span></span>
            </label>
          ))}
          <p class="muted small" style="margin:6px 0 0">They share: {l.feed ? sharedList(l.feed.shares) : 'nothing yet'}.</p>
          {relay.available && (
            <div style="margin-top:8px">
              <div class="muted small" style="margin-bottom:4px">MESH RELAY</div>
              {relay.canEdit ? (
                <form class="toolbar" style="margin:0" onSubmit={(e) => { e.preventDefault(); void patch({ relay_channels: channels.split(',').map((c) => c.trim()).filter(Boolean) }, 'Mesh relay saved'); }}>
                  <Field label="channel names to relay (comma-separated, empty = off)">
                    <input value={channels} onInput={(e) => setChannels((e.target as HTMLInputElement).value)} placeholder="Family" autocapitalize="off" spellcheck={false} />
                  </Field>
                  <button class="sm" style="align-self:flex-end">save</button>
                </form>
              ) : <p class="small" style="margin:0">{l.relay_channels.length ? `Relaying ${l.relay_channels.join(', ')}` : 'Off'} <span class="muted">(set by the instance admin)</span></p>}
              {(l.relay_channels.length > 0 || theyRelay.length > 0) && (
                <p class="small muted" style="margin:4px 0 0">
                  they relay: {theyRelay.join(', ') || 'nothing'}
                  {l.relay && ` · sent ${l.relay.sent}, received ${l.relay.received}${l.relay.dropped ? `, dropped ${l.relay.dropped}` : ''}`}
                  {l.relay?.error && <span class="warn"> · {l.relay.error}</span>}
                  {l.relay_channels.length > 0 && !relay.root && <span class="warn"> · this server doesn’t know its MQTT root topic yet (set MQTT_ROOT)</span>}
                </p>
              )}
            </div>
          )}
        </>
      )}
      {isOwner && (
        <div class="toolbar" style="margin:8px 0 0">
          <span class="grow" />
          <button class="sm danger" onClick={async () => {
            if (!confirm(`Remove the link with ${l.peer_household || l.peer_host}? Neither side will see the other’s data any more.`)) return;
            try { await api.del(`/api/links/${l.id}`); toast('Link removed'); onRemoved(); } catch (e) { toast((e as Error).message, 'error'); }
          }}>remove link</button>
        </div>
      )}
    </fieldset>
  );
}

// ---------------- #/link/<code> opened in a browser ----------------
export function LinkCodeLanding() {
  const url = location.href;
  return (
    <div class="auth">
      <div class="box">
        <div class="panel">
          <div class="ph"><span>link code</span></div>
          <div class="pb form">
            <p style="margin:0">This is a code for linking a household on <strong>{location.host}</strong> with a household on another Bunkerr server.</p>
            <p style="margin:0">The other household’s owner pastes the whole address into <em>Settings → linked households → connect</em> on their own Bunkerr. It works once and expires 7 days after it was made.</p>
            <input readOnly value={url} onFocus={(e) => (e.target as HTMLInputElement).select()} aria-label="Link code" />
            <div class="toolbar" style="margin:0"><button onClick={() => void copyText(url)}>copy</button><a class="btn" href="#/" onClick={() => navigate('/')}>open Bunkerr</a></div>
          </div>
        </div>
      </div>
    </div>
  );
}
