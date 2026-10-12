import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, qs } from '../api';
import { navigate, queryParam } from '../router';
import { Power } from './Power';
import { Empty, Loading, Modal, Panel, Prompt, TierBadge, fmtQty, relDays, useApp, useFetch } from '../components/ui';
import { ItemFields, blankItem, useItemMeta, type ItemMeta } from '../components/ItemForm';
import { staplesFor, type Staple } from '../data/staples';
import { CATEGORIES, type Item, type NewItem, type Tier } from '../types';

const isCategory = (s: string | undefined | null): s is string => !!s && (CATEGORIES as readonly string[]).includes(s);

/** One tab per section (food, water, medical, power, ...). Power also holds the equipment with upkeep reminders. */
export function Inventory({ tab }: { tab?: string }) {
  // Old links used ?category=food; they land on the same tab.
  const section = isCategory(tab) ? tab : isCategory(queryParam('category')) ? queryParam('category')! : 'all';
  return <Section key={section} section={section} />;
}

interface ItemsResponse { today: string; items: Item[]; counts: Record<string, number>; devices: number }

function SectionTabs({ section, counts, devices }: { section: string; counts: Record<string, number>; devices: number }) {
  const active = useRef<HTMLButtonElement>(null);
  useEffect(() => { active.current?.scrollIntoView({ block: 'nearest', inline: 'center' }); }, []);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return (
    <div class="tabs" role="tablist" aria-label="Inventory sections">
      {(['all', ...CATEGORIES] as string[]).map((c) => {
        const n = c === 'all' ? total : (counts[c] ?? 0) + (c === 'power' ? devices : 0);
        const on = c === section;
        return (
          <button key={c} ref={on ? active : undefined} role="tab" class="chip" aria-selected={on} aria-pressed={on} onClick={() => navigate(c === 'all' ? '/inventory' : `/inventory/${c}`)}>
            {c}{n ? <span class="tab-n">{n}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

function Section({ section }: { section: string }) {
  const { me, canWrite } = useApp();
  const category = section === 'all' ? '' : section;
  const [q, setQ] = useState('');
  const [tier, setTier] = useState<Tier | ''>((queryParam('tier') as Tier) ?? '');
  const [sort, setSort] = useState(queryParam('sort') ?? 'expiry');
  const [debounced, setDebounced] = useState('');
  const [editing, setEditing] = useState<Item | null>(null);
  const [adding, setAdding] = useState<NewItem | null>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => { const t = setTimeout(() => setDebounced(q), 200); return () => clearTimeout(t); }, [q]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') { e.preventDefault(); search.current?.focus(); } };
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  }, []);

  const url = `/api/items${qs({ q: debounced, category, tier, sort })}`;
  const { data, error, reload } = useFetch<ItemsResponse>(url, [me.active?.id]);
  const meta = useItemMeta();

  const totals = useMemo(() => {
    const m = new Map<string, number>();
    data?.items.forEach((i) => m.set(i.tier, (m.get(i.tier) ?? 0) + 1));
    return m;
  }, [data]);

  const startAdd = (st?: Staple) => setAdding(blankItem({
    category: st?.category ?? (category || 'food'),
    ...(st ? { name: st.name, unit: st.unit, kcal_per_unit: st.kcal ?? null } : {}),
  }));
  const addLabel = section === 'all' ? 'add item' : section === 'power' ? 'add batteries / fuel' : `add ${section}`;
  const filtered = !!(debounced || tier);

  return (
    <>
      <Prompt title="inventory" sub={section === 'all' ? (data ? `${data.items.length} batches` : '') : section}>
        <a class="btn sm" href="/api/items/export.csv" download>export csv</a>
        {canWrite && <a class="btn sm" href="#/add/scan" title="Scan barcodes or a receipt">scan</a>}
        {canWrite && <button class="primary" onClick={() => startAdd()}>{addLabel}</button>}
      </Prompt>
      <SectionTabs section={section} counts={data?.counts ?? {}} devices={data?.devices ?? 0} />

      {section === 'power' && (
        <>
          <Power />
          <h2 class="section-h">batteries, fuel &amp; supplies</h2>
        </>
      )}

      <div class="toolbar">
        <input ref={search} type="search" placeholder={`search ${section === 'all' ? 'everything' : section}  ( / )`} value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} aria-label="Search inventory" />
        <select value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value)} aria-label="Sort">
          <option value="expiry">sort: expiry</option><option value="name">sort: name</option>{section === 'all' && <option value="category">sort: category</option>}<option value="updated">sort: recent</option>
        </select>
      </div>
      <div class="toolbar">
        <div class="chips" role="group" aria-label="Expiry">
          {(['', 'expired', 'soon', 'upcoming', 'ok', 'none'] as const).map((t) => (
            <button key={t} class="chip" aria-pressed={tier === t} onClick={() => setTier(t)}>
              {t || 'any date'}{t && !tier && totals.get(t) ? ` · ${totals.get(t)}` : ''}
            </button>
          ))}
        </div>
      </div>

      {!data ? <Loading error={error} /> : (
        <Panel title={section === 'power' ? 'power supplies' : section === 'all' ? 'batches' : section} right={<span>{data.items.reduce((s, i) => s + i.qty, 0).toFixed(0)} units</span>} flush>
          {data.items.length === 0 ? (
            filtered || !canWrite || section === 'all' ? <Empty>{filtered ? 'no items match' : section === 'all' ? 'nothing in inventory yet' : `no ${section} yet`}</Empty> : (
              <div style="padding:12px 14px">
                <p class="muted" style="margin-top:0">No {section === 'power' ? 'batteries or fuel' : section} yet. Tap one to add it, or use <strong>{addLabel}</strong>.</p>
                <div class="chips">
                  {staplesFor(section).map((st) => <button key={st.name} class="chip" onClick={() => startAdd(st)}>+ {st.name}</button>)}
                </div>
              </div>
            )
          ) : (
            <ul class="list">
              {data.items.map((i) => (
                <li key={i.id}>
                  <button class="rowbtn ghost" onClick={() => setEditing(i)} aria-label={`Edit ${i.name}`}>
                    <div class="title">{i.name}</div>
                    <div class="meta">
                      <strong style="color:var(--text)">{fmtQty(i.qty)} {i.unit}</strong> · {i.category}{i.location ? ` · ${i.location}` : ''}
                      {i.expires_on && <> · <span class={`t-${i.tier}`}>{relDays(i.expires_on, data.today)}</span> <span class="muted">({i.expires_on})</span></>}
                    </div>
                  </button>
                  {(i as Item & { pending?: boolean }).pending && <span class="badge t-upcoming" title="Changed offline; syncs when you’re back online">not synced</span>}
                  <TierBadge tier={i.tier} />
                  {canWrite && <QuickUse item={i} onDone={reload} />}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      {adding && <AddItem initial={adding} section={category || undefined} meta={meta.data} onClose={() => setAdding(null)} onSaved={() => { void reload(); meta.reload(); }} />}
      {editing && <EditItem item={editing} meta={meta.data} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void reload(); meta.reload(); }} />}
    </>
  );
}

/** Add form opened from a section: category preset, suggestions from that section first. */
function AddItem({ initial, section, meta, onClose, onSaved }: { initial: NewItem; section?: string; meta: ItemMeta | null; onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp();
  const [v, setV] = useState<NewItem>(initial);
  const [another, setAnother] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async (e?: Event) => {
    e?.preventDefault();
    if (!v.name.trim()) { toast('Give it a name', 'error'); return; }
    setBusy(true);
    try {
      const r = await api.post('/api/items', v);
      toast(`Added ${fmtQty(v.qty)} ${v.unit} ${v.name}${r.qty !== v.qty ? ` (now ${fmtQty(r.qty)})` : ''}`);
      onSaved();
      if (another) setV(blankItem({ category: v.category, location: v.location, expires_on: v.expires_on })); else onClose();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal title={section ? `add ${section}` : 'add item'} onClose={onClose} footer={<>
      <label class="check small" style="margin-right:auto"><input type="checkbox" checked={another} onChange={(e) => setAnother((e.target as HTMLInputElement).checked)} /> add another</label>
      <button onClick={onClose}>cancel</button><button class="primary" disabled={busy} onClick={() => save()}>add</button>
    </>}>
      <form onSubmit={save}>
        <ItemFields value={v} onChange={setV} meta={meta} section={section} />
        <button type="submit" class="sr-only">add</button>
      </form>
    </Modal>
  );
}

function QuickUse({ item, onDone }: { item: Item; onDone: () => void }) {
  const { toast } = useApp();
  const use = async () => {
    try {
      const r = await api.post(`/api/items/${item.id}/consume`, { qty: Math.min(1, item.qty), kind: 'use' });
      toast(r.removed ? `Used last ${item.name}` : `Used 1 ${item.unit} · ${fmtQty(r.qty)} left`);
      onDone();
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  return <button class="sm" onClick={use} title="Use one" aria-label={`Use one ${item.name}`}>−1</button>;
}

function EditItem({ item, meta, onClose, onSaved }: { item: Item; meta: import('../components/ItemForm').ItemMeta | null; onClose: () => void; onSaved: () => void }) {
  const { toast, canWrite } = useApp();
  const [v, setV] = useState<NewItem>({ ...item });
  const [useQty, setUseQty] = useState(1);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try { await fn(); toast(msg); onSaved(); } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const save = (e?: Event) => { e?.preventDefault(); return run(() => api.patch(`/api/items/${item.id}`, v), 'Saved'); };

  return (
    <Modal title={item.name} onClose={onClose} footer={canWrite && (
      <>
        <button class="danger" disabled={busy} onClick={() => confirm(`Delete ${item.name}?`) && run(() => api.del(`/api/items/${item.id}`), 'Deleted')}>delete</button>
        <span style="flex:1" />
        <button onClick={onClose}>cancel</button>
        <button class="primary" disabled={busy} onClick={() => save()}>save</button>
      </>
    )}>
      {canWrite && (
        <div class="panel">
          <div class="ph"><span>use / discard</span></div>
          <div class="pb toolbar" style="margin:0">
            <input type="number" min="0" step="any" inputMode="decimal" value={useQty} onInput={(e) => setUseQty(Number((e.target as HTMLInputElement).value))} style="width:100px" aria-label="Quantity" />
            <span class="muted">{item.unit}</span>
            <button disabled={busy || useQty <= 0} onClick={() => run(() => api.post(`/api/items/${item.id}/consume`, { qty: useQty, kind: 'use' }), `Used ${useQty}`)}>used</button>
            <button disabled={busy || useQty <= 0} class="danger" onClick={() => run(() => api.post(`/api/items/${item.id}/consume`, { qty: useQty, kind: 'discard' }), `Discarded ${useQty}`)}>discarded</button>
          </div>
        </div>
      )}
      <form onSubmit={save}>
        <fieldset disabled={!canWrite} style="border:0;padding:0;margin:0">
          <ItemFields value={v} onChange={setV} meta={meta} />
        </fieldset>
        <button type="submit" class="sr-only">save</button>
      </form>
      {item.barcode && <p class="muted small">barcode {item.barcode}</p>}
    </Modal>
  );
}
