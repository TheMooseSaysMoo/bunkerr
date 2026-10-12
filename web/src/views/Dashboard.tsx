import { Empty, Loading, Panel, Prompt, ago, fmtQty, relDays, useApp, useFetch } from '../components/ui';
import type { GardenTask, Link } from '../types';

interface Dash {
  today: string;
  people: number;
  expired: { id: number; name: string; qty: number; unit: string; location: string; expires_on: string }[];
  soon: { id: number; name: string; qty: number; unit: string; location: string; expires_on: string }[];
  lowStock: { name: string; unit: string; total: number; min_qty: number }[];
  counts: { category: string; batches: number; qty: number }[];
  foodDays: number | null; foodKcalItems: number; waterGallons: number; waterDays: number | null;
  tasks: GardenTask[]; waterDue: GardenTask[]; harvestReady: GardenTask[];
  armory: { calibers: { key: string; label: string; rounds: number; min: number | null }[]; lowAmmo: { key: string; label: string; rounds: number; min: number }[]; cleaningDue: { id: number; label: string; since: number }[]; firearmCount: number; totalRounds: number } | null;
  power: { count: number; due: PowerTask[]; soon: PowerTask[] };
  mesh: { total: number; pending: number; offline: { id: number; name: string; site: string; last_heard: number | null }[]; lowBattery: { id: number; name: string; battery: number }[] };
  linked: Link[];
}

interface PowerTask { id: number; equipment_name: string; label: string; next_due_on: string; days_until: number }

const days = (n: number | null) => (n == null ? '—' : n >= 365 ? `${(n / 365).toFixed(1)}y` : `${Math.floor(n)}d`);

export function Dashboard() {
  const { me } = useApp();
  const { data: d, error } = useFetch<Dash>('/api/dashboard', [me.active?.id]);
  if (!d) return <><Prompt title="status" /><Loading error={error} /></>;

  const useFirst = [...d.expired, ...d.soon];
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';

  return (
    <>
      <Prompt title="status" sub={`good ${greet}, ${me.user.name.split(' ')[0]} · ${d.today}`}>
        <a class="btn primary" href="#/add">add items</a>
      </Prompt>

      <div class="grid stats" style="margin-bottom:14px">
        <a class={`stat ${d.expired.length ? 'red' : 'green'}`} href="#/inventory?tier=expired">
          <div class="k">expired</div><div class="v">{d.expired.length}</div><div class="n">batches</div>
        </a>
        <a class={`stat ${d.soon.length ? 'amber' : 'green'}`} href="#/inventory?tier=soon">
          <div class="k">use soon</div><div class="v">{d.soon.length}</div><div class="n">within 30d</div>
        </a>
        <div class="stat cyan">
          <div class="k">food</div><div class="v">{days(d.foodDays)}</div>
          <div class="n">{d.foodDays == null ? 'add kcal/unit to items' : `for ${d.people} people`}</div>
        </div>
        <div class="stat cyan">
          <div class="k">water</div><div class="v">{days(d.waterDays)}</div>
          <div class="n">{d.waterGallons ? `${fmtQty(+d.waterGallons.toFixed(1))} gal · 1 gal/p/d` : 'track water in gal or L'}</div>
        </div>
      </div>

      <div class="grid c2">
        <Panel title="use first" right={<a href="#/inventory?sort=expiry">all →</a>} flush>
          {useFirst.length === 0 ? <Empty>nothing expiring in the next 30 days</Empty> : (
            <ul class="list">
              {useFirst.slice(0, 10).map((i) => (
                <li key={i.id}>
                  <span class={i.expires_on < d.today ? 't-expired' : 't-soon'} aria-hidden="true">{i.expires_on < d.today ? '✗' : '!'}</span>
                  <div class="grow">
                    <div class="title">{i.name}</div>
                    <div class="meta">{fmtQty(i.qty)} {i.unit}{i.location ? ` · ${i.location}` : ''}</div>
                  </div>
                  <span class={`small ${i.expires_on < d.today ? 't-expired' : 't-soon'}`}>{relDays(i.expires_on, d.today)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="garden today" right={<a href="#/garden">gardens →</a>} flush>
          {d.waterDue.length === 0 && d.harvestReady.length === 0 ? <Empty>no garden chores due</Empty> : (
            <ul class="list">
              {groupByGarden(d.waterDue).map(([garden, items]) => (
                <li key={`w-${garden}`}>
                  <span style="color:var(--cyan)" aria-hidden="true">~</span>
                  <div class="grow"><div class="title">Water {garden}</div><div class="meta">{[...new Set(items.map((t) => t.plant))].join(', ')}</div></div>
                  <a class="btn sm" href={`#/garden/${items[0].garden_id}`}>open</a>
                </li>
              ))}
              {d.harvestReady.map((t) => (
                <li key={`h-${t.planting_id}`}>
                  <span class="t-soon" aria-hidden="true">*</span>
                  <div class="grow"><div class="title">Harvest {t.plant}</div><div class="meta">{t.garden} · ready {relDays(t.date, d.today)}</div></div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="mesh" right={<a href="#/mesh">nodes →</a>}>
          {d.mesh.total === 0 ? <p class="muted">No nodes claimed yet. <a href="#/mesh">Add your Meshtastic nodes</a>.</p> : (
            <>
              <p>
                <span class={d.mesh.offline.length ? 'err' : 'ok'}>{d.mesh.total - d.mesh.offline.length - d.mesh.pending}/{d.mesh.total} online</span>
                {d.mesh.pending > 0 && <span class="muted"> · {d.mesh.pending} waiting for first packet</span>}
                {d.mesh.lowBattery.length > 0 && <span class="warn"> · {d.mesh.lowBattery.length} low battery</span>}
              </p>
              {d.mesh.offline.map((n) => <div key={n.id} class="small err">⚠ {n.name}{n.site ? ` @ ${n.site}` : ''}</div>)}
            </>
          )}
        </Panel>

        {d.power.count > 0 && (
          <Panel title="power upkeep" right={<a href="#/inventory/power">power →</a>} flush>
            {d.power.due.length + d.power.soon.length === 0 ? <Empty>{d.power.count} devices · nothing due this week</Empty> : (
              <ul class="list">
                {[...d.power.due, ...d.power.soon].slice(0, 8).map((t) => (
                  <li key={t.id}>
                    <span class={t.days_until <= 0 ? 't-expired' : 't-soon'} aria-hidden="true">⚡</span>
                    <div class="grow"><div class="title">{t.equipment_name}</div><div class="meta">{t.label}</div></div>
                    <span class={`small ${t.days_until <= 0 ? 't-expired' : 't-soon'}`}>{t.days_until < 0 ? `${-t.days_until}d overdue` : relDays(t.next_due_on, d.today)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}

        {d.armory && (d.armory.firearmCount > 0 || d.armory.totalRounds > 0) && (
          <Panel title="armory" right={<a href="#/armory/ammo">ammo →</a>}>
            <p style="margin:0 0 6px">{d.armory.firearmCount} firearms · <strong>{d.armory.totalRounds.toLocaleString()}</strong> rounds</p>
            <div class="small">{d.armory.calibers.slice(0, 6).map((c) => (
              <div key={c.key} class={c.min != null && c.rounds < c.min ? 'warn' : ''}>{c.label.padEnd(16, '\u00a0')} {c.rounds.toLocaleString()}{c.min != null && c.rounds < c.min ? ` / ${c.min} ↓` : ''}</div>
            ))}</div>
            {d.armory.cleaningDue.length > 0 && <p class="warn small" style="margin:6px 0 0"># cleaning due: {d.armory.cleaningDue.map((f) => f.label).join(', ')}</p>}
          </Panel>
        )}

        {d.linked.length > 0 && (
          <Panel title="linked households" right={<a href="#/linked">all →</a>} flush>
            <ul class="list">
              {d.linked.map((l) => (
                <li key={l.id}>
                  <span aria-hidden="true">⇄</span>
                  <a class="grow" href={`#/linked/${l.id}`} style="color:inherit;text-decoration:none">
                    <div class="title">{l.peer_household || l.peer_host}</div>
                    <div class="meta">
                      {l.status === 'ended' ? <span class="err">link ended</span>
                        : l.summary ? `food ${days(l.summary.foodDays)} · water ${days(l.summary.waterDays)}${l.summary.expired ? ` · ${l.summary.expired} expired` : ''}` : 'no summary shared'}
                      {l.status === 'active' && <span class={l.pull_error ? 'warn' : ''}> · {l.feed_at ? ago(l.feed_at) : 'waiting'}</span>}
                    </div>
                  </a>
                </li>
              ))}
            </ul>
          </Panel>
        )}

        <Panel title="low stock" right={<a href="#/inventory">inventory →</a>} flush>
          {d.lowStock.length === 0 ? <Empty>nothing below its minimum (set “min qty” on items)</Empty> : (
            <ul class="list">
              {d.lowStock.map((l) => (
                <li key={l.name}><span class="warn" aria-hidden="true">↓</span><div class="grow title">{l.name}</div><span class="small">{fmtQty(l.total)}/{fmtQty(l.min_qty)} {l.unit}</span></li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="stock by category">
        {d.counts.length === 0 ? <p class="muted">Inventory is empty. <a href="#/add">Scan or add your first items</a>.</p> : (
          <div class="chips">
            {d.counts.map((c) => <a key={c.category} class="chip" href={`#/inventory/${c.category}`}>{c.category} · {c.batches}</a>)}
          </div>
        )}
      </Panel>
    </>
  );
}

function groupByGarden(tasks: GardenTask[]): [string, GardenTask[]][] {
  const m = new Map<string, GardenTask[]>();
  tasks.forEach((t) => m.set(t.garden, [...(m.get(t.garden) ?? []), t]));
  return [...m.entries()];
}
