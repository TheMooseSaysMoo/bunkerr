import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api } from '../api';
import { navigate } from '../router';
import { AsciiBar, Empty, Field, Loading, Modal, Panel, Prompt, copyText, relDays, useApp, useFetch } from '../components/ui';
import type { Garden, GardenTask, Plant, Planting } from '../types';

// ================= list =================
export function Gardens() {
  const { me, canWrite, toast } = useApp();
  const { data, error, reload } = useFetch<Garden[]>('/api/gardens', [me.active?.id]);
  const tasks = useFetch<{ today: string; tasks: GardenTask[] }>('/api/garden/tasks?days=14', [me.active?.id]);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', rows: 4, cols: 8, cell_size_ft: 1 });

  const create = async (e: Event) => {
    e.preventDefault();
    try { const g = await api.post<Garden>('/api/gardens', form); navigate(`/garden/${g.id}`); }
    catch (err) { toast((err as Error).message, 'error'); }
  };

  return (
    <>
      <Prompt title="gardens" sub={data ? `${data.length} beds` : ''}>
        {canWrite && <button class="primary" onClick={() => setCreating(true)}>new garden</button>}
      </Prompt>
      {!data ? <Loading error={error} /> : data.length === 0 ? (
        <Panel title="no gardens"><p class="muted">Create a garden bed, then tap cells to plant. Each cell is a square (default 1 ft — square-foot gardening).</p></Panel>
      ) : (
        <div class="grid c3" style="margin-bottom:14px">
          {data.map((g) => (
            <a key={g.id} class="stat" href={`#/garden/${g.id}`}>
              <div class="k">{g.cols}×{g.rows} · {g.cell_size_ft}ft cells</div>
              <div class="v" style="font-size:1.15rem">{g.name}</div>
              <div class="n">{g.active} active plantings</div>
            </a>
          ))}
        </div>
      )}
      <TaskList data={tasks.data} />
      {creating && (
        <Modal title="new garden" onClose={() => setCreating(false)} footer={<><button onClick={() => setCreating(false)}>cancel</button><button class="primary" onClick={create}>create</button></>}>
          <form class="form" onSubmit={create}>
            <Field label="name"><input required value={form.name} onInput={(e) => setForm({ ...form, name: (e.target as HTMLInputElement).value })} placeholder="Raised bed #1" /></Field>
            <div class="row r3">
              <Field label="columns (wide)"><input type="number" min="1" max="60" value={form.cols} onInput={(e) => setForm({ ...form, cols: Number((e.target as HTMLInputElement).value) })} /></Field>
              <Field label="rows (deep)"><input type="number" min="1" max="60" value={form.rows} onInput={(e) => setForm({ ...form, rows: Number((e.target as HTMLInputElement).value) })} /></Field>
              <Field label="cell size (ft)"><input type="number" min="0.25" max="10" step="0.25" value={form.cell_size_ft} onInput={(e) => setForm({ ...form, cell_size_ft: Number((e.target as HTMLInputElement).value) })} /></Field>
            </div>
            <p class="muted small">{form.cols * form.cell_size_ft} ft × {form.rows * form.cell_size_ft} ft</p>
          </form>
        </Modal>
      )}
    </>
  );
}

function TaskList({ data, gardenId }: { data: { today: string; tasks: GardenTask[] } | null; gardenId?: number }) {
  if (!data) return null;
  const tasks = data.tasks.filter((t) => gardenId == null || t.garden_id === gardenId);
  const label = { water: 'water', germinate: 'sprouts expected', harvest: 'harvest' };
  const sym = { water: '~', germinate: '^', harvest: '*' };
  return (
    <Panel title="next 14 days" flush>
      {tasks.length === 0 ? <Empty>no upcoming tasks</Empty> : (
        <ul class="list">
          {tasks.slice(0, 40).map((t, i) => (
            <li key={i}>
              <span style={`color:${t.kind === 'water' ? 'var(--cyan)' : t.kind === 'harvest' ? 'var(--amber)' : 'var(--accent)'}`} aria-hidden="true">{sym[t.kind]}</span>
              <span class="badge" style={`background:${t.color};color:#0b0f0c;border-color:${t.color}`}>{t.glyph}</span>
              <div class="grow">
                <div class="title">{label[t.kind]} {t.plant}</div>
                <div class="meta">{gardenId == null && <>{t.garden} · </>}{t.date}</div>
              </div>
              <span class={`small ${t.overdue ? 'err' : t.date === data.today ? 'warn' : 'muted'}`}>{t.overdue ? `${t.overdue}d overdue` : relDays(t.date, data.today)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ================= editor =================
interface GardenData { today: string; garden: Garden; plantings: Planting[] }
type Cell = { r: number; c: number };

export function GardenEditor({ id }: { id: number }) {
  const { canWrite, toast } = useApp();
  const { data, error, reload, setData } = useFetch<GardenData>(`/api/gardens/${id}`);
  const plants = useFetch<Plant[]>('/api/plants');
  const tasks = useFetch<{ today: string; tasks: GardenTask[] }>('/api/garden/tasks?days=14');
  const [brush, setBrush] = useState<Plant | null>(null);
  const [filter, setFilter] = useState('');
  const [drag, setDrag] = useState<{ a: Cell; b: Cell } | null>(null);
  const [picked, setPicked] = useState<Planting | null>(null);
  const [moving, setMoving] = useState<Planting | null>(null);
  const [zoom, setZoom] = useState(() => (window.innerWidth < 600 ? 40 : 52));
  const [showAscii, setShowAscii] = useState(false);
  const [editing, setEditing] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);

  const refresh = async () => { await reload(); tasks.reload(); };

  const active = useMemo(() => data?.plantings.filter((p) => !p.harvested_on) ?? [], [data]);
  const occupied = useMemo(() => {
    const s = new Set<string>();
    active.forEach((p) => { for (let r = p.row; r < p.row + p.h; r++) for (let c = p.col; c < p.col + p.w; c++) s.add(`${r},${c}`); });
    return s;
  }, [active]);

  if (!data) return <><Prompt title="garden" /><Loading error={error} /></>;
  const { garden, today } = data;

  const rect = drag ? {
    row: Math.min(drag.a.r, drag.b.r), col: Math.min(drag.a.c, drag.b.c),
    h: Math.abs(drag.a.r - drag.b.r) + 1, w: Math.abs(drag.a.c - drag.b.c) + 1,
  } : null;
  const inRect = (r: number, c: number) => !!rect && r >= rect.row && r < rect.row + rect.h && c >= rect.col && c < rect.col + rect.w;

  const cellFromPoint = (x: number, y: number): Cell | null => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const r = el?.dataset.r, c = el?.dataset.c;
    return r != null && c != null ? { r: Number(r), c: Number(c) } : null;
  };

  const onDown = (e: PointerEvent, cell: Cell) => {
    if (!canWrite) return;
    if (moving) { void moveTo(cell); return; }
    if (!brush) return;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    setDrag({ a: cell, b: cell });
  };
  const onMove = (e: PointerEvent) => {
    if (!drag) return;
    const cell = cellFromPoint(e.clientX, e.clientY);
    if (cell && (cell.r !== drag.b.r || cell.c !== drag.b.c)) setDrag({ ...drag, b: cell });
  };
  const plantAt = async (r: { row: number; col: number; w: number; h: number }) => {
    if (!brush) return;
    try {
      const p = await api.post<Planting>(`/api/gardens/${id}/plantings`, { plant_id: brush.id, ...r });
      setData({ ...data, plantings: [p, ...data.plantings] });
      tasks.reload();
    } catch (err) { toast((err as Error).message, 'error'); }
  };
  const onUp = async () => {
    const r = rect;
    setDrag(null);
    if (r) await plantAt(r);
  };

  const moveTo = async (cell: Cell) => {
    const m = moving!;
    setMoving(null);
    try { await api.patch(`/api/plantings/${m.id}`, { row: cell.r, col: cell.c }); await refresh(); toast(`Moved ${m.plant.name}`); }
    catch (err) { toast((err as Error).message, 'error'); }
  };

  const waterAll = async () => {
    try { const r = await api.post(`/api/gardens/${id}/water`, {}); toast(`Watered ${r.watered} plantings`); await refresh(); }
    catch (err) { toast((err as Error).message, 'error'); }
  };

  const dueCount = active.filter((p) => p.status.water_due).length;
  const shownPlants = (plants.data ?? []).filter((p) => p.name.toLowerCase().includes(filter.toLowerCase()));
  const sizeLabel = `${garden.cols * garden.cell_size_ft}×${garden.rows * garden.cell_size_ft} ft`;

  return (
    <>
      <Prompt title={garden.name} sub={`${garden.cols}×${garden.rows} cells · ${sizeLabel}`}>
        <a class="btn sm" href="#/garden">← gardens</a>
        {canWrite && <button class="sm" onClick={() => setEditing(true)}>edit</button>}
        <button class="sm" onClick={() => setShowAscii(!showAscii)}>{showAscii ? 'grid view' : 'ascii'}</button>
      </Prompt>

      {canWrite && (
        <Panel title={brush ? `planting: ${brush.name}` : moving ? `moving ${moving.plant.name} — tap destination` : 'tap a plant, then tap/drag cells'}
          right={brush ? <button class="sm" onClick={() => setBrush(null)}>done</button> : moving ? <button class="sm" onClick={() => setMoving(null)}>cancel</button> : null}>
          <div class="toolbar">
            <input type="search" placeholder="filter plants" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} aria-label="Filter plants" />
            <button class="sm" onClick={() => setCustomOpen(true)}>+ custom</button>
          </div>
          <div class="palette" role="group" aria-label="Plant palette">
            {shownPlants.map((p) => (
              <button key={p.id} aria-pressed={brush?.id === p.id} onClick={() => { setBrush(brush?.id === p.id ? null : p); setMoving(null); }} title={`${p.name} · ${p.days_to_maturity}d · water every ${p.water_every_days}d · ${p.spacing_in}in`}>
                <span class="g" style={`background:${p.color}`}>{p.glyph}</span>{p.name.length > 10 ? p.name.slice(0, 9) + '…' : p.name}
              </button>
            ))}
          </div>
          {brush && <p class="muted small" style="margin:6px 0 0">{brush.name}: sprouts ~{brush.days_to_germ}d · harvest ~{brush.days_to_maturity}d · water every {brush.water_every_days}d · spacing {brush.spacing_in}in{brush.sow ? ` · ${brush.sow}` : ''}</p>}
        </Panel>
      )}

      {showAscii ? <AsciiChart data={data} /> : (
        <Panel title="bed" right={
          <span class="toolbar" style="margin:0">
            <button class="sm" onClick={() => setZoom(Math.max(24, zoom - 8))} aria-label="Zoom out">−</button>
            <button class="sm" onClick={() => setZoom(Math.min(96, zoom + 8))} aria-label="Zoom in">+</button>
          </span>}>
          <div class="garden-wrap">
            <div
              ref={gridRef}
              class={`garden${brush || moving ? '' : ' panning'}`}
              style={`grid-template-columns:repeat(${garden.cols},${zoom}px);grid-template-rows:repeat(${garden.rows},${zoom}px)`}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={() => setDrag(null)}
              onPointerLeave={() => drag && onUp()}
            >
              {Array.from({ length: garden.rows * garden.cols }, (_, i) => {
                const r = Math.floor(i / garden.cols), c = i % garden.cols;
                if (occupied.has(`${r},${c}`) && !moving) return null;
                return (
                  <button
                    key={`c${i}`} class={`cell${inRect(r, c) ? ' sel' : ''}`} data-r={r} data-c={c}
                    style={`grid-row:${r + 1};grid-column:${c + 1}`}
                    onPointerDown={(e) => onDown(e as unknown as PointerEvent, { r, c })}
                    aria-label={`Row ${r + 1}, column ${c + 1}, empty`}
                    tabIndex={brush || moving ? 0 : -1}
                    onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && (brush || moving)) { e.preventDefault(); if (moving) void moveTo({ r, c }); else void plantAt({ row: r, col: c, w: 1, h: 1 }); } }}
                  />
                );
              })}
              {active.map((p) => (
                <button
                  key={`p${p.id}`}
                  class={`plot${p.status.water_due ? ' due' : ''}${p.status.stage === 'ready' ? ' ready' : ''}${picked?.id === p.id || moving?.id === p.id ? ' picked' : ''}`}
                  style={`grid-row:${p.row + 1}/span ${p.h};grid-column:${p.col + 1}/span ${p.w};background:${p.plant.color};${moving && moving.id !== p.id ? 'pointer-events:none;opacity:.6' : ''}`}
                  onClick={() => !brush && !moving && setPicked(p)}
                  aria-label={`${p.plant.name}, ${p.status.stage}${p.status.water_due ? ', needs water' : ''}`}
                >
                  {p.plant.glyph}
                  {zoom >= 44 && <span class="pn">{p.plant.name}</span>}
                  <span class="prog" style={`width:${Math.round(p.status.progress * 100)}%`} />
                </button>
              ))}
            </div>
          </div>
          <p class="muted small" style="margin:8px 0 0">
            <span style="color:var(--cyan)">~</span> needs water · <span style="color:var(--amber)">yellow ring</span> ready to harvest · bar = growth
          </p>
          {canWrite && active.length > 0 && (
            <div class="toolbar" style="margin:10px 0 0">
              <button onClick={waterAll}>~ watered everything{dueCount ? ` (${dueCount} due)` : ''}</button>
              <span class="muted small">use this for rain too</span>
            </div>
          )}
        </Panel>
      )}

      <TaskList data={tasks.data} gardenId={id} />

      {data.plantings.some((p) => p.harvested_on) && (
        <Panel title="history" flush>
          <ul class="list">
            {data.plantings.filter((p) => p.harvested_on).slice(0, 20).map((p) => (
              <li key={p.id} class="small"><span class="badge" style={`color:${p.plant.color}`}>{p.plant.glyph}</span><span class="grow">{p.plant.name}</span><span class="muted">{p.planted_on} → {p.harvested_on}</span></li>
            ))}
          </ul>
        </Panel>
      )}

      {picked && <PlantingModal p={picked} today={today} garden={garden} onClose={() => setPicked(null)} onChanged={async () => { setPicked(null); await refresh(); }} onMove={() => { setMoving(picked); setPicked(null); setBrush(null); }} />}
      {editing && <EditGarden garden={garden} onClose={() => setEditing(false)} onSaved={async () => { setEditing(false); await refresh(); }} />}
      {customOpen && <CustomPlant onClose={() => setCustomOpen(false)} onSaved={(p) => { setCustomOpen(false); plants.reload(); setBrush(p); }} />}
    </>
  );
}

function PlantingModal({ p, today, garden, onClose, onChanged, onMove }: { p: Planting; today: string; garden: Garden; onClose: () => void; onChanged: () => void; onMove: () => void }) {
  const { canWrite, toast } = useApp();
  const [planted, setPlanted] = useState(p.planted_on);
  const [w, setW] = useState(p.w);
  const [h, setH] = useState(p.h);
  const [notes, setNotes] = useState(p.notes);
  const s = p.status;
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    try { await fn(); toast(msg); onChanged(); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const perCell = Math.max(1, Math.floor(((garden.cell_size_ft * 12) / p.plant.spacing_in) ** 2));

  return (
    <Modal title={p.plant.name} onClose={onClose} footer={canWrite && (
      <>
        <button class="danger" onClick={() => confirm('Remove this planting entirely?') && run(() => api.del(`/api/plantings/${p.id}`), 'Removed')}>remove</button>
        <span style="flex:1" />
        <button onClick={onMove}>move</button>
        <button class="primary" onClick={() => run(() => api.patch(`/api/plantings/${p.id}`, { planted_on: planted, w, h, notes }), 'Saved')}>save</button>
      </>
    )}>
      <pre class="mono-pre">{[
        `stage     ${s.stage.toUpperCase()}`,
        `growth    `,
        `planted   ${p.planted_on}  (${relDays(p.planted_on, today)})`,
        `sprouts   ${s.germ_on}  (${relDays(s.germ_on, today)})`,
        `harvest   ${s.harvest_on}  (${relDays(s.harvest_on, today)})`,
        `watered   ${p.last_watered ?? '—'}  every ${p.plant.water_every_days}d`,
        `next h2o  ${s.next_water ?? '—'}${s.water_due ? '  << DUE' : ''}`,
        `area      ${p.w}×${p.h} cells · ~${perCell * p.w * p.h} plants @ ${p.plant.spacing_in}in`,
      ].join('\n')}</pre>
      <p style="margin:8px 0"><AsciiBar value={s.progress} width={20} /> {Math.round(s.progress * 100)}%</p>
      {p.plant.notes && <p class="muted small">{p.plant.notes}</p>}
      {canWrite && (
        <div class="form" style="margin-top:12px">
          <div class="toolbar" style="margin:0">
            <button onClick={() => run(() => api.post(`/api/gardens/${p.garden_id}/water`, { plantingIds: [p.id] }), 'Watered')}>~ watered today</button>
            <button onClick={() => run(() => api.patch(`/api/plantings/${p.id}`, { harvested_on: today }), 'Harvested — cell freed')}>* harvested</button>
          </div>
          <div class="row r3">
            <Field label="planted on"><input type="date" value={planted} onInput={(e) => setPlanted((e.target as HTMLInputElement).value)} /></Field>
            <Field label="width"><input type="number" min="1" max={garden.cols} value={w} onInput={(e) => setW(Number((e.target as HTMLInputElement).value))} /></Field>
            <Field label="depth"><input type="number" min="1" max={garden.rows} value={h} onInput={(e) => setH(Number((e.target as HTMLInputElement).value))} /></Field>
          </div>
          <Field label="notes"><textarea value={notes} onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)} /></Field>
        </div>
      )}
    </Modal>
  );
}

function EditGarden({ garden, onClose, onSaved }: { garden: Garden; onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp();
  const [f, setF] = useState({ name: garden.name, rows: garden.rows, cols: garden.cols, cell_size_ft: garden.cell_size_ft, notes: garden.notes });
  const save = async () => { try { await api.patch(`/api/gardens/${garden.id}`, f); toast('Saved'); onSaved(); } catch (e) { toast((e as Error).message, 'error'); } };
  const del = async () => {
    if (!confirm(`Delete ${garden.name} and all its plantings?`)) return;
    try { await api.del(`/api/gardens/${garden.id}`); navigate('/garden'); } catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <Modal title="edit garden" onClose={onClose} footer={<><button class="danger" onClick={del}>delete</button><span style="flex:1" /><button onClick={onClose}>cancel</button><button class="primary" onClick={save}>save</button></>}>
      <div class="form">
        <Field label="name"><input value={f.name} onInput={(e) => setF({ ...f, name: (e.target as HTMLInputElement).value })} /></Field>
        <div class="row r3">
          <Field label="columns"><input type="number" min="1" max="60" value={f.cols} onInput={(e) => setF({ ...f, cols: Number((e.target as HTMLInputElement).value) })} /></Field>
          <Field label="rows"><input type="number" min="1" max="60" value={f.rows} onInput={(e) => setF({ ...f, rows: Number((e.target as HTMLInputElement).value) })} /></Field>
          <Field label="cell ft"><input type="number" min="0.25" max="10" step="0.25" value={f.cell_size_ft} onInput={(e) => setF({ ...f, cell_size_ft: Number((e.target as HTMLInputElement).value) })} /></Field>
        </div>
        <Field label="notes"><textarea value={f.notes} onInput={(e) => setF({ ...f, notes: (e.target as HTMLTextAreaElement).value })} placeholder="soil mix, sun hours, irrigation…" /></Field>
      </div>
    </Modal>
  );
}

function CustomPlant({ onClose, onSaved }: { onClose: () => void; onSaved: (p: Plant) => void }) {
  const { toast } = useApp();
  const [f, setF] = useState({ name: '', glyph: '', color: '#7cc36e', days_to_germ: 7, days_to_maturity: 60, water_every_days: 3, spacing_in: 12, sow: '', notes: '' });
  const n = (k: keyof typeof f) => (e: Event) => setF({ ...f, [k]: Number((e.target as HTMLInputElement).value) });
  const t = (k: keyof typeof f) => (e: Event) => setF({ ...f, [k]: (e.target as HTMLInputElement).value });
  const save = async () => {
    try { onSaved(await api.post<Plant>('/api/plants', { ...f, glyph: f.glyph || f.name.slice(0, 2) })); toast('Plant added'); }
    catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <Modal title="custom plant" onClose={onClose} footer={<><button onClick={onClose}>cancel</button><button class="primary" onClick={save}>add</button></>}>
      <div class="form">
        <div class="row r3">
          <Field label="name"><input value={f.name} onInput={t('name')} /></Field>
          <Field label="glyph (2)"><input maxLength={3} value={f.glyph} onInput={t('glyph')} placeholder="PW" /></Field>
          <Field label="color"><input type="color" value={f.color} onInput={t('color')} /></Field>
        </div>
        <div class="row">
          <Field label="days to sprout"><input type="number" min="0" value={f.days_to_germ} onInput={n('days_to_germ')} /></Field>
          <Field label="days to harvest"><input type="number" min="1" value={f.days_to_maturity} onInput={n('days_to_maturity')} /></Field>
        </div>
        <div class="row">
          <Field label="water every (days)"><input type="number" min="1" value={f.water_every_days} onInput={n('water_every_days')} /></Field>
          <Field label="spacing (in)"><input type="number" min="1" value={f.spacing_in} onInput={n('spacing_in')} /></Field>
        </div>
        <Field label="when to sow"><input value={f.sow} onInput={t('sow')} /></Field>
      </div>
    </Modal>
  );
}

/** Printable/copyable text chart of the bed. */
function AsciiChart({ data }: { data: GardenData }) {
  const { toast } = useApp();
  const { garden } = data;
  const grid: string[][] = Array.from({ length: garden.rows }, () => Array(garden.cols).fill('..'));
  const legend = new Map<string, string>();
  data.plantings.filter((p) => !p.harvested_on).forEach((p) => {
    legend.set(p.plant.glyph, `${p.plant.name} (planted ${p.planted_on}, harvest ~${p.status.harvest_on})`);
    for (let r = p.row; r < p.row + p.h; r++) for (let c = p.col; c < p.col + p.w; c++) grid[r][c] = p.plant.glyph.padEnd(2).slice(0, 2);
  });
  const header = '    ' + Array.from({ length: garden.cols }, (_, c) => String(c + 1).padStart(2)).join(' ');
  const border = '   +' + '-'.repeat(garden.cols * 3) + '+';
  const lines = [
    `${garden.name} — ${garden.cols}x${garden.rows} @ ${garden.cell_size_ft}ft — ${data.today}`,
    header, border,
    ...grid.map((row, r) => `${String(r + 1).padStart(2)} |${row.map((g) => g.padStart(2)).join(' ')} |`),
    border, '',
    ...[...legend.entries()].map(([g, l]) => `${g.padEnd(3)} ${l}`),
  ];
  const text = lines.join('\n');
  return (
    <Panel title="ascii chart" right={<span class="toolbar" style="margin:0"><button class="sm" onClick={async () => toast((await copyText(text)) ? 'Copied' : 'Copy failed', 'ok')}>copy</button><button class="sm" onClick={() => window.print()}>print</button></span>}>
      <pre class="mono-pre" style="font-size:.8rem">{text}</pre>
    </Panel>
  );
}
