import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../api';
import { navigate } from '../router';
import { Field, Panel, Prompt, fmtQty, useApp, useFetch } from '../components/ui';
import { ItemFields, blankItem, useItemMeta, type ItemMeta } from '../components/ItemForm';
import { CATEGORIES, type NewItem } from '../types';
import { beep, useScanner } from '../components/scanner';

const TABS = [
  { id: 'quick', label: 'quick add' },
  { id: 'scan', label: 'scan barcode' },
  { id: 'photo', label: 'receipt / shelf photo' },
];

export function AddItems({ tab = 'quick' }: { tab?: string }) {
  const { canWrite } = useApp();
  const meta = useItemMeta();
  const [log, setLog] = useState<string[]>([]);
  const added = (line: string) => { setLog((l) => [line, ...l].slice(0, 30)); meta.reload(); };

  if (!canWrite) return <><Prompt title="add" /><p class="muted">You have read-only access to this household.</p></>;

  return (
    <>
      <Prompt title="add" sub="stock the shelves" />
      <div class="chips" role="tablist" style="margin-bottom:14px">
        {TABS.map((t) => (
          <button key={t.id} role="tab" class="chip" aria-selected={tab === t.id} aria-pressed={tab === t.id} onClick={() => navigate(`/add/${t.id}`)}>{t.label}</button>
        ))}
      </div>
      {tab === 'quick' && <QuickAdd meta={meta.data} onAdded={added} />}
      {tab === 'scan' && <Scan meta={meta.data} onAdded={added} />}
      {tab === 'photo' && <Photo meta={meta.data} onAdded={added} />}
      {log.length > 0 && (
        <Panel title="added this session" flush>
          <ul class="list">{log.map((l, i) => <li key={i} class="small"><span class="ok">+</span> {l}</li>)}</ul>
        </Panel>
      )}
    </>
  );
}

// ---------------- quick add ----------------
function QuickAdd({ meta, onAdded }: { meta: ItemMeta | null; onAdded: (l: string) => void }) {
  const { toast } = useApp();
  const [v, setV] = useState<NewItem>(blankItem());
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!v.name.trim()) return;
    setBusy(true);
    try {
      const r = await api.post('/api/items', v);
      onAdded(`${fmtQty(v.qty)} ${v.unit} ${v.name}${r.qty !== v.qty ? ` (now ${fmtQty(r.qty)})` : ''}`);
      toast(`Added ${v.name}`);
      // Keep context (location, category, expiry) for rapid entry of a shelf.
      setV(keep ? { ...blankItem(), category: v.category, location: v.location, expires_on: v.expires_on, unit: v.unit } : blankItem());
      (document.querySelector('input[name="item-name"]') as HTMLInputElement | null)?.focus();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };

  return (
    <Panel title="quick add" right={<span class="only-desktop muted">enter ↵ to add</span>}>
      <form onSubmit={submit} class="form">
        <ItemFields value={v} onChange={setV} meta={meta} compact />
        <label class="check"><input type="checkbox" checked={keep} onChange={(e) => setKeep((e.target as HTMLInputElement).checked)} /> keep location / category / date for the next item</label>
        <button class="primary" disabled={busy}>add item</button>
      </form>
    </Panel>
  );
}

// ---------------- barcode scan ----------------
interface Lookup {
  product: { upc: string; found: boolean; name: string | null; brand: string | null; quantity: string | null; category: string | null; image: string | null; kcal: number | null; source: string | null };
  own: { name: string; category: string; unit: string; location: string; kcal_per_unit: number | null; min_qty: number | null } | null;
}

const SOURCE_LABEL: Record<string, string> = {
  usda: 'USDA', off: 'Open Food Facts', 'usda+off': 'USDA + Open Food Facts', 'off-online': 'Open Food Facts (online)',
  opf: 'Open Products Facts', obf: 'Open Beauty Facts', opff: 'Open Pet Food Facts', upcitemdb: 'UPCitemdb',
};
const OFFLINE_SOURCES = new Set(['usda', 'off', 'usda+off']);

function Scan({ meta, onAdded }: { meta: ItemMeta | null; onAdded: (l: string) => void }) {
  const { toast, me } = useApp();
  const offlineCount = me.features.barcodeProducts;
  const video = useRef<HTMLVideoElement>(null);
  const [scanning, setScanning] = useState(false);
  const [pending, setPending] = useState<{ upc: string; lookup: Lookup | null } | null>(null);
  const [item, setItem] = useState<NewItem>(blankItem());
  const [manual, setManual] = useState('');
  const [sticky, setSticky] = useState<{ location: string; expires_on: string | null }>({ location: '', expires_on: null });
  const last = useRef<{ code: string; at: number }>({ code: '', at: 0 });

  const handle = async (upc: string) => {
    if (pending) return;
    if (last.current.code === upc && Date.now() - last.current.at < 3000) return;
    last.current = { code: upc, at: Date.now() };
    beep();
    setPending({ upc, lookup: null });
    setItem(blankItem({ barcode: upc, location: sticky.location, expires_on: sticky.expires_on }));
    try {
      const l = await api.get<Lookup>(`/api/barcode/${upc}`);
      setPending({ upc, lookup: l });
      const p = l.product;
      setItem((cur) => ({
        ...cur,
        name: l.own?.name ?? (p.found ? [p.brand, p.name].filter(Boolean).join(' ') + (p.quantity ? `, ${p.quantity}` : '') : ''),
        category: l.own?.category ?? p.category ?? 'food',
        unit: l.own?.unit ?? 'ea',
        location: cur.location || l.own?.location || '',
        kcal_per_unit: l.own ? l.own.kcal_per_unit : p.kcal,
        min_qty: l.own?.min_qty ?? null,
      }));
    } catch (e) {
      toast((e as Error).message, 'error');
      setPending({ upc, lookup: { product: { upc, found: false, name: null, brand: null, quantity: null, category: null, image: null, kcal: null, source: null }, own: null } });
    }
  };

  const { error, engine } = useScanner(video, scanning, handle);

  const commit = async (e: Event) => {
    e.preventDefault();
    try {
      const r = await api.post('/api/items', item);
      onAdded(`${fmtQty(item.qty)} ${item.unit} ${item.name}${r.qty !== item.qty ? ` (now ${fmtQty(r.qty)})` : ''}`);
      toast(`Added ${item.name}`);
      setSticky({ location: item.location, expires_on: item.expires_on ?? null });
      setPending(null);
    } catch (err) { toast((err as Error).message, 'error'); }
  };

  return (
    <>
      <Panel title="scanner" right={engine && <span class="muted">{engine}</span>}>
        {!scanning ? (
          <div class="form">
            <p class="muted">Point your camera at a UPC/EAN barcode. Names come from your past entries first, then {offlineCount > 0
              ? <>the offline product database ({Math.round(offlineCount / 1000).toLocaleString()}k US groceries, works without internet), then online lookups.</>
              : <>online product databases.</>}</p>
            <button class="primary" onClick={() => setScanning(true)}>start camera</button>
          </div>
        ) : (
          <>
            <div class="scanner"><video ref={video} muted playsInline /><div class="reticle" /></div>
            {error && <p class="err">✗ {error}</p>}
            <div class="toolbar" style="margin-top:10px"><button onClick={() => setScanning(false)}>stop camera</button><span class="muted small">{pending ? 'paused — confirm item below' : 'scanning…'}</span></div>
          </>
        )}
        <form class="toolbar" style="margin:10px 0 0" onSubmit={(e) => { e.preventDefault(); if (/^\d{6,14}$/.test(manual)) { void handle(manual); setManual(''); } else toast('Enter 6–14 digits', 'error'); }}>
          <input inputMode="numeric" placeholder="type or USB-scan a barcode" value={manual} onInput={(e) => setManual((e.target as HTMLInputElement).value.trim())} aria-label="Barcode" />
          <button>look up</button>
        </form>
      </Panel>

      {pending && (
        <Panel title={`barcode ${pending.upc}`} right={pending.lookup ? (pending.lookup.own ? <span class="ok">known item</span> : pending.lookup.product.found ? <span class="ok">found</span> : <span class="warn">not found — name it</span>) : <span class="muted">looking up…</span>}>
          <form onSubmit={commit} class="form">
            {pending.lookup?.product.image && <img src={pending.lookup.product.image} alt="" style="max-height:90px;align-self:start;border-radius:4px" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />}
            {!pending.lookup?.own && pending.lookup?.product.source && (
              <p class="muted small" style="margin:0">
                from {SOURCE_LABEL[pending.lookup.product.source] ?? pending.lookup.product.source}{OFFLINE_SOURCES.has(pending.lookup.product.source) ? ' · offline' : ''}
                {pending.lookup.product.kcal ? <> · ≈{pending.lookup.product.kcal.toLocaleString()} kcal per package, counted toward days of food</> : null}
              </p>
            )}
            <ItemFields value={item} onChange={setItem} meta={meta} compact />
            <div class="toolbar">
              <button type="button" onClick={() => setPending(null)}>skip</button>
              <button class="primary" disabled={!item.name}>add &amp; scan next</button>
            </div>
          </form>
        </Panel>
      )}
    </>
  );
}

// ---------------- photo import ----------------
interface Extracted { name: string; qty: number; unit: string; category: string; expires_on: string | null; notes: string; include: boolean }

async function resizeImage(file: File, max = 1600): Promise<{ data: string; mediaType: 'image/jpeg' }> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL('image/jpeg', 0.85);
  return { data: url.split(',')[1], mediaType: 'image/jpeg' };
}

function Photo({ meta, onAdded }: { meta: ItemMeta | null; onAdded: (l: string) => void }) {
  const { toast } = useApp();
  const quota = useFetch<{ enabled: boolean; used: number; quota: number }>('/api/receipt/quota');
  const [mode, setMode] = useState<'receipt' | 'shelf'>('receipt');
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<Extracted[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [location, setLocation] = useState('');
  const [preview, setPreview] = useState('');

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true); setRows(null); setWarnings([]);
    try {
      const img = await resizeImage(f);
      setPreview(`data:image/jpeg;base64,${img.data}`);
      const r = await api.post<{ items: Omit<Extracted, 'include'>[]; warnings: string[] }>('/api/receipt', { image: img.data, mediaType: img.mediaType, mode });
      setRows(r.items.map((i) => ({ ...i, include: true })));
      setWarnings(r.warnings);
      if (!r.items.length) toast('No items found in that photo', 'error');
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); quota.reload(); }
  };

  const upd = (i: number, patch: Partial<Extracted>) => setRows((r) => r!.map((x, k) => (k === i ? { ...x, ...patch } : x)));

  const commit = async () => {
    const items = rows!.filter((r) => r.include && r.name.trim()).map(({ include: _i, ...r }) => ({ ...r, location }));
    if (!items.length) return;
    try {
      await api.post('/api/items/bulk', { items });
      items.forEach((i) => onAdded(`${fmtQty(i.qty)} ${i.unit} ${i.name}`));
      toast(`Added ${items.length} items`);
      setRows(null); setPreview('');
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  if (quota.data && !quota.data.enabled) return <Panel title="photo import"><p class="muted">Photo import isn’t configured on this server (needs <code>ANTHROPIC_API_KEY</code>). See Docs → Deploy.</p></Panel>;

  return (
    <>
      <Panel title="photo import" right={quota.data && <span class="muted">{quota.data.used}/{quota.data.quota} this month</span>}>
        <div class="form">
          <div class="chips">
            <button class="chip" aria-pressed={mode === 'receipt'} onClick={() => setMode('receipt')}>receipt</button>
            <button class="chip" aria-pressed={mode === 'shelf'} onClick={() => setMode('shelf')}>shelf / pantry</button>
          </div>
          <p class="muted small">{mode === 'receipt' ? 'Flatten the receipt and fill the frame. Long receipts: take two photos.' : 'Stand back so labels are readable. Visible best-by dates are picked up.'} Nothing is saved until you review it.</p>
          <label class="btn primary" style={busy ? 'opacity:.6;pointer-events:none' : ''}>
            {busy ? 'reading photo…' : 'take / choose photo'}
            <input type="file" accept="image/*" capture="environment" class="sr-only" onChange={(e) => onFile((e.target as HTMLInputElement).files?.[0])} />
          </label>
          {preview && <img src={preview} alt="Uploaded" style="max-height:160px;object-fit:contain;align-self:start;border:1px solid var(--line)" />}
        </div>
      </Panel>

      {rows && rows.length > 0 && (
        <Panel title={`review ${rows.filter((r) => r.include).length}/${rows.length}`}>
          {warnings.length > 0 && <div class="banner">{warnings.map((w, i) => <div key={i}>! {w}</div>)}</div>}
          <Field label="location for all"><input list="dl-locs2" value={location} onInput={(e) => setLocation((e.target as HTMLInputElement).value)} placeholder="Pantry" /></Field>
          <datalist id="dl-locs2">{meta?.locations.map((l) => <option key={l} value={l} />)}</datalist>
          <div class="table-wrap" style="margin-top:10px">
            <table class="t">
              <thead><tr><th><span class="sr-only">include</span>✓</th><th>name</th><th>qty</th><th>unit</th><th>category</th><th>expires</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={r.include ? '' : 'opacity:.45'}>
                    <td><input type="checkbox" checked={r.include} onChange={(e) => upd(i, { include: (e.target as HTMLInputElement).checked })} aria-label={`Include ${r.name}`} /></td>
                    <td style="min-width:180px"><input value={r.name} onInput={(e) => upd(i, { name: (e.target as HTMLInputElement).value })} aria-label="Name" /></td>
                    <td style="width:80px"><input type="number" step="any" min="0" value={r.qty} onInput={(e) => upd(i, { qty: Number((e.target as HTMLInputElement).value) })} aria-label="Quantity" /></td>
                    <td style="width:90px"><input value={r.unit} onInput={(e) => upd(i, { unit: (e.target as HTMLInputElement).value })} aria-label="Unit" /></td>
                    <td style="width:120px"><select value={r.category} onChange={(e) => upd(i, { category: (e.target as HTMLSelectElement).value })} aria-label="Category">{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></td>
                    <td style="width:160px"><input type="date" value={r.expires_on ?? ''} onInput={(e) => upd(i, { expires_on: (e.target as HTMLInputElement).value || null })} aria-label="Expires" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div class="toolbar" style="margin-top:12px">
            <button onClick={() => setRows(null)}>discard</button>
            <button class="primary" onClick={commit}>add {rows.filter((r) => r.include).length} items</button>
          </div>
        </Panel>
      )}
    </>
  );
}
