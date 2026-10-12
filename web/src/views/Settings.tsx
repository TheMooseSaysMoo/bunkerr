import { useEffect, useState } from 'preact/hooks';
import { api, offline } from '../api';
import { navigate } from '../router';
import { Field, Loading, Modal, Panel, Prompt, ago, copyText, useApp, useFetch } from '../components/ui';
import type { Me, Role } from '../types';
import { LinksPanel } from './Linked';

export function Settings() {
  const { me } = useApp();
  return (
    <>
      <Prompt title="settings" sub={me.active ? `household: ${me.active.name}` : ''} />
      {me.active && <HouseholdPanel />}
      {me.active && <NotifyPanel />}
      {me.active && me.features.links && <LinksPanel />}
      <EmailPanel />
      <AccountPanel />
      {me.user.isAdmin && <AdminPanel />}
    </>
  );
}

// ---------------- household ----------------
interface HouseholdData {
  household: { id: number; name: string; receipt_quota: number };
  members: { id: number; name: string; email: string; role: Role; created_at: number }[];
  invites: { id: number; role: Role; note: string | null; email: string | null; emailed_at: number | null; created_at: number; expires_at: number }[];
}

interface InviteResult { url: string; emailed: boolean; emailedTo?: string; emailError?: string }

function InviteLink({ url, emailed, emailedTo, emailError, onClose }: InviteResult & { onClose: () => void }) {
  const { toast } = useApp();
  const share = async () => {
    if (navigator.share) { try { await navigator.share({ title: 'Bunkerr invite', url }); return; } catch { /* cancelled */ } }
    toast((await copyText(url)) ? 'Link copied' : 'Copy failed — select it manually', 'ok');
  };
  return (
    <Modal title="invite link" onClose={onClose} footer={<><button onClick={onClose}>done</button><button class="primary" onClick={share}>share / copy</button></>}>
      {emailed && <p class="ok" style="margin-top:0">✓ Emailed to <strong>{emailedTo}</strong>.</p>}
      {emailError && <p class="warn" style="margin-top:0">✗ Not emailed: {emailError}</p>}
      <p>{emailed ? 'You can also share the link yourself.' : 'Send this link.'} It works once and expires in 7 days.</p>
      <input readOnly value={url} onFocus={(e) => (e.target as HTMLInputElement).select()} aria-label="Invite link" />
    </Modal>
  );
}

function HouseholdPanel() {
  const { me, isOwner, toast, setMe, refreshMe } = useApp();
  const { data, reload } = useFetch<HouseholdData>('/api/household', [me.active?.id]);
  const [name, setName] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('member');
  const [link, setLink] = useState<InviteResult | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [newHh, setNewHh] = useState('');
  useEffect(() => { if (data) setName(data.household.name); }, [data]);

  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try { await fn(); toast(msg); reload(); } catch (e) { toast((e as Error).message, 'error'); }
  };

  if (!data) return <Panel title="household"><Loading /></Panel>;

  return (
    <Panel title="household" right={<span class="badge t-ok">{me.active!.role}</span>}>
      <div class="form">
        {isOwner ? (
          <form class="toolbar" style="margin:0" onSubmit={(e) => { e.preventDefault(); void act(async () => { await api.patch('/api/household', { name }); await refreshMe(); }, 'Renamed'); }}>
            <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} aria-label="Household name" />
            <button>rename</button>
          </form>
        ) : <p style="margin:0"><strong>{data.household.name}</strong></p>}

        <div>
          <h3 class="muted small" style="margin-bottom:6px">MEMBERS</h3>
          <ul class="list" style="border:1px solid var(--line);border-radius:4px">
            {data.members.map((m) => (
              <li key={m.id}>
                <div class="grow"><div class="title">{m.name}{m.id === me.user.id && <span class="muted"> (you)</span>}</div><div class="meta">{m.email}</div></div>
                {isOwner ? (
                  <select style="width:auto" value={m.role} aria-label={`Role for ${m.name}`} onChange={(e) => act(() => api.patch(`/api/household/members/${m.id}`, { role: (e.target as HTMLSelectElement).value }), 'Role updated')}>
                    <option value="owner">owner</option><option value="member">member</option><option value="viewer">viewer</option>
                  </select>
                ) : <span class="badge t-none">{m.role}</span>}
                {isOwner && m.id !== me.user.id && (
                  <button class="sm danger" onClick={() => confirm(`Remove ${m.name} from ${data.household.name}?`) && act(() => api.del(`/api/household/members/${m.id}`), 'Removed')} aria-label={`Remove ${m.name}`}>✗</button>
                )}
              </li>
            ))}
          </ul>
          <p class="muted small">owner: manage members &amp; settings · member: edit inventory, gardens, nodes · viewer: read-only</p>
        </div>

        {isOwner && (
          <div>
            <h3 class="muted small" style="margin-bottom:6px">INVITE TO THIS HOUSEHOLD</h3>
            <div class="toolbar" style="margin:0">
              <select style="width:auto" value={inviteRole} onChange={(e) => setInviteRole((e.target as HTMLSelectElement).value as Role)} aria-label="Invite role">
                <option value="member">as member</option><option value="viewer">as viewer</option><option value="owner">as owner</option>
              </select>
              <input type="email" style="flex:1;min-width:160px" placeholder={me.features.email ? 'email it to (optional)' : 'email (set up email to send)'} value={inviteEmail}
                onInput={(e) => setInviteEmail((e.target as HTMLInputElement).value.trim())} aria-label="Invitee email" />
              <button class="primary" onClick={async () => {
                try { const r = await api.post<InviteResult>('/api/household/invites', { role: inviteRole, email: inviteEmail }); setLink(r); setInviteEmail(''); reload(); }
                catch (e) { toast((e as Error).message, 'error'); }
              }}>{inviteEmail ? 'send invite' : 'create link'}</button>
            </div>
            {data.invites.length > 0 && (
              <ul class="list small" style="margin-top:8px">
                {data.invites.map((i) => (
                  <li key={i.id}>
                    <span class="grow">pending {i.role} invite{i.email ? <> to <strong>{i.email}</strong></> : ''} · {i.emailed_at ? `emailed ${ago(i.emailed_at)}` : `created ${ago(i.created_at)}`}</span>
                    {i.email && me.features.email && <button class="sm" onClick={() => act(() => api.post(`/api/household/invites/${i.id}/resend`, {}), `Re-sent to ${i.email}`)}>resend</button>}
                    <button class="sm" onClick={() => act(() => api.del(`/api/household/invites/${i.id}`), 'Invite revoked')}>revoke</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <hr />
        <form class="toolbar" style="margin:0" onSubmit={async (e) => { e.preventDefault(); try { setMe(await api.post<Me>('/api/households', { name: newHh })); setNewHh(''); toast('Household created & selected'); navigate('/'); } catch (err) { toast((err as Error).message, 'error'); } }}>
          <input placeholder="start another household (e.g. Cabin)" value={newHh} onInput={(e) => setNewHh((e.target as HTMLInputElement).value)} aria-label="New household name" required />
          <button>create</button>
        </form>
        <div class="toolbar" style="margin:0">
          <button class="danger sm" onClick={() => confirm(`Leave ${data.household.name}?`) && act(async () => { await api.del(`/api/household/members/${me.user.id}`); await refreshMe(); navigate('/'); }, 'Left household')}>leave household</button>
          {isOwner && (
            <button class="danger sm" onClick={async () => {
              const typed = prompt(`This deletes ALL inventory, gardens and nodes for "${data.household.name}". Type the household name to confirm:`);
              if (typed == null) return;
              try { await api.del('/api/household', { confirmName: typed }); await refreshMe(); toast('Household deleted'); navigate('/'); } catch (e) { toast((e as Error).message, 'error'); }
            }}>delete household</button>
          )}
        </div>
      </div>
      {link && <InviteLink {...link} onClose={() => setLink(null)} />}
    </Panel>
  );
}

// ---------------- notifications ----------------
interface SettingsData {
  timezone: string; digestEnabled: boolean; digestTime: string; expirySoonDays: number; expiryUpcomingDays: number;
  meshOfflineMinutes: number; meshLowBattery: number; people: number; kcalPerPersonDay: number; armoryEnabled: boolean; armoryViewers: boolean; armoryDigest: boolean;
  notify: { router: boolean; routerSource: string; discord: boolean; discordWebhook: string; ntfy: boolean; ntfyServer: string; ntfyTopic: string; ntfyToken: string };
}

function NotifyPanel() {
  const { me, isOwner, toast, refreshMe } = useApp();
  const { data } = useFetch<SettingsData>('/api/settings', [me.active?.id]);
  const [s, setS] = useState<SettingsData | null>(null);
  useEffect(() => { if (data) setS(data); }, [data]);
  if (!s) return <Panel title="alerts & notifications"><Loading /></Panel>;

  const set = <K extends keyof SettingsData>(k: K, v: SettingsData[K]) => setS({ ...s, [k]: v });
  const setN = <K extends keyof SettingsData['notify']>(k: K, v: SettingsData['notify'][K]) => setS({ ...s, notify: { ...s.notify, [k]: v } });
  const num = (e: Event) => Number((e.target as HTMLInputElement).value);
  const save = async () => {
    try {
      setS(await api.put('/api/settings', s));
      toast('Settings saved');
      // The armory switch changes the navigation.
      await refreshMe();
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const test = async () => {
    try {
      await api.put('/api/settings', s);
      const r = await api.post('/api/settings/test-notify');
      toast(r.errors.length ? `Errors: ${r.errors.join('; ')}` : `Sent via ${r.sent.join(', ')}`, r.errors.length ? 'error' : 'ok');
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  return (
    <Panel title="alerts & notifications" right={!isOwner && <span class="muted">owners can edit</span>}>
      <fieldset disabled={!isOwner} style="border:0;padding:0;margin:0" class="form">
        {me.features.router && (
          <>
            <label class="check">
              <input type="checkbox" checked={s.notify.router} disabled={!me.user.isAdmin} onChange={(e) => setN('router', (e.target as HTMLInputElement).checked)} />
              webhook router{!me.user.isAdmin && <span class="muted small"> — set by the instance admin</span>}
            </label>
            {s.notify.router && (
              <Field label="router source" hint="Sent as the message source; the router's rules decide where it goes. Discord/ntfy below are used only if the router is unreachable.">
                <input value={s.notify.routerSource} disabled={!me.user.isAdmin} onInput={(e) => setN('routerSource', (e.target as HTMLInputElement).value.trim())} />
              </Field>
            )}
          </>
        )}
        <label class="check"><input type="checkbox" checked={s.notify.discord} onChange={(e) => setN('discord', (e.target as HTMLInputElement).checked)} /> Discord webhook{s.notify.router ? ' (fallback)' : ''}</label>
        {s.notify.discord && (
          <Field label="discord webhook url" hint="Channel → Edit → Integrations → Webhooks → New → Copy URL">
            <input type="url" value={s.notify.discordWebhook} onInput={(e) => setN('discordWebhook', (e.target as HTMLInputElement).value.trim())} placeholder="https://discord.com/api/webhooks/…" />
          </Field>
        )}
        <label class="check"><input type="checkbox" checked={s.notify.ntfy} onChange={(e) => setN('ntfy', (e.target as HTMLInputElement).checked)} /> ntfy push{s.notify.router ? ' (fallback)' : ''}</label>
        {s.notify.ntfy && (
          <div class="row r3">
            <Field label="server"><input value={s.notify.ntfyServer} onInput={(e) => setN('ntfyServer', (e.target as HTMLInputElement).value.trim())} /></Field>
            <Field label="topic"><input value={s.notify.ntfyTopic} onInput={(e) => setN('ntfyTopic', (e.target as HTMLInputElement).value.trim())} placeholder="bunkerr-long-random" /></Field>
            <Field label="token (optional)"><input type="password" value={s.notify.ntfyToken} onInput={(e) => setN('ntfyToken', (e.target as HTMLInputElement).value.trim())} /></Field>
          </div>
        )}
        <hr />
        <label class="check"><input type="checkbox" checked={s.digestEnabled} onChange={(e) => set('digestEnabled', (e.target as HTMLInputElement).checked)} /> daily digest (expiring, low stock, watering, offline nodes)</label>
        <div class="row">
          <Field label="digest time"><input type="time" value={s.digestTime} onInput={(e) => set('digestTime', (e.target as HTMLInputElement).value)} /></Field>
          <Field label="timezone"><input value={s.timezone} onInput={(e) => set('timezone', (e.target as HTMLInputElement).value)} /></Field>
        </div>
        <div class="row">
          <Field label="“use soon” window (days)"><input type="number" min="1" value={s.expirySoonDays} onInput={(e) => set('expirySoonDays', num(e))} /></Field>
          <Field label="“upcoming” window (days)"><input type="number" min="1" value={s.expiryUpcomingDays} onInput={(e) => set('expiryUpcomingDays', num(e))} /></Field>
        </div>
        <div class="row">
          <Field label="node offline after (min)"><input type="number" min="5" value={s.meshOfflineMinutes} onInput={(e) => set('meshOfflineMinutes', num(e))} /></Field>
          <Field label="low battery (%)"><input type="number" min="0" max="100" value={s.meshLowBattery} onInput={(e) => set('meshLowBattery', num(e))} /></Field>
        </div>
        <div class="row">
          <Field label="people in household"><input type="number" min="1" value={s.people} onInput={(e) => set('people', num(e))} /></Field>
          <Field label="kcal / person / day"><input type="number" min="500" step="100" value={s.kcalPerPersonDay} onInput={(e) => set('kcalPerPersonDay', num(e))} /></Field>
        </div>
        <hr />
        <h3 class="muted small" style="margin:0 0 6px">ARMORY</h3>
        <label class="check"><input type="checkbox" checked={s.armoryEnabled} onChange={(e) => set('armoryEnabled', (e.target as HTMLInputElement).checked)} /> <span>armory tab <span class="muted small">(firearms, ammo, range log). Turn off if your household doesn’t own guns. Nothing is deleted.</span></span></label>
        <fieldset disabled={!s.armoryEnabled} style={`border:0;padding:0 0 0 26px;margin:0${s.armoryEnabled ? '' : ';opacity:.5'}`} class="form">
          <label class="check"><input type="checkbox" checked={s.armoryViewers} onChange={(e) => set('armoryViewers', (e.target as HTMLInputElement).checked)} /> show the armory to viewer accounts (serials stay masked)</label>
          <label class="check"><input type="checkbox" checked={s.armoryDigest} onChange={(e) => set('armoryDigest', (e.target as HTMLInputElement).checked)} /> include low ammo &amp; cleaning due in the daily digest (never serials)</label>
        </fieldset>
        {isOwner && <div class="toolbar"><button onClick={test}>send test</button><button class="primary" onClick={save}>save</button></div>}
      </fieldset>
    </Panel>
  );
}

// ---------------- account ----------------
function AccountPanel() {
  const { me, toast, setMe } = useApp();
  const [name, setName] = useState(me.user.name);
  const [pw, setPw] = useState({ current: '', next: '' });
  const logout = async () => {
    const pending = offline.state().pending;
    if (pending && !confirm(`${pending} offline change${pending === 1 ? ' hasn’t' : 's haven’t'} synced yet and will be lost. Log out anyway?`)) return;
    try { await api.post('/api/auth/logout'); } catch { /* offline: the device copy is still cleared */ }
    // Nothing from this account stays on the device.
    await offline.clearAll();
    location.hash = '#/'; location.reload();
  };
  return (
    <Panel title="account" right={<span class="muted">{me.user.email}</span>}>
      <div class="form">
        <form class="toolbar" style="margin:0" onSubmit={async (e) => { e.preventDefault(); try { setMe(await api.patch('/api/me', { name })); toast('Name updated'); } catch (err) { toast((err as Error).message, 'error'); } }}>
          <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} aria-label="Display name" /><button>update name</button>
        </form>
        <form class="form" onSubmit={async (e) => { e.preventDefault(); try { await api.post('/api/me/password', pw); setPw({ current: '', next: '' }); toast('Password changed; other sessions signed out'); } catch (err) { toast((err as Error).message, 'error'); } }}>
          <div class="row">
            <Field label="current password"><input type="password" autocomplete="current-password" value={pw.current} onInput={(e) => setPw({ ...pw, current: (e.target as HTMLInputElement).value })} /></Field>
            <Field label="new password (10+)"><input type="password" autocomplete="new-password" minLength={10} value={pw.next} onInput={(e) => setPw({ ...pw, next: (e.target as HTMLInputElement).value })} /></Field>
          </div>
          <div class="toolbar"><button disabled={!pw.current || pw.next.length < 10}>change password</button><span style="flex:1" /><button type="button" class="danger" onClick={logout}>log out</button></div>
        </form>
      </div>
    </Panel>
  );
}

// ---------------- admin ----------------
interface AdminData {
  users: { id: number; email: string; name: string; is_admin: number; disabled: number; created_at: number; households: string | null }[];
  households: { id: number; name: string; receipt_quota: number; members: number; items: number; nodes: number; receipts_this_month: number }[];
  invites: { id: number; note: string | null; email: string | null; emailed_at: number | null; created_at: number; expires_at: number }[];
}

function AdminPanel() {
  const { me, toast } = useApp();
  const { data, reload } = useFetch<AdminData>('/api/admin/overview');
  const inst = useFetch<Me['instance']>('/api/instance');
  const [link, setLink] = useState<InviteResult | null>(null);
  const [note, setNote] = useState('');
  const [email, setEmail] = useState('');
  const act = async (fn: () => Promise<unknown>, msg: string) => { try { await fn(); toast(msg); reload(); } catch (e) { toast((e as Error).message, 'error'); } };
  if (!data) return <Panel title="admin"><Loading /></Panel>;

  return (
    <Panel title="instance admin" right={<span class="warn">admin</span>}>
      <div class="form">
        {inst.data && (
          <pre class="mono-pre small">{[
            `node      ${inst.data.node} (${inst.data.role})`,
            `active    ${inst.data.active ? 'yes' : 'NO'}${inst.data.promoted ? ' (promoted standby)' : ''}${inst.data.peerActive ? ' — peer is active (fenced)' : ''}`,
            `last sync ${inst.data.lastSyncAt ? ago(inst.data.lastSyncAt) : inst.data.role === 'standby' ? 'never' : 'n/a (primary)'}${inst.data.lastSyncError ? `  ERR ${inst.data.lastSyncError}` : ''}`,
          ].join('\n')}</pre>
        )}
        <div>
          <h3 class="muted small" style="margin-bottom:6px">INVITE SOMEONE TO START THEIR OWN HOUSEHOLD</h3>
          <div class="toolbar" style="margin:0">
            <input style="flex:1;min-width:140px" placeholder="note (who is it for?)" value={note} onInput={(e) => setNote((e.target as HTMLInputElement).value)} aria-label="Invite note" />
            <input type="email" style="flex:1;min-width:160px" placeholder="email it to (optional)" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value.trim())} aria-label="Invitee email" />
            <button class="primary" onClick={async () => {
              try { const r = await api.post<InviteResult>('/api/admin/invites', { note: note || undefined, email }); setLink(r); setNote(''); setEmail(''); reload(); }
              catch (e) { toast((e as Error).message, 'error'); }
            }}>{email ? 'send invite' : 'create link'}</button>
          </div>
          {data.invites.map((i) => (
            <div key={i.id} class="small toolbar" style="margin:6px 0 0">
              <span class="grow">pending: {i.note ?? 'new household'}{i.email ? <> · <strong>{i.email}</strong></> : ''} · {i.emailed_at ? `emailed ${ago(i.emailed_at)}` : ago(i.created_at)}</span>
              {i.email && me.features.email && <button class="sm" onClick={() => act(() => api.post(`/api/admin/invites/${i.id}/resend`, {}), `Re-sent to ${i.email}`)}>resend</button>}
              <button class="sm" onClick={() => act(() => api.del(`/api/admin/invites/${i.id}`), 'Revoked')}>revoke</button>
            </div>
          ))}
        </div>

        <div class="table-wrap">
          <table class="t">
            <thead><tr><th>household</th><th class="num">members</th><th class="num">items</th><th class="num">nodes</th><th class="num">photos/quota</th></tr></thead>
            <tbody>
              {data.households.map((h) => (
                <tr key={h.id}>
                  <td>{h.name}</td><td class="num">{h.members}</td><td class="num">{h.items}</td><td class="num">{h.nodes}</td>
                  <td class="num">
                    {h.receipts_this_month}/
                    <button class="sm ghost" onClick={() => { const q = prompt(`Monthly photo-import quota for ${h.name}`, String(h.receipt_quota)); if (q != null) void act(() => api.patch(`/api/admin/households/${h.id}`, { receiptQuota: Number(q) }), 'Quota updated'); }}>{h.receipt_quota}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div class="table-wrap">
          <table class="t">
            <thead><tr><th>user</th><th>households</th><th></th></tr></thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id} style={u.disabled ? 'opacity:.5' : ''}>
                  <td><div>{u.name}{u.is_admin ? <span class="warn"> ★</span> : ''}</div><div class="muted small">{u.email}</div></td>
                  <td class="small">{u.households ?? '—'}</td>
                  <td style="white-space:nowrap">
                    {u.id !== me.user.id && <>
                      <button class="sm" onClick={() => act(() => api.patch(`/api/admin/users/${u.id}`, { disabled: !u.disabled }), u.disabled ? 'Enabled' : 'Disabled')}>{u.disabled ? 'enable' : 'disable'}</button>
                      <button class="sm" onClick={async () => { if (!confirm(`Reset password for ${u.email}?`)) return; try { const r = await api.post(`/api/admin/users/${u.id}/reset-password`); prompt('Temporary password (give it to them; they should change it):', r.tempPassword); } catch (e) { toast((e as Error).message, 'error'); } }}>reset pw</button>
                    </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <SmtpSettings />
        <AccessRequests />
        <BarcodeDb />
      </div>
      {link && <InviteLink {...link} onClose={() => setLink(null)} />}
    </Panel>
  );
}

// ---------------- email alerts (everyone) ----------------
interface EmailPrefs { available: boolean; email: string; households: { household_id: number; name: string; role: string; digest: boolean; alerts: boolean }[]; accessRequests: boolean | null }

function EmailPanel() {
  const { me, toast } = useApp();
  const { data, reload, setData } = useFetch<EmailPrefs>('/api/me/email', [me.households.length]);
  if (!data) return null;
  const set = async (h: EmailPrefs['households'][number], patch: Partial<{ digest: boolean; alerts: boolean }>) => {
    // Send only the box that changed; the server keeps the other one.
    setData((d) => d && { ...d, households: d.households.map((x) => (x.household_id === h.household_id ? { ...x, ...patch } : x)) });
    try { await api.put(`/api/me/email/households/${h.household_id}`, patch); } catch (e) { toast((e as Error).message, 'error'); reload(); }
  };
  const setAccess = async (on: boolean) => {
    setData((d) => d && { ...d, accessRequests: on });
    try { await api.put('/api/me/email/access-requests', { on }); } catch (e) { toast((e as Error).message, 'error'); reload(); }
  };
  const test = async () => { try { const r = await api.post('/api/me/email/test'); toast(`Sent to ${r.to}`); } catch (e) { toast((e as Error).message, 'error'); } };

  return (
    <Panel title="email alerts">
      {!data.available ? (
        <p class="muted" style="margin:0">Email isn’t set up on this instance yet.{me.user.isAdmin ? ' Set up the mail server under instance admin → email (SMTP), below.' : ' Ask the admin to set it up.'}</p>
      ) : (
        <div class="form">
          <p class="muted small" style="margin:0">Sent to <strong>{data.email}</strong>. This is in addition to the household’s Discord / ntfy alerts, and every email has an unsubscribe link.</p>
          {data.households.length === 0 && <p class="muted">You’re not in a household yet.</p>}
          {data.households.map((h) => (
            <fieldset key={h.household_id} class="panel" style="margin:0;padding:10px 12px">
              <legend class="small" style="padding:0 6px">{h.name} <span class="muted">({h.role})</span></legend>
              <label class="check"><input type="checkbox" checked={h.digest} onChange={(e) => set(h, { digest: (e.target as HTMLInputElement).checked })} /> <span>daily digest <span class="muted small">(expiring, low stock, watering, power upkeep)</span></span></label>
              <label class="check"><input type="checkbox" checked={h.alerts} onChange={(e) => set(h, { alerts: (e.target as HTMLInputElement).checked })} /> <span>urgent alerts <span class="muted small">(mesh node offline, low battery)</span></span></label>
            </fieldset>
          ))}
          {data.accessRequests != null && (
            <label class="check"><input type="checkbox" checked={data.accessRequests} onChange={(e) => setAccess((e.target as HTMLInputElement).checked)} /> <span>email me new access requests <span class="muted small">(admin)</span></span></label>
          )}
          <div><button class="sm" onClick={test}>send me a test email</button></div>
        </div>
      )}
    </Panel>
  );
}

// ---------------- admin: SMTP ----------------
interface SmtpConfig { enabled: boolean; host: string; port: number; security: 'starttls' | 'tls' | 'none'; user: string; from_email: string; from_name: string; has_password: boolean; ready: boolean; password_unreadable: boolean }
const SMTP_PRESETS: { label: string; host: string; port: number; security: SmtpConfig['security']; note: string }[] = [
  { label: 'Gmail / Google Workspace', host: 'smtp.gmail.com', port: 587, security: 'starttls', note: 'Needs 2-step verification and an app password (Google account → Security → App passwords).' },
  { label: 'Microsoft 365', host: 'smtp.office365.com', port: 587, security: 'starttls', note: 'SMTP AUTH must be enabled for the mailbox. Personal Outlook.com accounts may need an app password.' },
  { label: 'iCloud Mail', host: 'smtp.mail.me.com', port: 587, security: 'starttls', note: 'Use an app-specific password from appleid.apple.com.' },
  { label: 'Fastmail', host: 'smtp.fastmail.com', port: 465, security: 'tls', note: 'Use an app password from Settings → Privacy & Security.' },
  { label: 'Zoho Mail', host: 'smtp.zoho.com', port: 465, security: 'tls', note: '' },
];

function SmtpSettings() {
  const { me, toast } = useApp();
  const { data, reload } = useFetch<SmtpConfig>('/api/admin/smtp');
  const [v, setV] = useState<(Omit<SmtpConfig, 'has_password' | 'ready' | 'password_unreadable'> & { pass: string }) | null>(null);
  const [note, setNote] = useState('');
  const [testTo, setTestTo] = useState('');
  const [last, setLast] = useState<{ to: string; host: string; response: string; messageId: string; accepted: string[]; rejected: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data && !v) { const { has_password: _h, ready: _r, password_unreadable: _p, ...rest } = data; setV({ ...rest, pass: '' }); } }, [data]);
  if (!data || !v) return null;
  const set = <K extends keyof typeof v>(k: K, val: (typeof v)[K]) => setV({ ...v, [k]: val });
  const preset = (label: string) => {
    const p = SMTP_PRESETS.find((x) => x.label === label);
    if (!p) return;
    setV({ ...v, host: p.host, port: p.port, security: p.security, from_email: v.from_email || v.user });
    setNote(p.note);
  };
  const save = async () => {
    setBusy(true);
    try {
      // An empty password field means "keep the saved one".
      await api.put('/api/admin/smtp', { ...v, pass: v.pass ? v.pass : undefined });
      toast('Email settings saved'); setV({ ...v, pass: '' }); reload();
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const test = async () => {
    setBusy(true);
    try { const r = await api.post('/api/admin/smtp/test', testTo ? { to: testTo } : {}); setLast(r); toast(`Test sent to ${r.to}`); }
    catch (e) { setLast(null); toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };

  return (
    <div>
      <h3 class="muted small" style="margin-bottom:6px">EMAIL (SMTP) {data.ready ? <span class="badge t-ok">on</span> : <span class="badge t-none">off</span>}</h3>
      <div class="form">
        <Field label="preset"><select value="" onChange={(e) => preset((e.target as HTMLSelectElement).value)}><option value="">choose a provider…</option>{SMTP_PRESETS.map((p) => <option key={p.label}>{p.label}</option>)}</select></Field>
        {note && <p class="muted small" style="margin:0">{note}</p>}
        <div class="row r3">
          <Field label="SMTP host"><input value={v.host} placeholder="smtp.example.com" autocapitalize="off" onInput={(e) => set('host', (e.target as HTMLInputElement).value.trim())} /></Field>
          <Field label="port"><input type="number" min="1" max="65535" value={v.port} onInput={(e) => set('port', Number((e.target as HTMLInputElement).value))} /></Field>
          <Field label="security">
            <select value={v.security} onChange={(e) => { const s = (e.target as HTMLSelectElement).value as SmtpConfig['security']; setV({ ...v, security: s, port: s === 'tls' ? 465 : s === 'starttls' && v.port === 465 ? 587 : v.port }); }}>
              <option value="starttls">STARTTLS (587)</option><option value="tls">TLS (465)</option><option value="none">none (LAN relay)</option>
            </select>
          </Field>
        </div>
        <div class="row">
          <Field label="username"><input value={v.user} autocomplete="off" autocapitalize="off" placeholder="you@example.com" onInput={(e) => set('user', (e.target as HTMLInputElement).value.trim())} /></Field>
          <Field label="password" hint={data.password_unreadable ? 'saved password can’t be read (INTERNAL_SECRET changed?). Enter it again' : data.has_password ? 'saved. Leave blank to keep it' : 'app password recommended'}>
            <input type="password" autocomplete="new-password" value={v.pass} placeholder={data.has_password ? '••••••••' : ''} onInput={(e) => set('pass', (e.target as HTMLInputElement).value)} />
          </Field>
        </div>
        <div class="row">
          <Field label="from address"><input type="email" value={v.from_email} placeholder="bunkerr@example.com" onInput={(e) => set('from_email', (e.target as HTMLInputElement).value.trim())} /></Field>
          <Field label="from name"><input value={v.from_name} onInput={(e) => set('from_name', (e.target as HTMLInputElement).value)} /></Field>
        </div>
        <label class="check"><input type="checkbox" checked={v.enabled} onChange={(e) => set('enabled', (e.target as HTMLInputElement).checked)} /> send email from this instance</label>
        <div class="toolbar" style="margin:0">
          <button class="sm primary" disabled={busy} onClick={save}>save</button>
          <input style="flex:1;min-width:140px" type="email" placeholder={`test to ${me.user.email}`} value={testTo} onInput={(e) => setTestTo((e.target as HTMLInputElement).value.trim())} aria-label="Test recipient" />
          <button class="sm" disabled={busy || !data.ready} onClick={test}>send test</button>
        </div>
        {last && (
          <pre class="mono-pre small" style="white-space:pre-wrap;word-break:break-all">{[
            `to         ${last.to}`,
            `accepted   ${last.accepted.join(', ') || '—'}${last.rejected.length ? `   REFUSED ${last.rejected.join(', ')}` : ''}`,
            `server     ${last.host}: ${last.response || '(no reply text)'}`,
            `message-id ${last.messageId}`,
            '',
            'Accepted means the mail server took it. If it doesn’t arrive, check spam / quarantine,',
            'and the sending mailbox for a bounce. Give the provider the message-id to trace it.',
          ].join('\n')}</pre>
        )}
        <p class="muted small" style="margin:0">The password is encrypted at rest with this instance’s INTERNAL_SECRET. Email only goes out from the active instance. People choose what they get under <em>email alerts</em> above.</p>
      </div>
    </div>
  );
}

interface AccessRequest { id: number; email: string; name: string; note: string; status: string; created_at: number; decided_at: number | null; decided_by: string | null }

function AccessRequests() {
  const { toast } = useApp();
  const { data, reload } = useFetch<AccessRequest[]>('/api/admin/access-requests');
  if (!data) return null;
  const act = async (id: number, action: 'approve' | 'reject') => {
    try { await api.post(`/api/admin/access-requests/${id}/${action}`); toast(action === 'approve' ? 'Approved. They can now set a password from their status link.' : 'Rejected'); reload(); }
    catch (e) { toast((e as Error).message, 'error'); reload(); }
  };
  const pending = data.filter((r) => r.status === 'pending');
  const recent = data.filter((r) => r.status !== 'pending').slice(0, 8);
  return (
    <div>
      <h3 class="muted small" style="margin-bottom:6px">ACCESS REQUESTS {pending.length > 0 && <span class="badge t-soon">{pending.length} waiting</span>}</h3>
      <p class="muted small" style="margin:0 0 6px">From <a href="#/request">#/request</a> on the login page. You also get these in Discord: react ✅ or ❌.</p>
      {pending.length === 0 && <p class="muted small">Nothing waiting.</p>}
      {pending.map((r) => (
        <div key={r.id} class="toolbar" style="margin:6px 0 0;flex-wrap:wrap">
          <span class="grow"><strong>{r.name}</strong> <span class="muted small">{r.email} · {ago(r.created_at)}</span>{r.note && <div class="muted small">“{r.note}”</div>}</span>
          <button class="sm primary" onClick={() => act(r.id, 'approve')}>approve</button>
          <button class="sm" onClick={() => act(r.id, 'reject')}>reject</button>
        </div>
      ))}
      {recent.length > 0 && (
        <details style="margin-top:8px"><summary class="muted small">recent decisions</summary>
          {recent.map((r) => <div key={r.id} class="small muted">{r.status} · {r.name} &lt;{r.email}&gt;{r.decided_by ? ` · by ${r.decided_by}` : ''}{r.decided_at ? ` · ${ago(r.decided_at)}` : ''}</div>)}
        </details>
      )}
    </div>
  );
}

interface BarcodeStatus {
  enabled: boolean; products: number; sizeMb: number; running: boolean;
  sources: { source: string; label: string; license: string; version: string | null; rows: number; builtAt: number | null; checkedAt: number | null; error: string | null; running: boolean; progress: number }[];
}

function BarcodeDb() {
  const { toast } = useApp();
  const { data, reload } = useFetch<BarcodeStatus>('/api/admin/barcodes');
  // Poll while a refresh runs so progress moves.
  useEffect(() => {
    if (!data?.running) return;
    const t = setTimeout(reload, 4000);
    return () => clearTimeout(t);
  }, [data]);
  if (!data) return null;
  const start = async (source?: string) => {
    try { await api.post('/api/admin/barcodes/refresh', { source, force: true }); toast('Refresh started'); setTimeout(reload, 500); } catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <div>
      <h3 class="muted small" style="margin-bottom:6px">OFFLINE BARCODE DATABASE (THIS INSTANCE)</h3>
      {!data.enabled ? <p class="muted small">Disabled (BARCODE_MIRROR=off). Scans use online lookups only.</p> : (
        <>
          <pre class="mono-pre small">{[
            `products  ${data.products.toLocaleString()} distinct · ${data.sizeMb} MB`,
            ...data.sources.map((s) => `${s.source.padEnd(9)} ${s.running ? `importing… ${s.progress.toLocaleString()}` : `${s.rows.toLocaleString()} rows`}`
              + `${s.version ? ` · ${s.version}` : ''}${s.builtAt ? ` · built ${ago(s.builtAt)}` : ' · not built yet'}${s.error ? `\n          ERR ${s.error}` : ''}`),
          ].join('\n')}</pre>
          <p class="muted small" style="margin:6px 0">Refreshed nightly at 02:20 when due (USDA on each new release, Open Food Facts monthly). A full refresh downloads about 1.5 GB and takes a few minutes.</p>
          <div class="toolbar" style="margin:0">
            <button class="sm" disabled={data.running} onClick={() => start()}>refresh all now</button>
            {data.sources.map((s) => <button key={s.source} class="sm ghost" disabled={data.running} onClick={() => start(s.source)}>{s.source} only</button>)}
          </div>
        </>
      )}
    </div>
  );
}
