import { useState } from 'preact/hooks';
import { api } from '../api';
import { Empty, Field, Loading, Modal, Panel, relDays, useApp, useFetch } from '../components/ui';
import type { DeviceDraft, Kind } from '../data/devices';

export { guessDevice, type DeviceDraft, type Kind } from '../data/devices';

// ---------------- types ----------------
interface Task { id: number; equipment_id: number; label: string; every_days: number; last_done_on: string | null; next_due_on: string; notes: string; days_until: number; state: 'due' | 'soon' | 'ok' }
interface Equipment {
  id: number; name: string; kind: Kind; brand: string; model: string; capacity_wh: number | null; capacity_mah: number | null; output_w: number | null;
  fuel: string; location: string; serial: string; purchased_on: string | null; charge_pct: number | null; run_hours: number | null; notes: string;
  tasks: Task[]; last_done_on: string | null;
}
interface Overview {
  today: string;
  summary: { count: number; due: (Task & { equipment_name: string })[]; soon: (Task & { equipment_name: string })[] };
  equipment: Equipment[];
  options: { kinds: Kind[]; suggestions: Record<Kind, { label: string; every_days: number }[]>; defaultEveryDays: number };
}
interface TaskDraft { id?: number; label: string; every_days: number; next_due_on: string; last_done_on: string | null }

export const KIND_LABEL: Record<Kind, string> = {
  power_bank: 'power bank', power_station: 'power station', ups: 'battery backup (UPS)', generator: 'generator', solar: 'solar panel', battery: 'rechargeable batteries / bank', other: 'other',
};
const KIND_ICON: Record<Kind, string> = { power_bank: '▮', power_station: '▣', ups: '◧', generator: '⚙', solar: '☀', battery: '▤', other: '·' };
const INTERVALS: [string, number][] = [['1 mo', 30], ['3 mo', 90], ['6 mo', 180], ['1 yr', 365]];
const FUELS = ['gasoline', 'propane', 'dual fuel', 'diesel', 'natural gas', 'solar'];
const usesFuel = (k: Kind) => k === 'generator';
const holdsCharge = (k: Kind) => k !== 'generator' && k !== 'solar' && k !== 'other';

const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const num = (e: Event) => { const v = (e.target as HTMLInputElement).value; return v === '' ? null : Number(v); };
const txt = (e: Event) => (e.target as HTMLInputElement).value;
const every = (n: number) => (n % 365 === 0 ? `${n / 365} yr` : n % 30 === 0 ? `${n / 30} mo` : `${n} d`);

function specs(e: Equipment) {
  return [
    KIND_LABEL[e.kind],
    [e.brand, e.model].filter(Boolean).join(' '),
    e.capacity_wh ? `${e.capacity_wh.toLocaleString()} Wh` : e.capacity_mah ? `${e.capacity_mah.toLocaleString()} mAh` : '',
    e.output_w ? `${e.output_w.toLocaleString()} W` : '',
    e.fuel,
    e.location,
  ].filter(Boolean).join(' · ');
}

/** What goes in the power tab, and the reminder each kind gets. Devices get upkeep reminders; supplies get an expiry date. */
const DEVICE_CHOICES: { kind: Kind; title: string; meta: string }[] = [
  { kind: 'power_bank', title: 'Power bank / portable charger', meta: 'phone chargers, jump starters · reminder to top up the charge' },
  { kind: 'power_station', title: 'Power station', meta: 'EcoFlow, Jackery, Bluetti · reminder to charge and test the outlets' },
  { kind: 'ups', title: 'Battery backup (UPS)', meta: 'reminder to run a self-test, and to replace the battery' },
  { kind: 'generator', title: 'Generator', meta: 'reminder to run it under load, refresh fuel, change oil' },
  { kind: 'battery', title: 'Rechargeable batteries / battery bank', meta: 'Eneloop, 18650, LiFePO4 · reminder to check and top up the charge' },
  { kind: 'solar', title: 'Solar panel', meta: 'reminder to clean the panels and check cables' },
];
export type SupplyKind = 'batteries' | 'fuel' | 'other';
const SUPPLY_CHOICES: { kind: SupplyKind; title: string; meta: string }[] = [
  { kind: 'batteries', title: 'Disposable batteries', meta: 'AA, AAA, 9V, coin cells · tracked by expiry date' },
  { kind: 'fuel', title: 'Fuel', meta: 'gasoline, propane, stabilizer · tracked by use-by date' },
  { kind: 'other', title: 'Other supplies', meta: 'candles, lanterns, matches' },
];

/** "What are you adding?" Devices open the device form; batteries and fuel open the supplies form. */
export function PowerChooser({ onDevice, onSupply, onClose }: { onDevice: (d: DeviceDraft) => void; onSupply: (k: SupplyKind) => void; onClose: () => void }) {
  const row = (key: string, title: string, meta: string, go: () => void) => (
    <li key={key}><button class="rowbtn ghost" onClick={go}><div class="title">{title}</div><div class="meta">{meta}</div></button></li>
  );
  return (
    <Modal title="add power" onClose={onClose}>
      <h3 class="section-h" style="margin-top:0">devices · upkeep reminders</h3>
      <ul class="list">{DEVICE_CHOICES.map((c) => row(c.kind, c.title, c.meta, () => onDevice({ kind: c.kind })))}</ul>
      <h3 class="section-h">supplies · expiry dates</h3>
      <ul class="list">{SUPPLY_CHOICES.map((c) => row(c.kind, c.title, c.meta, () => onSupply(c.kind)))}</ul>
    </Modal>
  );
}

/** `add` opens the device form for a new device (owned by the inventory tab, which also has the chooser). */
export function Power({ add, onAdd, onAddClose }: { add: DeviceDraft | null; onAdd: () => void; onAddClose: () => void }) {
  const { me, canWrite } = useApp();
  const { data, error, reload } = useFetch<Overview>('/api/power', [me.active?.id]);
  const [editing, setEditing] = useState<Equipment | null>(null);
  const [doing, setDoing] = useState<{ task: Task; eq: Equipment } | null>(null);
  if (!data) return <Loading error={error} />;
  const s = data.summary;
  const next = data.equipment.flatMap((e) => e.tasks.map((t) => ({ e, t }))).sort((a, b) => a.t.next_due_on.localeCompare(b.t.next_due_on))[0];

  return (
    <>
      <div class="grid stats" style="margin-bottom:14px">
        <div class="stat green"><div class="k">devices</div><div class="v">{s.count}</div><div class="n">chargers, backups, generators</div></div>
        <div class={`stat ${s.due.length ? 'red' : 'green'}`}><div class="k">due now</div><div class="v">{s.due.length}</div><div class="n">{s.due.map((t) => t.equipment_name).join(', ') || 'all charged up'}</div></div>
        <div class={`stat ${s.soon.length ? 'amber' : 'green'}`}><div class="k">this week</div><div class="v">{s.soon.length}</div><div class="n">{s.soon.map((t) => t.equipment_name).join(', ') || 'nothing coming up'}</div></div>
        <div class="stat cyan"><div class="k">next up</div><div class="v">{next ? relDays(next.t.next_due_on, data.today) : '—'}</div><div class="n">{next ? `${next.e.name}: ${next.t.label}` : 'no reminders set'}</div></div>
      </div>

      <Panel title="power equipment" right={canWrite && <button class="sm" onClick={onAdd}>add device</button>} flush>
        {data.equipment.length === 0 ? (
          <Empty>No power equipment yet. Add power banks, battery backups and generators to get charge and maintenance reminders.</Empty>
        ) : (
          <ul class="list">
            {data.equipment.map((e) => (
              <li key={e.id} style="align-items:flex-start">
                <span aria-hidden="true" class="muted" style="width:1.2em;text-align:center">{KIND_ICON[e.kind]}</span>
                <div class="grow" style="min-width:0">
                  <button class="rowbtn ghost" style="padding:0" onClick={() => setEditing(e)} aria-label={`Edit ${e.name}`}>
                    <div class="title">{e.name}{e.charge_pct != null && <span class={e.charge_pct < 40 ? 'warn' : 'muted'}> · {e.charge_pct}%</span>}{e.run_hours != null && <span class="muted"> · {e.run_hours} h</span>}</div>
                    <div class="meta">{specs(e)}</div>
                  </button>
                  {e.tasks.length === 0 && <div class="small muted">no reminders</div>}
                  {e.tasks.map((t) => (
                    <div key={t.id} class="toolbar" style="margin:6px 0 0;gap:8px">
                      <span class="grow small">
                        {t.label} <span class="muted">· every {every(t.every_days)}</span>
                        <span class={t.state === 'due' ? 't-expired' : t.state === 'soon' ? 't-soon' : 'muted'}> · {t.state === 'due' ? (t.days_until === 0 ? 'due today' : `overdue ${-t.days_until}d`) : `due ${relDays(t.next_due_on, data.today)}`}</span>
                      </span>
                      {canWrite && <button class={`sm${t.state === 'due' ? ' primary' : ''}`} onClick={() => setDoing({ task: t, eq: e })} aria-label={`Mark ${t.label} done for ${e.name}`}>✓ done</button>}
                    </div>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <p class="muted small">Lithium packs lose charge sitting on a shelf, and generators that never run won’t start when you need them. Due reminders show on the dashboard and in the daily digest.</p>

      {editing && <EquipmentModal eq={editing} options={data.options} today={data.today} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void reload(); }} />}
      {add && <EquipmentModal eq={null} draft={add} options={data.options} today={data.today} onClose={onAddClose} onSaved={() => { onAddClose(); void reload(); }} />}
      {doing && <DoneModal task={doing.task} eq={doing.eq} today={data.today} onClose={() => setDoing(null)} onSaved={() => { setDoing(null); void reload(); }} />}
    </>
  );
}

// ---------------- mark done ----------------
function DoneModal({ task, eq, today, onClose, onSaved }: { task: Task; eq: Equipment; today: string; onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp();
  const [v, setV] = useState({ done_on: today, charge_pct: holdsCharge(eq.kind) ? 100 : null as number | null, run_hours: eq.run_hours, note: '' });
  const [busy, setBusy] = useState(false);
  const save = async (e?: Event) => {
    e?.preventDefault(); setBusy(true);
    try {
      const r = await api.post<{ next_due_on: string }>(`/api/power/tasks/${task.id}/done`, { ...v, run_hours: usesFuel(eq.kind) ? v.run_hours : null });
      toast(`${task.label}: next due ${r.next_due_on}`); onSaved();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal title={`${eq.name}: ${task.label}`} onClose={onClose} footer={<><span style="flex:1" /><button onClick={onClose}>cancel</button><button class="primary" disabled={busy} onClick={() => save()}>mark done</button></>}>
      <form class="form" onSubmit={save}>
        <div class="row">
          <Field label="done on"><input type="date" max={today} required value={v.done_on} onInput={(e) => setV({ ...v, done_on: txt(e) })} /></Field>
          {holdsCharge(eq.kind) && <Field label="charge now (%)"><input type="number" min="0" max="100" inputMode="numeric" value={v.charge_pct ?? ''} onInput={(e) => setV({ ...v, charge_pct: num(e) })} /></Field>}
          {usesFuel(eq.kind) && <Field label="hour meter"><input type="number" min="0" step="0.1" inputMode="decimal" value={v.run_hours ?? ''} onInput={(e) => setV({ ...v, run_hours: num(e) })} /></Field>}
        </div>
        <Field label="note (optional)"><input value={v.note} placeholder={usesFuel(eq.kind) ? 'ran 25 min on the space heater' : ''} onInput={(e) => setV({ ...v, note: txt(e) })} /></Field>
        <p class="muted small">Next reminder: <strong>{addDays(v.done_on || today, task.every_days)}</strong> (every {every(task.every_days)}).</p>
        <button type="submit" class="sr-only">save</button>
      </form>
    </Modal>
  );
}

// ---------------- add / edit ----------------
function EquipmentModal({ eq, draft, options, today, onClose, onSaved }: { eq: Equipment | null; draft?: DeviceDraft; options: Overview['options']; today: string; onClose: () => void; onSaved: () => void }) {
  const { toast, canWrite } = useApp();
  const firstTask = (k: Kind): TaskDraft => { const sg = options.suggestions[k][0]; return { label: sg.label, every_days: sg.every_days, next_due_on: addDays(today, sg.every_days), last_done_on: null }; };
  const [v, setV] = useState({
    name: eq?.name ?? draft?.name ?? '', kind: eq?.kind ?? draft?.kind ?? 'power_bank' as Kind, brand: eq?.brand ?? '', model: eq?.model ?? '',
    capacity_wh: eq?.capacity_wh ?? null, capacity_mah: eq?.capacity_mah ?? draft?.capacity_mah ?? null, output_w: eq?.output_w ?? null, fuel: eq?.fuel ?? '',
    location: eq?.location ?? draft?.location ?? '', serial: eq?.serial ?? '', purchased_on: eq?.purchased_on ?? null, charge_pct: eq?.charge_pct ?? null,
    run_hours: eq?.run_hours ?? null, notes: eq?.notes ?? '',
  });
  const [tasks, setTasks] = useState<TaskDraft[]>(eq ? eq.tasks.map((t) => ({ id: t.id, label: t.label, every_days: t.every_days, next_due_on: t.next_due_on, last_done_on: t.last_done_on })) : [firstTask(draft?.kind ?? 'power_bank')]);
  const [removed, setRemoved] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof v>(k: K, val: (typeof v)[K]) => setV({ ...v, [k]: val });

  const changeKind = (k: Kind) => {
    setV({ ...v, kind: k, fuel: usesFuel(k) ? v.fuel : '' });
    // A new device's untouched default reminder follows the type.
    if (!eq && tasks.length === 1 && !tasks[0].id && Object.values(options.suggestions).some((l) => l[0].label === tasks[0].label)) setTasks([firstTask(k)]);
  };
  const setTask = (i: number, patch: Partial<TaskDraft>) => setTasks(tasks.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  // Picking an interval re-suggests the date: last done (or today) + interval. The date stays editable.
  const setEvery = (i: number, n: number) => setTask(i, { every_days: n, next_due_on: addDays(tasks[i].last_done_on ?? today, n) });
  const extras = options.suggestions[v.kind].filter((sg) => !tasks.some((t) => t.label === sg.label));

  const save = async (e?: Event) => {
    e?.preventDefault();
    if (!v.name.trim()) { toast('Give it a name', 'error'); return; }
    setBusy(true);
    try {
      const body = { ...v, purchased_on: v.purchased_on || null };
      if (!eq) {
        await api.post('/api/power', { ...body, tasks: tasks.map(({ label, every_days, next_due_on, last_done_on }) => ({ label, every_days, next_due_on, last_done_on })) });
      } else {
        await api.patch(`/api/power/${eq.id}`, body);
        for (const id of removed) await api.del(`/api/power/tasks/${id}`);
        for (const t of tasks) {
          const payload = { label: t.label, every_days: t.every_days, next_due_on: t.next_due_on, last_done_on: t.last_done_on };
          if (t.id) await api.patch(`/api/power/tasks/${t.id}`, payload); else await api.post(`/api/power/${eq.id}/tasks`, payload);
        }
      }
      toast(eq ? 'Saved' : `Added ${v.name}`); onSaved();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const del = async () => {
    if (!eq || !confirm(`Delete ${eq.name} and its reminders?`)) return;
    try { await api.del(`/api/power/${eq.id}`); toast('Deleted'); onSaved(); } catch (err) { toast((err as Error).message, 'error'); }
  };

  return (
    <Modal title={eq ? eq.name : `add ${KIND_LABEL[v.kind]}`} onClose={onClose} footer={canWrite && (
      <>{eq && <button class="danger" onClick={del}>delete</button>}<span style="flex:1" /><button onClick={onClose}>cancel</button><button class="primary" disabled={busy} onClick={() => save()}>save</button></>
    )}>
      <form class="form" onSubmit={save}>
        <fieldset disabled={!canWrite} style="border:0;padding:0;margin:0" class="form">
          <Field label="type">
            <select value={v.kind} onChange={(e) => changeKind((e.target as HTMLSelectElement).value as Kind)}>
              {options.kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
          </Field>
          <Field label="name"><input required value={v.name} placeholder={v.kind === 'generator' ? 'Garage generator' : v.kind === 'ups' ? 'Office UPS' : 'Anker 20K (red)'} onInput={(e) => set('name', txt(e))} /></Field>
          <div class="row">
            <Field label="brand"><input value={v.brand} placeholder={v.kind === 'generator' ? 'Champion' : 'EcoFlow'} onInput={(e) => set('brand', txt(e))} /></Field>
            <Field label="model"><input value={v.model} onInput={(e) => set('model', txt(e))} /></Field>
          </div>
          <div class="row r3">
            {v.kind === 'power_bank'
              ? <Field label="capacity (mAh)"><input type="number" min="0" inputMode="numeric" value={v.capacity_mah ?? ''} onInput={(e) => set('capacity_mah', num(e))} /></Field>
              : v.kind !== 'generator' && <Field label="capacity (Wh)"><input type="number" min="0" inputMode="numeric" value={v.capacity_wh ?? ''} onInput={(e) => set('capacity_wh', num(e))} /></Field>}
            <Field label={v.kind === 'generator' ? 'running watts' : 'output (W)'}><input type="number" min="0" inputMode="numeric" value={v.output_w ?? ''} onInput={(e) => set('output_w', num(e))} /></Field>
            {usesFuel(v.kind)
              ? <Field label="fuel"><input list="dl-fuels" value={v.fuel} onInput={(e) => set('fuel', txt(e))} /></Field>
              : holdsCharge(v.kind) && <Field label="charge (%)"><input type="number" min="0" max="100" inputMode="numeric" value={v.charge_pct ?? ''} onInput={(e) => set('charge_pct', num(e))} /></Field>}
          </div>
          <div class="row">
            <Field label="location"><input value={v.location} placeholder="Hall closet" onInput={(e) => set('location', txt(e))} /></Field>
            {usesFuel(v.kind)
              ? <Field label="hour meter"><input type="number" min="0" step="0.1" inputMode="decimal" value={v.run_hours ?? ''} onInput={(e) => set('run_hours', num(e))} /></Field>
              : <Field label="purchased"><input type="date" value={v.purchased_on ?? ''} onInput={(e) => set('purchased_on', txt(e) || null)} /></Field>}
          </div>

          <div class="panel">
            <div class="ph"><span>reminders</span></div>
            <div class="pb form">
              {tasks.length === 0 && <p class="muted small">No reminders. Add one below.</p>}
              {tasks.map((t, i) => (
                <div key={t.id ?? `n${i}`} class="form" style="gap:8px;padding-bottom:10px;border-bottom:1px dashed var(--line)">
                  <div style="display:flex;gap:8px;align-items:center">
                    <input style="flex:1;min-width:0" value={t.label} aria-label="Reminder" onInput={(e) => setTask(i, { label: txt(e) })} />
                    <button type="button" class="sm ghost" aria-label={`Remove ${t.label}`} onClick={() => { if (t.id) setRemoved([...removed, t.id]); setTasks(tasks.filter((_, j) => j !== i)); }}>✕</button>
                  </div>
                  <div class="chips" aria-label="Repeat every">
                    {INTERVALS.map(([l, n]) => <button type="button" key={l} class="chip" aria-pressed={t.every_days === n} onClick={() => setEvery(i, n)}>{l}</button>)}
                  </div>
                  <div class="row">
                    <Field label="every (days)"><input type="number" min="1" max="3650" inputMode="numeric" value={t.every_days} onInput={(e) => { const n = num(e); if (n && n > 0) setEvery(i, n); }} /></Field>
                    <Field label="next reminder" hint={`suggested: ${addDays(t.last_done_on ?? today, t.every_days)}`}><input type="date" required value={t.next_due_on} onInput={(e) => setTask(i, { next_due_on: txt(e) })} /></Field>
                  </div>
                </div>
              ))}
              <div class="chips">
                {extras.map((sg) => <button type="button" key={sg.label} class="chip" onClick={() => setTasks([...tasks, { label: sg.label, every_days: sg.every_days, next_due_on: addDays(today, sg.every_days), last_done_on: null }])}>+ {sg.label}</button>)}
                <button type="button" class="chip" onClick={() => setTasks([...tasks, { label: 'Check and maintain', every_days: options.defaultEveryDays, next_due_on: addDays(today, options.defaultEveryDays), last_done_on: null }])}>+ custom</button>
              </div>
            </div>
          </div>
          <Field label="notes"><textarea value={v.notes} placeholder={usesFuel(v.kind) ? 'oil 10W-30, 0.6 qt · plug RC12YC' : ''} onInput={(e) => set('notes', (e.target as HTMLTextAreaElement).value)} /></Field>
        </fieldset>
        <datalist id="dl-fuels">{FUELS.map((f) => <option key={f} value={f} />)}</datalist>
        <button type="submit" class="sr-only">save</button>
      </form>
      {eq && <History id={eq.id} />}
    </Modal>
  );
}

function History({ id }: { id: number }) {
  const { data } = useFetch<{ id: number; task_label: string; done_on: string; charge_pct: number | null; run_hours: number | null; note: string }[]>(`/api/power/${id}/log`);
  if (!data?.length) return null;
  return (
    <details style="margin-top:10px"><summary class="muted small">history ({data.length})</summary>
      {data.map((l) => <div key={l.id} class="small muted">{l.done_on} · {l.task_label}{l.charge_pct != null ? ` · ${l.charge_pct}%` : ''}{l.run_hours != null ? ` · ${l.run_hours} h` : ''}{l.note ? ` · ${l.note}` : ''}</div>)}
    </details>
  );
}
