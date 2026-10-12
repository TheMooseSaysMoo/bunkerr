import { useState } from 'preact/hooks';
import { searchStaples, shelfLabel } from '../data/staples';
import { Field, useFetch } from './ui';
import { CATEGORIES, UNITS, type NewItem } from '../types';

export interface ItemMeta {
  locations: string[]; units: string[];
  recent: { name: string; category: string; unit: string; location: string; kcal_per_unit: number | null; min_qty: number | null }[];
}

export const useItemMeta = () => useFetch<ItemMeta>('/api/items/meta');

/** Quick expiry shortcuts: common shelf lives. */
const SHORTCUTS: [string, number][] = [['+1mo', 1], ['+6mo', 6], ['+1y', 12], ['+2y', 24], ['+5y', 60], ['+10y', 120]];
const addMonths = (n: number) => { const d = new Date(); d.setMonth(d.getMonth() + n); return d.toISOString().slice(0, 10); };

const PLACEHOLDER: Record<string, string> = {
  food: 'e.g. black beans', water: 'e.g. bottled water', medical: 'e.g. ibuprofen', hygiene: 'e.g. toilet paper', power: 'e.g. AA batteries',
  tools: 'e.g. duct tape', comms: 'e.g. weather radio', garden: 'e.g. seed packet', other: 'name',
};

/** `section` is the inventory tab the form was opened from: its staples rank first. */
export function ItemFields({ value, onChange, meta, compact, section, placeholder }: { value: NewItem; onChange: (v: NewItem) => void; meta: ItemMeta | null; compact?: boolean; section?: string; placeholder?: string }) {
  const [more, setMore] = useState(!compact && !!(value.min_qty || value.kcal_per_unit || value.notes));
  const set = <K extends keyof NewItem>(k: K, v: NewItem[K]) => onChange({ ...value, [k]: v });
  const num = (s: string) => (s === '' ? null : Number(s));

  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const [shelf, setShelf] = useState<number | undefined>(undefined);

  // Household history first (their own names, units and locations), then common staples.
  // Inside a section, everything from that section comes before anything else.
  const q = value.name.trim().toLowerCase();
  const suggestions: Suggestion[] = q.length < 2 ? [] : (() => {
    const mine = (meta?.recent ?? []).filter((r) => wordPrefixMatch(r.name, q) && r.name.toLowerCase() !== q)
      .map((r): Suggestion => ({ name: r.name, unit: r.unit, category: r.category, kcal: r.kcal_per_unit ?? undefined, location: r.location, min_qty: r.min_qty, mine: true }));
    const staples = searchStaples(q, 8, section).map((st): Suggestion => ({ name: st.name, unit: st.unit, category: st.category, kcal: st.kcal, shelfMonths: st.shelfMonths }));
    const inSection = (x: Suggestion) => !section || x.category === section;
    const ordered = [...mine.filter(inSection).slice(0, 4), ...staples.filter(inSection), ...mine.filter((x) => !inSection(x)).slice(0, 2), ...staples.filter((x) => !inSection(x))];
    return ordered.filter((x, i, a) => a.findIndex((y) => y.name.toLowerCase() === x.name.toLowerCase()) === i).slice(0, 7);
  })();
  const showList = open && suggestions.length > 0;

  const onName = (name: string) => {
    // Typing an exact known name pre-fills its usual category/unit/location.
    const r = meta?.recent.find((x) => x.name.toLowerCase() === name.toLowerCase());
    onChange(r ? { ...value, name, category: r.category, unit: r.unit, location: value.location || r.location, kcal_per_unit: value.kcal_per_unit ?? r.kcal_per_unit, min_qty: value.min_qty ?? r.min_qty } : { ...value, name });
    setOpen(true); setHi(-1); setShelf(undefined);
  };

  const pick = (sg: Suggestion) => {
    onChange({
      ...value, name: sg.name, unit: sg.unit, category: sg.category,
      kcal_per_unit: sg.kcal ?? null,
      location: value.location || sg.location || '',
      min_qty: value.min_qty ?? sg.min_qty ?? null,
    });
    setShelf(sg.shelfMonths);
    setOpen(false); setHi(-1);
  };

  const onKey = (e: KeyboardEvent) => {
    if (!showList) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => (h + 1) % suggestions.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => (h <= 0 ? suggestions.length - 1 : h - 1)); }
    else if (e.key === 'Enter' && hi >= 0) { e.preventDefault(); pick(suggestions[hi]); }
    else if (e.key === 'Escape') { setOpen(false); }
  };

  return (
    <div class="form">
      <Field label="name">
        <div class="suggest-wrap">
          <input required name="item-name" value={value.name} placeholder={placeholder ?? PLACEHOLDER[section ?? value.category] ?? 'e.g. black beans'} autocomplete="off"
            role="combobox" aria-expanded={showList} aria-controls="item-suggest" aria-autocomplete="list"
            aria-activedescendant={hi >= 0 ? `sg-${hi}` : undefined}
            onInput={(e) => onName((e.target as HTMLInputElement).value)} onKeyDown={onKey}
            onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} />
          {showList && (
            <ul class="suggest" id="item-suggest" role="listbox">
              {suggestions.map((sg, i) => (
                <li key={sg.name} id={`sg-${i}`} role="option" aria-selected={i === hi} class={i === hi ? 'hi' : ''}
                  onMouseDown={(e) => { e.preventDefault(); pick(sg); }}>
                  <span class="sg-name">{sg.name}</span>
                  <span class="sg-meta">{[sg.mine ? 'yours' : null, sg.unit, sg.category, sg.kcal ? `${sg.kcal.toLocaleString()} kcal` : null, shelfLabel(sg.shelfMonths) || null].filter(Boolean).join(' · ')}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Field>
      <div class="row r3">
        <Field label="qty"><input type="number" inputMode="decimal" min="0" step="any" required value={value.qty} onInput={(e) => set('qty', Number((e.target as HTMLInputElement).value))} /></Field>
        <Field label="unit"><input list="dl-units" value={value.unit} onInput={(e) => set('unit', (e.target as HTMLInputElement).value)} /></Field>
        <Field label="category">
          <select value={value.category} onChange={(e) => set('category', (e.target as HTMLSelectElement).value)}>
            {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
          </select>
        </Field>
      </div>
      <div class="row">
        <Field label="expires / best by">
          <input type="date" value={value.expires_on ?? ''} onInput={(e) => set('expires_on', (e.target as HTMLInputElement).value || null)} />
        </Field>
        <Field label="location"><input list="dl-locs" value={value.location} onInput={(e) => set('location', (e.target as HTMLInputElement).value)} placeholder="Basement shelf A" /></Field>
      </div>
      <div class="chips" aria-label="Expiry shortcuts">
        {shelf != null && shelf > 0 && <button type="button" class="chip on" title="Typical shelf life for this item. Check the printed date." onClick={() => set('expires_on', addMonths(shelf))}>typical {shelfLabel(shelf)}</button>}
        {SHORTCUTS.map(([l, m]) => <button type="button" key={l} class="chip" onClick={() => set('expires_on', addMonths(m))}>{l}</button>)}
        <button type="button" class="chip" onClick={() => set('expires_on', null)}>no date</button>
      </div>
      {!more && <button type="button" class="ghost sm" onClick={() => setMore(true)}>+ min qty, calories, notes</button>}
      {more && (
        <>
          <div class="row">
            <Field label="min qty (alert below)"><input type="number" inputMode="decimal" min="0" step="any" value={value.min_qty ?? ''} onInput={(e) => set('min_qty', num((e.target as HTMLInputElement).value))} /></Field>
            <Field label="kcal per unit"><input type="number" inputMode="numeric" min="0" step="any" value={value.kcal_per_unit ?? ''} onInput={(e) => set('kcal_per_unit', num((e.target as HTMLInputElement).value))} /></Field>
          </div>
          <Field label="notes"><textarea value={value.notes ?? ''} onInput={(e) => set('notes', (e.target as HTMLTextAreaElement).value)} /></Field>
        </>
      )}
      <datalist id="dl-units">{[...new Set([...(meta?.units ?? []), ...UNITS])].map((u) => <option key={u} value={u} />)}</datalist>
      <datalist id="dl-locs">{meta?.locations.map((l) => <option key={l} value={l} />)}</datalist>
    </div>
  );
}

/** Every typed word starts some word of the name: "bla bea" matches "Black beans", "ac" doesn't. */
function wordPrefixMatch(name: string, q: string) {
  const words = name.toLowerCase().split(/[^a-z0-9%]+/).filter(Boolean);
  return q.split(/\s+/).filter(Boolean).every((t) => words.some((w) => w.startsWith(t)));
}

interface Suggestion { name: string; unit: string; category: string; kcal?: number; shelfMonths?: number; location?: string; min_qty?: number | null; mine?: boolean }

export const blankItem = (over: Partial<NewItem> = {}): NewItem => ({ name: '', category: 'food', qty: 1, unit: 'ea', location: '', expires_on: null, min_qty: null, kcal_per_unit: null, notes: '', ...over });
