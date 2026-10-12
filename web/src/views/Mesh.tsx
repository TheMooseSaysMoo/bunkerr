import { useEffect, useState } from 'preact/hooks';
import { api } from '../api';
import { AsciiBar, Empty, Field, Loading, Modal, Panel, Prompt, Sparkline, ago, useApp, useFetch } from '../components/ui';
import type { LinksData, MeshNode } from '../types';
import { NodeList } from './Linked';

interface MeshData {
  broker: { connected: boolean; lastMessageAt: number | null; error: string | null };
  thresholds: { offlineMinutes: number; lowBattery: number };
  nodes: MeshNode[];
  unclaimed: { node_id: string; long_name?: string; short_name?: string; last_heard: number }[];
}

const nodeName = (n: MeshNode) => n.label || n.long_name || n.node_id;
const uptime = (s: number | null) => (s == null ? '—' : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${(s / 3600).toFixed(1)}h` : `${(s / 86400).toFixed(1)}d`);

export function Mesh() {
  const { me, canWrite, toast } = useApp();
  const { data, error, reload } = useFetch<MeshData>('/api/mesh', [me.active?.id]);
  const [adding, setAdding] = useState<{ node_id: string; label: string; site: string } | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const linked = useFetch<LinksData>(me.links > 0 ? '/api/links' : null, [me.active?.id]);

  useEffect(() => { const t = setInterval(reload, 30000); return () => clearInterval(t); }, [reload]);

  const claim = async () => {
    try { await api.post('/api/mesh/nodes', adding); toast('Node added'); setAdding(null); reload(); }
    catch (e) { toast((e as Error).message, 'error'); }
  };

  if (!data) return <><Prompt title="mesh" /><Loading error={error} /></>;
  const sites = [...new Set(data.nodes.map((n) => n.site || 'unassigned'))];
  const online = data.nodes.filter((n) => n.online).length;

  return (
    <>
      <Prompt title="mesh" sub={`${online}/${data.nodes.length} online · offline after ${data.thresholds.offlineMinutes}m`}>
        {canWrite && <button class="primary" onClick={() => setAdding({ node_id: '', label: '', site: '' })}>add node</button>}
      </Prompt>

      <Panel title="mqtt broker">
        <p style="margin:0">
          <span class={`dot ${data.broker.connected ? 'on' : 'off'}`} /> {data.broker.connected ? 'connected' : 'disconnected'}
          <span class="muted"> · last packet {ago(data.broker.lastMessageAt)}</span>
          {data.broker.error && <span class="err"> · {data.broker.error}</span>}
        </p>
        {!data.broker.connected && <p class="muted small">Node health comes from your Mosquitto broker. Gateways (Heltec V4, Wi-Fi) need MQTT uplink + “JSON output enabled”. See <a href="#/docs/05-meshtastic-mqtt">Docs → Meshtastic MQTT</a>.</p>}
      </Panel>

      {data.nodes.length === 0 && <Panel title="nodes"><Empty>no nodes yet — add your node IDs (shown as !xxxxxxxx in the Meshtastic app)</Empty></Panel>}

      {sites.map((site) => (
        <Panel key={site} title={site} flush>
          <ul class="list">
            {data.nodes.filter((n) => (n.site || 'unassigned') === site).map((n) => (
              <li key={n.id} style="flex-direction:column;align-items:stretch">
                <button class="rowbtn ghost" onClick={() => setOpen(open === n.id ? null : n.id)} aria-expanded={open === n.id}>
                  <div style="display:flex;gap:10px;align-items:center">
                    <span class={`dot ${n.last_heard == null ? 'unk' : n.online ? 'on' : 'off'}`} aria-label={n.online ? 'online' : 'offline'} />
                    <div class="grow">
                      <div class="title">{nodeName(n)} {n.short_name && <span class="muted">[{n.short_name}]</span>}</div>
                      <div class="meta">{n.node_id}{n.hw_model ? ` · ${n.hw_model}` : ''}{n.role ? ` · ${n.role}` : ''} · heard {ago(n.last_heard)}</div>
                    </div>
                    <div class="small" style="text-align:right">
                      {n.battery != null && <div class={n.lowBattery ? 'err' : ''}>{n.battery > 100 ? 'USB' : `${Math.round(n.battery)}%`}</div>}
                      {n.ch_util != null && <div class="muted">ch {n.ch_util.toFixed(1)}%</div>}
                    </div>
                  </div>
                </button>
                {open === n.id && <NodeDetail n={n} onChanged={reload} />}
              </li>
            ))}
          </ul>
        </Panel>
      ))}

      {linked.data?.links.filter((l) => l.status === 'active' && l.feed?.mesh?.length).map((l) => (
        <NodeList key={`link-${l.id}`} nodes={l.feed!.mesh!} title={`⇄ ${l.peer_household || l.peer_host}`} right={<a class="muted small" href={`#/linked/${l.id}`}>linked · {ago(l.feed_at)}</a>} />
      ))}

      {data.unclaimed.length > 0 && canWrite && (
        <Panel title="heard on the mesh (unclaimed)" right={<span class="muted">admin only</span>} flush>
          <ul class="list">
            {data.unclaimed.map((u) => (
              <li key={u.node_id}>
                <span class="dot unk" />
                <div class="grow"><div class="title">{u.long_name ?? u.node_id}</div><div class="meta">{u.node_id} · {ago(u.last_heard)}</div></div>
                <button class="sm" onClick={() => setAdding({ node_id: u.node_id, label: u.long_name ?? '', site: '' })}>claim</button>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {adding && (
        <Modal title="add node" onClose={() => setAdding(null)} footer={<><button onClick={() => setAdding(null)}>cancel</button><button class="primary" onClick={claim}>add</button></>}>
          <form class="form" onSubmit={(e) => { e.preventDefault(); void claim(); }}>
            <Field label="node id" hint="From the Meshtastic app: Settings → node info, looks like !a1b2c3d4">
              <input required value={adding.node_id} onInput={(e) => setAdding({ ...adding, node_id: (e.target as HTMLInputElement).value.trim() })} placeholder="!a1b2c3d4" autocapitalize="off" spellcheck={false} />
            </Field>
            <Field label="label"><input value={adding.label} onInput={(e) => setAdding({ ...adding, label: (e.target as HTMLInputElement).value })} placeholder="Kitchen V4 (gateway)" /></Field>
            <Field label="site"><input value={adding.site} onInput={(e) => setAdding({ ...adding, site: (e.target as HTMLInputElement).value })} placeholder="Home / Cabin / Car" /></Field>
          </form>
        </Modal>
      )}
    </>
  );
}

function NodeDetail({ n, onChanged }: { n: MeshNode; onChanged: () => void }) {
  const { canWrite, toast } = useApp();
  const tel = useFetch<{ at: number; battery: number | null; voltage: number | null; ch_util: number | null; air_util: number | null; snr: number | null }[]>(`/api/mesh/nodes/${n.id}/telemetry?hours=48`);
  const [label, setLabel] = useState(n.label);
  const [site, setSite] = useState(n.site);
  const t = tel.data ?? [];

  const save = async () => { try { await api.patch(`/api/mesh/nodes/${n.id}`, { label, site }); toast('Saved'); onChanged(); } catch (e) { toast((e as Error).message, 'error'); } };
  const remove = async () => {
    if (!confirm(`Remove ${nodeName(n)}? Its history is deleted.`)) return;
    try { await api.del(`/api/mesh/nodes/${n.id}`); onChanged(); } catch (e) { toast((e as Error).message, 'error'); }
  };

  return (
    <div style="padding:10px 0 4px 20px">
      <pre class="mono-pre small">{[
        `battery   ${n.battery == null ? '—' : n.battery > 100 ? 'powered (USB)' : `${Math.round(n.battery)}%`}  ${n.voltage != null ? `${n.voltage.toFixed(2)}V` : ''}`,
        `chan util ${n.ch_util?.toFixed(1) ?? '—'}%   air tx ${n.air_util?.toFixed(2) ?? '—'}%`,
        `signal    snr ${n.snr ?? '—'} dB  rssi ${n.rssi ?? '—'} dBm  hops ${n.hops_away ?? '—'}`,
        `uptime    ${uptime(n.uptime)}   temp ${n.temperature != null ? `${n.temperature.toFixed(1)}°C` : '—'}`,
        `via       ${n.via_gateway ?? '—'}`,
        `position  ${n.lat != null ? `${n.lat.toFixed(4)}, ${n.lon!.toFixed(4)}` : '—'}`,
      ].join('\n')}</pre>
      {n.battery != null && n.battery <= 100 && <p style="margin:6px 0"><AsciiBar value={n.battery / 100} width={20} /></p>}
      <div class="grid c2" style="gap:6px;margin:8px 0">
        <div class="small"><span class="muted">battery 48h</span><br /><Sparkline values={t.map((x) => x.battery)} width={220} label="battery trend" /></div>
        <div class="small"><span class="muted">channel util 48h</span><br /><Sparkline values={t.map((x) => x.ch_util)} width={220} color="var(--amber)" label="channel utilization trend" /></div>
      </div>
      {n.lat != null && <a class="small" href={`https://www.openstreetmap.org/?mlat=${n.lat}&mlon=${n.lon}#map=14/${n.lat}/${n.lon}`} target="_blank" rel="noreferrer">open map ↗</a>}
      {canWrite && (
        <div class="form" style="margin-top:10px">
          <div class="row">
            <Field label="label"><input value={label} onInput={(e) => setLabel((e.target as HTMLInputElement).value)} /></Field>
            <Field label="site"><input value={site} onInput={(e) => setSite((e.target as HTMLInputElement).value)} /></Field>
          </div>
          <div class="toolbar"><button class="danger sm" onClick={remove}>remove</button><button class="sm" onClick={save}>save</button></div>
        </div>
      )}
    </div>
  );
}
