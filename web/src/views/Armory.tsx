import { useRef, useState } from 'preact/hooks';
import { api } from '../api';
import { navigate } from '../router';
import { Empty, Field, Loading, Modal, Panel, Prompt, relDays, useApp, useFetch } from '../components/ui';
import { beep, useScanner } from '../components/scanner';

// ---------------- types ----------------
interface Firearm {
  id: number; name: string; make: string; model: string; variant: string; type: string; action: string; caliber: string;
  barrel_in: number | null; capacity: number | null; serial: string; serial_masked: string; acquired_on: string | null; price: number | null;
  condition: string; location: string; round_count: number; rounds_since_clean: number; clean_every: number | null; last_cleaned: string | null;
  status: string; notes: string; label: string; caliber_label: string; caliber_key: string; accepts: string[]; cleaning_due: boolean; part_count?: number;
}
interface Ammo {
  id: number; caliber: string; caliber_key: string; caliber_label: string; brand: string; line: string; grain: number | null; bullet: string;
  purpose: string; rounds: number; min_rounds: number | null; location: string; barcode: string | null; lot: string; price_per_round: number | null; notes: string; label: string;
}
interface Part { id: number; firearm_id: number | null; firearm_label: string | null; category: string; make: string; model: string; qty: number; serial: string; installed_on: string | null; price: number | null; notes: string }
interface Session { id: number; firearm_id: number | null; firearm_label: string; ammo_label: string; rounds: number; on_date: string; notes: string }
interface Overview {
  today: string;
  summary: { calibers: { key: string; label: string; rounds: number; min: number | null; lots: number }[]; lowAmmo: { key: string; label: string; rounds: number; min: number }[]; cleaningDue: { id: number; label: string; since: number }[]; firearmCount: number; totalRounds: number };
  firearms: Firearm[]; ammo: Ammo[]; parts: Part[]; sessions: Session[];
  options: { calibers: { key: string; label: string; kind: string }[]; types: string[]; partCategories: string[]; purposes: string[] };
}

const TABS = ['firearms', 'ammo', 'parts', 'range'] as const;
const ACTIONS = ['semi-auto', 'bolt', 'pump', 'lever', 'revolver', 'break', 'single-shot', 'select-fire'];
const BULLETS = ['FMJ', 'JHP', 'SP', 'OTM', 'HPBT', 'TMJ', 'LRN', 'buckshot', 'slug', 'birdshot', 'frangible'];
const num = (e: Event) => { const v = (e.target as HTMLInputElement).value; return v === '' ? null : Number(v); };
const txt = (e: Event) => (e.target as HTMLInputElement).value;
const money = (n: number | null) => (n == null ? '—' : `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);

export function Armory({ tab = 'firearms' }: { tab?: string }) {
  const { me, canWrite } = useApp();
  const { data, error, reload } = useFetch<Overview>('/api/armory', [me.active?.id]);
  const [openFirearm, setOpenFirearm] = useState<number | null>(null);
  const [adding, setAdding] = useState<'firearm' | 'ammo' | 'part' | 'session' | null>(null);

  if (!me.armoryVisible) return <><Prompt title="armory" /><p class="muted">The armory is turned off or hidden for your account in this household. An owner can change it in Settings → armory.</p></>;
  if (!data) return <><Prompt title="armory" /><Loading error={error} /></>;
  const s = data.summary;
  const roundsFor = (f: Firearm) => data.ammo.filter((a) => f.accepts.includes(a.caliber_key)).reduce((n, a) => n + a.rounds, 0);

  return (
    <>
      <Prompt title="armory" sub={`${s.firearmCount} firearms · ${s.totalRounds.toLocaleString()} rounds`}>
        {canWrite && <a class="btn sm" href="/api/armory/export.csv" download>records csv</a>}
        {canWrite && <button class="primary" onClick={() => setAdding(tab === 'ammo' ? 'ammo' : tab === 'parts' ? 'part' : tab === 'range' ? 'session' : 'firearm')}>
          {tab === 'ammo' ? 'add ammo' : tab === 'parts' ? 'add part' : tab === 'range' ? 'log session' : 'add firearm'}
        </button>}
      </Prompt>

      <div class="grid stats" style="margin-bottom:14px">
        <div class="stat green"><div class="k">firearms</div><div class="v">{s.firearmCount}</div><div class="n">active + stored</div></div>
        <div class="stat cyan"><div class="k">rounds</div><div class="v">{s.totalRounds.toLocaleString()}</div><div class="n">{s.calibers.length} calibers</div></div>
        <div class={`stat ${s.lowAmmo.length ? 'amber' : 'green'}`}><div class="k">low ammo</div><div class="v">{s.lowAmmo.length}</div><div class="n">{s.lowAmmo.map((c) => c.label).join(', ') || 'none below minimum'}</div></div>
        <div class={`stat ${s.cleaningDue.length ? 'amber' : 'green'}`}><div class="k">cleaning due</div><div class="v">{s.cleaningDue.length}</div><div class="n">{s.cleaningDue.map((c) => c.label).join(', ') || 'all clean'}</div></div>
      </div>

      <div class="chips" role="tablist" style="margin-bottom:14px">
        {TABS.map((t) => <button key={t} role="tab" class="chip" aria-selected={tab === t} aria-pressed={tab === t} onClick={() => navigate(`/armory/${t}`)}>{t}</button>)}
      </div>

      {tab === 'firearms' && (
        <Panel title="firearms" flush>
          {data.firearms.length === 0 ? <Empty>no firearms recorded</Empty> : (
            <ul class="list">
              {data.firearms.map((f) => (
                <li key={f.id} style={f.status === 'sold' || f.status === 'transferred' ? 'opacity:.5' : ''}>
                  <button class="rowbtn ghost" onClick={() => setOpenFirearm(f.id)} aria-label={`Open ${f.label}`}>
                    <div class="title">{f.label}{f.name && <span class="muted"> · {f.make} {f.model}</span>}</div>
                    <div class="meta">{f.caliber_label} · {f.type}{f.action ? ` · ${f.action}` : ''} · {f.round_count.toLocaleString()} rds fired · {roundsFor(f).toLocaleString()} rds on hand{f.part_count ? ` · ${f.part_count} mods` : ''}</div>
                  </button>
                  {f.cleaning_due && <span class="badge t-soon">CLEAN</span>}
                  {f.status !== 'active' && <span class="badge t-none">{f.status}</span>}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}
      {tab === 'ammo' && <AmmoTab data={data} reload={reload} />}
      {tab === 'parts' && <PartsTab data={data} reload={reload} />}
      {tab === 'range' && <RangeTab data={data} reload={reload} onLog={() => setAdding('session')} />}

      {openFirearm != null && <FirearmModal id={openFirearm} data={data} onClose={() => setOpenFirearm(null)} onChanged={reload} />}
      {adding === 'firearm' && <FirearmForm data={data} onClose={() => setAdding(null)} onSaved={() => { setAdding(null); void reload(); }} />}
      {adding === 'ammo' && <AmmoForm data={data} onClose={() => setAdding(null)} onSaved={() => { setAdding(null); void reload(); }} />}
      {adding === 'part' && <PartForm data={data} onClose={() => setAdding(null)} onSaved={() => { setAdding(null); void reload(); }} />}
      {adding === 'session' && <SessionForm data={data} onClose={() => setAdding(null)} onSaved={() => { setAdding(null); void reload(); }} />}
      <datalist id="dl-calibers">{data.options.calibers.map((c) => <option key={c.key} value={c.label} />)}</datalist>
    </>
  );
}

// ---------------- firearm ----------------
function FirearmForm({ data, initial, onClose, onSaved }: { data: Overview; initial?: Firearm; onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp();
  const [f, setF] = useState<Partial<Firearm>>(initial ?? { type: 'rifle', status: 'active', round_count: 0 });
  const set = <K extends keyof Firearm>(k: K, v: Firearm[K] | null) => setF({ ...f, [k]: v });
  const save = async (e?: Event) => {
    e?.preventDefault();
    const body = {
      name: f.name ?? '', make: f.make ?? '', model: f.model ?? '', variant: f.variant ?? '', type: f.type, action: f.action ?? '', caliber: f.caliber ?? '',
      barrel_in: f.barrel_in ?? null, capacity: f.capacity ?? null, serial: f.serial ?? '', acquired_on: f.acquired_on || null, price: f.price ?? null,
      condition: f.condition ?? '', location: f.location ?? '', round_count: f.round_count ?? 0, clean_every: f.clean_every ?? null, status: f.status, notes: f.notes ?? '',
    };
    try {
      if (initial) await api.patch(`/api/armory/firearms/${initial.id}`, body); else await api.post('/api/armory/firearms', body);
      toast(initial ? 'Saved' : 'Firearm added'); onSaved();
    } catch (err) { toast((err as Error).message, 'error'); }
  };
  return (
    <Modal title={initial ? `edit ${initial.label}` : 'add firearm'} onClose={onClose} footer={<><button onClick={onClose}>cancel</button><button class="primary" onClick={() => save()}>save</button></>}>
      <form class="form" onSubmit={save}>
        <div class="row">
          <Field label="make"><input required value={f.make ?? ''} onInput={(e) => set('make', txt(e))} placeholder="Glock" /></Field>
          <Field label="model"><input required value={f.model ?? ''} onInput={(e) => set('model', txt(e))} placeholder="19" /></Field>
        </div>
        <div class="row">
          <Field label="variant / generation"><input value={f.variant ?? ''} onInput={(e) => set('variant', txt(e))} placeholder="Gen 5 MOS" /></Field>
          <Field label="nickname (optional)"><input value={f.name ?? ''} onInput={(e) => set('name', txt(e))} /></Field>
        </div>
        <div class="row r3">
          <Field label="caliber"><input required list="dl-calibers" value={f.caliber ?? ''} onInput={(e) => set('caliber', txt(e))} placeholder="9mm Luger" /></Field>
          <Field label="type"><select value={f.type} onChange={(e) => set('type', txt(e))}>{data.options.types.map((t) => <option key={t}>{t}</option>)}</select></Field>
          <Field label="action"><input list="dl-actions" value={f.action ?? ''} onInput={(e) => set('action', txt(e))} /></Field>
        </div>
        <datalist id="dl-actions">{ACTIONS.map((a) => <option key={a} value={a} />)}</datalist>
        <div class="row r3">
          <Field label="barrel (in)"><input type="number" step="0.1" min="0" value={f.barrel_in ?? ''} onInput={(e) => set('barrel_in', num(e))} /></Field>
          <Field label="capacity"><input type="number" min="0" value={f.capacity ?? ''} onInput={(e) => set('capacity', num(e))} /></Field>
          <Field label="status"><select value={f.status} onChange={(e) => set('status', txt(e))}>{['active', 'stored', 'sold', 'transferred'].map((t) => <option key={t}>{t}</option>)}</select></Field>
        </div>
        <Field label="serial number" hint="Masked in lists and on viewer accounts. Included in the records CSV for insurance.">
          <input value={f.serial ?? ''} onInput={(e) => set('serial', txt(e))} autocomplete="off" spellcheck={false} autocapitalize="characters" />
        </Field>
        <div class="row r3">
          <Field label="acquired"><input type="date" value={f.acquired_on ?? ''} onInput={(e) => set('acquired_on', txt(e) || null)} /></Field>
          <Field label="price paid"><input type="number" min="0" step="0.01" value={f.price ?? ''} onInput={(e) => set('price', num(e))} /></Field>
          <Field label="condition"><input value={f.condition ?? ''} onInput={(e) => set('condition', txt(e))} placeholder="new / excellent / used" /></Field>
        </div>
        <div class="row r3">
          <Field label="location"><input value={f.location ?? ''} onInput={(e) => set('location', txt(e))} placeholder="Safe A" /></Field>
          <Field label="rounds fired"><input type="number" min="0" value={f.round_count ?? 0} onInput={(e) => set('round_count', num(e) ?? 0)} /></Field>
          <Field label="clean every (rds)"><input type="number" min="1" value={f.clean_every ?? ''} onInput={(e) => set('clean_every', num(e))} placeholder="500" /></Field>
        </div>
        <Field label="notes"><textarea value={f.notes ?? ''} onInput={(e) => set('notes', txt(e))} /></Field>
        <button type="submit" class="sr-only">save</button>
      </form>
    </Modal>
  );
}

interface FirearmDetail { firearm: Firearm; parts: Part[]; ammo: Ammo[]; sessions: Session[]; accepts: string[] }

function FirearmModal({ id, data, onClose, onChanged }: { id: number; data: Overview; onClose: () => void; onChanged: () => void }) {
  const { canWrite, toast } = useApp();
  const d = useFetch<FirearmDetail>(`/api/armory/firearms/${id}`);
  const [reveal, setReveal] = useState(false);
  const [editing, setEditing] = useState(false);
  const [addPart, setAddPart] = useState(false);
  const [logging, setLogging] = useState(false);
  const refresh = () => { void d.reload(); onChanged(); };
  const act = async (fn: () => Promise<unknown>, msg: string) => { try { await fn(); toast(msg); refresh(); } catch (e) { toast((e as Error).message, 'error'); } };
  if (!d.data) return <Modal title="firearm" onClose={onClose}><Loading error={d.error} /></Modal>;
  const { firearm: f, parts, ammo, sessions, accepts } = d.data;
  const onHand = ammo.reduce((n, a) => n + a.rounds, 0);

  return (
    <Modal title={f.label} onClose={onClose} footer={canWrite && (
      <>
        <button class="danger" onClick={() => confirm(`Delete ${f.label}? Its parts become spares; range history keeps its label.`) && act(async () => { await api.del(`/api/armory/firearms/${f.id}`); onClose(); }, 'Deleted')}>delete</button>
        <span style="flex:1" />
        <button onClick={() => setEditing(true)}>edit</button>
        <button class="primary" onClick={() => setLogging(true)}>log session</button>
      </>
    )}>
      <pre class="mono-pre small">{[
        `make/model ${f.make} ${f.model}${f.variant ? ` (${f.variant})` : ''}`,
        `caliber    ${f.caliber_label}${accepts.length > 1 ? `   (also fires: ${accepts.slice(1).join(', ')})` : ''}`,
        `type       ${f.type}${f.action ? ` · ${f.action}` : ''}${f.barrel_in ? ` · ${f.barrel_in}" bbl` : ''}${f.capacity ? ` · ${f.capacity} rd` : ''}`,
        `status     ${f.status}${f.location ? ` · ${f.location}` : ''}${f.condition ? ` · ${f.condition}` : ''}`,
        `acquired   ${f.acquired_on ?? '—'}  ${money(f.price)}`,
        `rounds     ${f.round_count.toLocaleString()} fired · ${f.rounds_since_clean.toLocaleString()} since clean${f.clean_every ? ` / ${f.clean_every}` : ''}`,
        `cleaned    ${f.last_cleaned ?? 'never recorded'}${f.cleaning_due ? '  << DUE' : ''}`,
        `on hand    ${onHand.toLocaleString()} rds compatible`,
      ].join('\n')}</pre>
      <p class="small" style="margin:8px 0">
        serial: <code>{reveal ? f.serial || '—' : f.serial_masked || '—'}</code>{' '}
        {canWrite && f.serial && <button class="sm ghost" onClick={() => setReveal(!reveal)}>{reveal ? 'hide' : 'reveal'}</button>}
      </p>
      {f.notes && <p class="muted small">{f.notes}</p>}
      {canWrite && <div class="toolbar"><button class="sm" onClick={() => act(() => api.post(`/api/armory/firearms/${f.id}/cleaned`, {}), 'Marked cleaned')}># cleaned today</button></div>}

      <h3 class="muted small" style="margin:14px 0 6px">MODIFICATIONS & ACCESSORIES</h3>
      {parts.length === 0 ? <p class="muted small">none recorded</p> : (
        <ul class="list" style="border:1px solid var(--line);border-radius:4px">
          {parts.map((p) => (
            <li key={p.id} class="small">
              <span class="badge t-none">{p.category}</span>
              <div class="grow"><div class="title">{[p.make, p.model].filter(Boolean).join(' ')}{p.qty > 1 ? ` ×${p.qty}` : ''}</div>{(p.installed_on || p.price != null) && <div class="meta">{p.installed_on ?? ''} {p.price != null ? money(p.price) : ''}</div>}</div>
              {canWrite && <button class="sm" title="Move to spares" onClick={() => act(() => api.patch(`/api/armory/parts/${p.id}`, { firearm_id: null }), 'Moved to spares')}>remove</button>}
            </li>
          ))}
        </ul>
      )}
      {canWrite && <button class="sm" style="margin-top:8px" onClick={() => setAddPart(true)}>+ add modification</button>}

      <h3 class="muted small" style="margin:14px 0 6px">COMPATIBLE AMMO</h3>
      {ammo.length === 0 ? <p class="muted small">none on hand</p> : ammo.map((a) => <div key={a.id} class="small">{a.label} — <strong>{a.rounds.toLocaleString()}</strong> rds{a.location ? ` · ${a.location}` : ''}</div>)}

      {sessions.length > 0 && <>
        <h3 class="muted small" style="margin:14px 0 6px">RECENT RANGE SESSIONS</h3>
        {sessions.slice(0, 8).map((s) => <div key={s.id} class="small">{s.on_date} · {s.rounds} rds{s.ammo_label ? ` · ${s.ammo_label}` : ''}{s.notes ? ` — ${s.notes}` : ''}</div>)}
      </>}

      {editing && <FirearmForm data={data} initial={f} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); refresh(); }} />}
      {addPart && <PartForm data={data} firearmId={f.id} onClose={() => setAddPart(false)} onSaved={() => { setAddPart(false); refresh(); }} />}
      {logging && <SessionForm data={data} firearmId={f.id} onClose={() => setLogging(false)} onSaved={() => { setLogging(false); refresh(); }} />}
    </Modal>
  );
}

// ---------------- ammo ----------------
function AmmoTab({ data, reload }: { data: Overview; reload: () => void }) {
  const { canWrite, toast } = useApp();
  const [editing, setEditing] = useState<Ammo | null>(null);
  const groups = data.summary.calibers.map((c) => ({ ...c, lots: data.ammo.filter((a) => a.caliber_key === c.key) }));
  const adjust = async (a: Ammo, sign: 1 | -1) => {
    const raw = prompt(`${sign > 0 ? 'Add' : 'Remove'} how many rounds of ${a.label}?`, sign > 0 ? '50' : '');
    const n = raw ? parseInt(raw, 10) : NaN;
    if (!Number.isFinite(n) || n <= 0) return;
    try { const r = await api.post(`/api/armory/ammo/${a.id}/adjust`, { delta: sign * n }); toast(`${a.label}: ${r.rounds.toLocaleString()} rds`); reload(); }
    catch (e) { toast((e as Error).message, 'error'); }
  };
  if (groups.length === 0) return <Panel title="ammunition"><Empty>no ammunition recorded</Empty></Panel>;
  return (
    <>
      {groups.map((g) => (
        <Panel key={g.key} title={g.label} right={<span class={g.min != null && g.rounds < g.min ? 'warn' : ''}>{g.rounds.toLocaleString()} rds{g.min != null ? ` / min ${g.min.toLocaleString()}` : ''}</span>} flush>
          <ul class="list">
            {g.lots.map((a) => (
              <li key={a.id}>
                <button class="rowbtn ghost" onClick={() => canWrite && setEditing(a)} aria-label={`Edit ${a.label}`}>
                  <div class="title">{[a.brand, a.line].filter(Boolean).join(' ') || 'unbranded'}{a.grain ? ` ${a.grain}gr` : ''}{a.bullet ? ` ${a.bullet}` : ''}</div>
                  <div class="meta"><strong style="color:var(--text)">{a.rounds.toLocaleString()} rds</strong> · {a.purpose}{a.location ? ` · ${a.location}` : ''}{a.price_per_round != null ? ` · ${money(a.price_per_round)}/rd` : ''}</div>
                </button>
                {canWrite && <><button class="sm" onClick={() => adjust(a, -1)} aria-label={`Remove rounds from ${a.label}`}>−</button><button class="sm" onClick={() => adjust(a, 1)} aria-label={`Add rounds to ${a.label}`}>+</button></>}
              </li>
            ))}
          </ul>
        </Panel>
      ))}
      {editing && <AmmoForm data={data} initial={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </>
  );
}

function AmmoForm({ data, initial, onClose, onSaved }: { data: Overview; initial?: Ammo; onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp();
  const [a, setA] = useState<Partial<Ammo>>(initial ?? { purpose: 'range', rounds: 50 });
  const [scanning, setScanning] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const set = <K extends keyof Ammo>(k: K, v: Ammo[K] | null) => setA((cur) => ({ ...cur, [k]: v }));

  const onCode = async (upc: string) => {
    setScanning(false); beep();
    try {
      const r = await api.get<{ match: Ammo | null }>(`/api/armory/ammo/barcode/${upc}`);
      if (r.match) {
        const m = r.match;
        setA((cur) => ({ ...cur, barcode: upc, caliber: m.caliber, brand: m.brand, line: m.line, grain: m.grain, bullet: m.bullet, purpose: m.purpose, location: cur.location || m.location }));
        toast(`Known box: ${m.label}`);
      } else { set('barcode', upc); toast('New barcode — fill it in once and it will be remembered'); }
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const { error } = useScanner(video, scanning, onCode);

  const save = async (e?: Event) => {
    e?.preventDefault();
    const body = {
      caliber: a.caliber ?? '', brand: a.brand ?? '', line: a.line ?? '', grain: a.grain ?? null, bullet: a.bullet ?? '', purpose: a.purpose,
      rounds: a.rounds ?? 0, min_rounds: a.min_rounds ?? null, location: a.location ?? '', barcode: a.barcode || null, lot: a.lot ?? '',
      price_per_round: a.price_per_round ?? null, notes: a.notes ?? '',
    };
    try {
      if (initial) await api.patch(`/api/armory/ammo/${initial.id}`, body); else await api.post('/api/armory/ammo', body);
      toast(initial ? 'Saved' : 'Ammo added'); onSaved();
    } catch (err) { toast((err as Error).message, 'error'); }
  };
  const del = async () => {
    if (!initial || !confirm(`Delete ${initial.label}?`)) return;
    try { await api.del(`/api/armory/ammo/${initial.id}`); toast('Deleted'); onSaved(); } catch (err) { toast((err as Error).message, 'error'); }
  };

  return (
    <Modal title={initial ? 'edit ammo' : 'add ammo'} onClose={onClose} footer={<>{initial && <button class="danger" onClick={del}>delete</button>}<span style="flex:1" /><button onClick={onClose}>cancel</button><button class="primary" onClick={() => save()}>save</button></>}>
      <form class="form" onSubmit={save}>
        {!initial && (scanning
          ? <><div class="scanner"><video ref={video} muted playsInline /><div class="reticle" /></div>{error && <p class="err">✗ {error}</p>}<button type="button" onClick={() => setScanning(false)}>stop camera</button></>
          : <button type="button" onClick={() => setScanning(true)}>scan box barcode</button>)}
        <div class="row r3">
          <Field label="caliber"><input required list="dl-calibers" value={a.caliber ?? ''} onInput={(e) => set('caliber', txt(e))} placeholder="9mm Luger" /></Field>
          <Field label="rounds"><input type="number" min="0" required value={a.rounds ?? 0} onInput={(e) => set('rounds', num(e) ?? 0)} /></Field>
          <Field label="purpose"><select value={a.purpose} onChange={(e) => set('purpose', txt(e))}>{data.options.purposes.map((p) => <option key={p}>{p}</option>)}</select></Field>
        </div>
        <div class="row">
          <Field label="brand"><input value={a.brand ?? ''} onInput={(e) => set('brand', txt(e))} placeholder="Federal" /></Field>
          <Field label="product line"><input value={a.line ?? ''} onInput={(e) => set('line', txt(e))} placeholder="American Eagle" /></Field>
        </div>
        <div class="row r3">
          <Field label="grain"><input type="number" min="0" step="any" value={a.grain ?? ''} onInput={(e) => set('grain', num(e))} /></Field>
          <Field label="bullet"><input list="dl-bullets" value={a.bullet ?? ''} onInput={(e) => set('bullet', txt(e))} /></Field>
          <Field label="min rds (alert)"><input type="number" min="0" value={a.min_rounds ?? ''} onInput={(e) => set('min_rounds', num(e))} /></Field>
        </div>
        <datalist id="dl-bullets">{BULLETS.map((b) => <option key={b} value={b} />)}</datalist>
        <div class="row r3">
          <Field label="location"><input value={a.location ?? ''} onInput={(e) => set('location', txt(e))} /></Field>
          <Field label="$ / round"><input type="number" min="0" step="0.01" value={a.price_per_round ?? ''} onInput={(e) => set('price_per_round', num(e))} /></Field>
          <Field label="lot #"><input value={a.lot ?? ''} onInput={(e) => set('lot', txt(e))} /></Field>
        </div>
        {a.barcode && <p class="muted small">barcode {a.barcode}</p>}
        <Field label="notes"><textarea value={a.notes ?? ''} onInput={(e) => set('notes', txt(e))} /></Field>
        <button type="submit" class="sr-only">save</button>
      </form>
    </Modal>
  );
}

// ---------------- parts ----------------
function PartsTab({ data, reload }: { data: Overview; reload: () => void }) {
  const { canWrite, toast } = useApp();
  const [editing, setEditing] = useState<Part | null>(null);
  const spares = data.parts.filter((p) => p.firearm_id == null);
  const installed = data.parts.filter((p) => p.firearm_id != null);
  const row = (p: Part) => (
    <li key={p.id}>
      <span class="badge t-none">{p.category}</span>
      <button class="rowbtn ghost" onClick={() => canWrite && setEditing(p)}>
        <div class="title">{[p.make, p.model].filter(Boolean).join(' ')}{p.qty > 1 ? ` ×${p.qty}` : ''}</div>
        <div class="meta">{p.firearm_label ?? 'spare'}{p.price != null ? ` · ${money(p.price)}` : ''}{p.serial ? ` · s/n ${p.serial}` : ''}</div>
      </button>
    </li>
  );
  return (
    <>
      <Panel title={`installed (${installed.length})`} flush>{installed.length ? <ul class="list">{installed.map(row)}</ul> : <Empty>no modifications recorded</Empty>}</Panel>
      <Panel title={`spares & accessories (${spares.length})`} flush>{spares.length ? <ul class="list">{spares.map(row)}</ul> : <Empty>no spare parts or accessories</Empty>}</Panel>
      {editing && <PartForm data={data} initial={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} onDelete={async () => {
        if (!confirm('Delete this part?')) return;
        try { await api.del(`/api/armory/parts/${editing.id}`); toast('Deleted'); setEditing(null); reload(); } catch (e) { toast((e as Error).message, 'error'); }
      }} />}
    </>
  );
}

function PartForm({ data, firearmId, initial, onClose, onSaved, onDelete }: { data: Overview; firearmId?: number; initial?: Part; onClose: () => void; onSaved: () => void; onDelete?: () => void }) {
  const { toast } = useApp();
  const [p, setP] = useState<Partial<Part>>(initial ?? { category: 'optic', qty: 1, firearm_id: firearmId ?? null });
  const set = <K extends keyof Part>(k: K, v: Part[K] | null) => setP({ ...p, [k]: v });
  const save = async (e?: Event) => {
    e?.preventDefault();
    const body = { firearm_id: p.firearm_id ?? null, category: p.category, make: p.make ?? '', model: p.model ?? '', qty: p.qty ?? 1, installed_on: p.installed_on || null, price: p.price ?? null, notes: p.notes ?? '', ...(initial && p.serial === initial.serial ? {} : { serial: p.serial ?? '' }) };
    try {
      if (initial) await api.patch(`/api/armory/parts/${initial.id}`, body); else await api.post('/api/armory/parts', body);
      toast(initial ? 'Saved' : 'Part added'); onSaved();
    } catch (err) { toast((err as Error).message, 'error'); }
  };
  return (
    <Modal title={initial ? 'edit part' : 'add modification / accessory'} onClose={onClose} footer={<>{onDelete && <button class="danger" onClick={onDelete}>delete</button>}<span style="flex:1" /><button onClick={onClose}>cancel</button><button class="primary" onClick={() => save()}>save</button></>}>
      <form class="form" onSubmit={save}>
        <div class="row">
          <Field label="category"><select value={p.category} onChange={(e) => set('category', txt(e))}>{data.options.partCategories.map((c) => <option key={c}>{c}</option>)}</select></Field>
          <Field label="installed on">
            <select value={p.firearm_id ?? ''} onChange={(e) => set('firearm_id', txt(e) ? Number(txt(e)) : null)}>
              <option value="">— spare / unassigned —</option>
              {data.firearms.filter((f) => f.status === 'active' || f.status === 'stored').map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </Field>
        </div>
        <div class="row">
          <Field label="make"><input value={p.make ?? ''} onInput={(e) => set('make', txt(e))} placeholder="Aimpoint" /></Field>
          <Field label="model"><input required value={p.model ?? ''} onInput={(e) => set('model', txt(e))} placeholder="PRO" /></Field>
        </div>
        <div class="row r3">
          <Field label="qty"><input type="number" min="1" value={p.qty ?? 1} onInput={(e) => set('qty', num(e) ?? 1)} /></Field>
          <Field label="price"><input type="number" min="0" step="0.01" value={p.price ?? ''} onInput={(e) => set('price', num(e))} /></Field>
          <Field label="installed"><input type="date" value={p.installed_on ?? ''} onInput={(e) => set('installed_on', txt(e) || null)} /></Field>
        </div>
        <Field label="serial (optics, suppressors…)" hint={initial?.serial ? 'Leave as-is to keep the stored serial.' : undefined}><input value={p.serial ?? ''} onInput={(e) => set('serial', txt(e))} autocomplete="off" spellcheck={false} /></Field>
        <Field label="notes"><textarea value={p.notes ?? ''} onInput={(e) => set('notes', txt(e))} placeholder="zeroed at 50 yd, battery CR2032 changed…" /></Field>
        <button type="submit" class="sr-only">save</button>
      </form>
    </Modal>
  );
}

// ---------------- range ----------------
function RangeTab({ data, reload, onLog }: { data: Overview; reload: () => void; onLog: () => void }) {
  const { canWrite, toast } = useApp();
  const total = data.sessions.reduce((n, s) => n + s.rounds, 0);
  return (
    <Panel title="range log" right={<span class="muted">{total.toLocaleString()} rds in last {data.sessions.length} sessions</span>} flush>
      {data.sessions.length === 0 ? <Empty>no sessions logged{canWrite && <> — <button class="sm ghost" onClick={onLog}>log one</button></>}</Empty> : (
        <ul class="list">
          {data.sessions.map((s) => (
            <li key={s.id}>
              <div class="grow">
                <div class="title">{s.firearm_label} · {s.rounds} rds</div>
                <div class="meta">{s.on_date} ({relDays(s.on_date, data.today)}){s.ammo_label ? ` · ${s.ammo_label}` : ''}{s.notes ? ` — ${s.notes}` : ''}</div>
              </div>
              {canWrite && <button class="sm" title="Undo: returns rounds to the lot" onClick={async () => {
                if (!confirm('Undo this session? Rounds go back to the ammo lot and come off the round count.')) return;
                try { await api.del(`/api/armory/sessions/${s.id}`); toast('Session undone'); reload(); } catch (e) { toast((e as Error).message, 'error'); }
              }}>undo</button>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function SessionForm({ data, firearmId, onClose, onSaved }: { data: Overview; firearmId?: number; onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp();
  const active = data.firearms.filter((f) => f.status === 'active' || f.status === 'stored');
  const [fid, setFid] = useState<number | null>(firearmId ?? active[0]?.id ?? null);
  const firearm = active.find((f) => f.id === fid);
  const compatible = data.ammo.filter((a) => firearm?.accepts.includes(a.caliber_key) && a.rounds > 0);
  const [ammoId, setAmmoId] = useState<number | null>(compatible[0]?.id ?? null);
  const [rounds, setRounds] = useState(50);
  const [date, setDate] = useState(data.today);
  const [notes, setNotes] = useState('');
  const save = async (e?: Event) => {
    e?.preventDefault();
    if (!fid) return;
    try {
      const r = await api.post('/api/armory/sessions', { firearm_id: fid, ammo_id: ammoId, rounds, on_date: date, notes });
      toast(r.warning ?? `Logged ${rounds} rds`, r.warning ? 'error' : 'ok'); onSaved();
    } catch (err) { toast((err as Error).message, 'error'); }
  };
  if (!active.length) return <Modal title="log session" onClose={onClose}><p class="muted">Add a firearm first.</p></Modal>;
  return (
    <Modal title="log range session" onClose={onClose} footer={<><button onClick={onClose}>cancel</button><button class="primary" onClick={() => save()}>log</button></>}>
      <form class="form" onSubmit={save}>
        <Field label="firearm">
          <select value={fid ?? ''} onChange={(e) => { const id = Number(txt(e)); setFid(id); const f = active.find((x) => x.id === id); setAmmoId(data.ammo.find((a) => f?.accepts.includes(a.caliber_key) && a.rounds > 0)?.id ?? null); }}>
            {active.map((f) => <option key={f.id} value={f.id}>{f.label} ({f.caliber_label})</option>)}
          </select>
        </Field>
        <Field label="ammo used" hint="Rounds are deducted from this lot.">
          <select value={ammoId ?? ''} onChange={(e) => setAmmoId(txt(e) ? Number(txt(e)) : null)}>
            <option value="">— not from inventory —</option>
            {compatible.map((a) => <option key={a.id} value={a.id}>{a.label} ({a.rounds.toLocaleString()} left)</option>)}
          </select>
        </Field>
        <div class="row">
          <Field label="rounds fired"><input type="number" min="1" required value={rounds} onInput={(e) => setRounds(num(e) ?? 0)} /></Field>
          <Field label="date"><input type="date" value={date} onInput={(e) => setDate(txt(e))} /></Field>
        </div>
        <Field label="notes"><input value={notes} onInput={(e) => setNotes(txt(e))} placeholder="zeroed new optic, 2 FTFs with steel case…" /></Field>
        <button type="submit" class="sr-only">log</button>
      </form>
    </Modal>
  );
}

