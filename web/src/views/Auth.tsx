import { useEffect, useState } from 'preact/hooks';
import { api } from '../api';
import { navigate } from '../router';
import { Field, copyText, useApp } from '../components/ui';
import type { Me } from '../types';

const LOGO = String.raw`
 ____  _   _ _   _ _  _______ ____  ____
| __ )| | | | \ | | |/ / ____|  _ \|  _ \
|  _ \| | | |  \| | ' /|  _| | |_) | |_) |
| |_) | |_| | |\  | . \| |___|  _ <|  _ <
|____/ \___/|_| \_|_|\_\_____|_| \_\_| \_\
`;

export function Login({ onAuthed }: { onAuthed: (m: Me) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { onAuthed(await api.post<Me>('/api/auth/login', { email, password })); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div class="auth">
      <div class="box">
        <pre class="logo" aria-label="Bunkerr">{LOGO}</pre>
        <form class="panel" onSubmit={submit}>
          <div class="ph"><span>login</span></div>
          <div class="pb form">
            <Field label="email"><input type="email" autocomplete="username" required value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} /></Field>
            <Field label="password"><input type="password" autocomplete="current-password" required value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} /></Field>
            {error && <p class="err" role="alert">✗ {error}</p>}
            <button class="primary" disabled={busy}>{busy ? 'authenticating…' : 'login'}</button>
            {typeof navigator !== 'undefined' && !navigator.onLine && <p class="warn small">You’re offline. Log in once while online, and this device keeps a copy of your household to use offline.</p>}
            <p class="muted small">No account? <a href="#/request">Request access</a>, or ask a household owner for an invite link.</p>
          </div>
        </form>
        <SavedRequest />
      </div>
    </div>
  );
}

// ---------------- request access ----------------
const REQ_KEY = 'bunkerr.request';
const savedToken = () => { try { return localStorage.getItem(REQ_KEY); } catch { return null; } };
const saveToken = (t: string | null) => { try { if (t) localStorage.setItem(REQ_KEY, t); else localStorage.removeItem(REQ_KEY); } catch { /* private mode */ } };

interface ReqStatus { status: 'pending' | 'approved' | 'rejected' | 'completed'; name: string; email: string; createdAt: number; decidedAt: number | null }

/** On the login page: "your request is pending / approved" when this device made one. */
function SavedRequest() {
  const [token] = useState(savedToken);
  const [st, setSt] = useState<ReqStatus | null>(null);
  useEffect(() => {
    if (!token) return;
    const check = () => api.get<ReqStatus>(`/api/access-requests/status/${token}`)
      .then((s) => { if (s.status === 'completed') { saveToken(null); setSt(null); } else setSt(s); })
      .catch((e) => { if (/not found/i.test((e as Error).message)) saveToken(null); });
    void check();
    // Re-check when they come back to the tab, so an approval shows without a reload.
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, [token]);
  if (!token || !st) return null;
  return (
    <div class="panel">
      <div class="ph"><span>your access request</span></div>
      <div class="pb form">
        <p>{st.status === 'pending' ? 'Waiting for approval.' : st.status === 'approved' ? 'Approved! Finish setting up your account.' : 'This request was not approved.'}</p>
        <a class={st.status === 'approved' ? 'btn primary' : 'btn'} href={`#/request/${token}`}>{st.status === 'approved' ? 'choose a password' : 'view request'}</a>
      </div>
    </div>
  );
}

export function RequestAccess({ token, onAuthed }: { token?: string; onAuthed: (m: Me) => void }) {
  const [form, setForm] = useState({ name: '', email: '', note: '', website: '' });
  const [st, setSt] = useState<ReqStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pw, setPw] = useState({ password: '', confirm: '', householdName: '' });

  const load = (t: string) => api.get<ReqStatus>(`/api/access-requests/status/${t}`).then(setSt).catch((e) => setError((e as Error).message));
  useEffect(() => { if (token) void load(token); else { setSt(null); setError(''); } }, [token]);
  // Check back every 30 s while pending, so an approval shows up without a reload.
  useEffect(() => {
    if (!token || st?.status !== 'pending') return;
    const t = setInterval(() => void load(token), 30000);
    return () => clearInterval(t);
  }, [token, st?.status]);

  const set = (k: keyof typeof form) => (e: Event) => setForm({ ...form, [k]: (e.target as HTMLInputElement).value });
  const submit = async (e: Event) => {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const r = await api.post<{ token: string }>('/api/access-requests', form);
      saveToken(r.token);
      navigate(`/request/${r.token}`);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const register = async (e: Event) => {
    e.preventDefault(); setError('');
    if (pw.password !== pw.confirm) { setError('The two passwords don’t match'); return; }
    setBusy(true);
    try {
      const m = await api.post<Me>(`/api/access-requests/status/${token}/register`, { password: pw.password, householdName: pw.householdName || undefined });
      saveToken(null);
      onAuthed(m); navigate('/');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const link = token ? `${location.origin}/#/request/${token}` : '';

  return (
    <div class="auth">
      <div class="box">
        <pre class="logo" aria-hidden="true">{LOGO}</pre>
        <div class="panel">
          <div class="ph"><span>{token ? 'access request' : 'request access'}</span></div>
          <div class="pb form">
            {!token && (
              <form class="form" onSubmit={submit}>
                <p class="muted">Bunkerr tracks a household’s emergency food, water and supplies. Tell us who you are, and once you’re approved you can set a password and start your own household.</p>
                <p class="muted small">Family? Use <strong>Create My Accounts</strong> on the family hub instead. It’s instant.</p>
                <Field label="your name"><input required autocomplete="name" maxLength={60} value={form.name} onInput={set('name')} /></Field>
                <Field label="email"><input type="email" required autocomplete="email" value={form.email} onInput={set('email')} /></Field>
                <Field label="how do you know us? (optional)"><textarea maxLength={500} value={form.note} onInput={set('note')} /></Field>
                {/* Honeypot: hidden from people, filled by bots. */}
                <div class="hp" aria-hidden="true"><label>website <input tabIndex={-1} autocomplete="off" value={form.website} onInput={set('website')} /></label></div>
                {error && <p class="err" role="alert">✗ {error}</p>}
                <button class="primary" disabled={busy}>{busy ? 'sending…' : 'request access'}</button>
                <a href="#/" class="small">← back to login</a>
              </form>
            )}
            {token && !st && !error && <p class="muted">checking…</p>}
            {token && error && !st && <><p class="err">✗ {error}</p><a href="#/">back to login</a></>}
            {token && st?.status === 'pending' && (
              <>
                <p>Thanks, {st.name}. Your request is <span class="badge t-soon">waiting for approval</span>.</p>
                <p class="muted small">Keep this page, or bookmark the link below. It’s the only way back to your request, because Bunkerr doesn’t send email. This device will also remember it on the login page.</p>
                <div class="toolbar" style="margin:0"><code class="grow small" style="word-break:break-all">{link}</code><button type="button" class="sm" onClick={() => copyText(link)}>copy</button></div>
                <p class="muted small">This page checks for an answer every 30 seconds.</p>
              </>
            )}
            {token && st?.status === 'approved' && (
              <form class="form" onSubmit={register}>
                <p>You’re approved, {st.name}! Choose a password for <strong>{st.email}</strong>.</p>
                <Field label="household name"><input placeholder={`${st.name}'s household`} maxLength={60} value={pw.householdName} onInput={(e) => setPw({ ...pw, householdName: (e.target as HTMLInputElement).value })} /></Field>
                <Field label="password" hint="10+ characters"><input type="password" required minLength={10} autocomplete="new-password" value={pw.password} onInput={(e) => setPw({ ...pw, password: (e.target as HTMLInputElement).value })} /></Field>
                <Field label="password again"><input type="password" required minLength={10} autocomplete="new-password" value={pw.confirm} onInput={(e) => setPw({ ...pw, confirm: (e.target as HTMLInputElement).value })} /></Field>
                {error && <p class="err" role="alert">✗ {error}</p>}
                <button class="primary" disabled={busy}>create account</button>
                <p class="muted small">You’ll log in with your email address and this password.</p>
              </form>
            )}
            {token && st?.status === 'completed' && <><p>Your account is set up. Log in with your email address.</p><a class="btn primary" href="#/">log in</a></>}
            {token && st?.status === 'rejected' && <><p>Sorry, this request wasn’t approved. If you think that’s a mistake, contact whoever told you about Bunkerr.</p><a href="#/" onClick={() => saveToken(null)}>back to login</a></>}
          </div>
        </div>
      </div>
    </div>
  );
}

export function Join({ token, me, onAuthed, toast }: { token: string; me: Me | null; onAuthed: (m: Me) => void; toast: (m: string, k?: 'ok' | 'error') => void }) {
  const [info, setInfo] = useState<{ householdName: string | null; newHousehold: boolean; role: string; email: string | null } | null>(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ name: '', email: '', password: '', householdName: '' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get(`/api/invites/${token}`).then((i) => { setInfo(i); if (i.email) setForm((f) => ({ ...f, email: f.email || i.email })); }).catch((e) => setError(e.message));
  }, [token]);

  const set = (k: keyof typeof form) => (e: Event) => setForm({ ...form, [k]: (e.target as HTMLInputElement).value });
  const done = (m: Me) => { onAuthed(m); toast(`Welcome to ${m.active?.name ?? 'Bunkerr'}`); navigate('/'); };

  const register = async (e: Event) => {
    e.preventDefault(); setBusy(true); setError('');
    try { done(await api.post<Me>('/api/auth/register', { token, ...form, householdName: form.householdName || undefined })); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const accept = async () => {
    setBusy(true);
    try { done(await api.post<Me>('/api/invites/accept', { token, householdName: form.householdName || undefined })); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  return (
    <div class="auth">
      <div class="box">
        <pre class="logo" aria-hidden="true">{LOGO}</pre>
        <div class="panel">
          <div class="ph"><span>invite</span></div>
          <div class="pb form">
            {!info && !error && <p class="muted">checking invite…</p>}
            {error && !info && <><p class="err">✗ {error}</p><a href="#/">back</a></>}
            {info && (
              <p>
                {info.newHousehold
                  ? <>You’re invited to <strong>start your own household</strong> on Bunkerr.</>
                  : <>You’re invited to join <strong>{info.householdName}</strong> as <span class="badge t-ok">{info.role}</span>.</>}
              </p>
            )}
            {info && info.newHousehold && (
              <Field label="household name"><input placeholder="e.g. Maple Street house" value={form.householdName} onInput={set('householdName')} /></Field>
            )}
            {info && me && (
              <>
                <p class="muted small">Signed in as {me.user.email}.</p>
                {error && <p class="err">✗ {error}</p>}
                <button class="primary" disabled={busy} onClick={accept}>accept invite</button>
              </>
            )}
            {info && !me && (
              <form class="form" onSubmit={register}>
                <Field label="your name"><input required autocomplete="name" value={form.name} onInput={set('name')} /></Field>
                <Field label="email"><input type="email" required autocomplete="username" value={form.email} onInput={set('email')} /></Field>
                <Field label="password" hint="10+ characters"><input type="password" required minLength={10} autocomplete="new-password" value={form.password} onInput={set('password')} /></Field>
                {error && <p class="err" role="alert">✗ {error}</p>}
                <button class="primary" disabled={busy}>create account</button>
                <p class="muted small">Already have an account? <a href={`#/`} onClick={() => sessionStorage.setItem('bunkerr.pendingInvite', token)}>Log in</a>, then open this link again.</p>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function NoHousehold() {
  const { setMe, toast } = useApp();
  const [name, setName] = useState('');
  const create = async (e: Event) => {
    e.preventDefault();
    try { setMe(await api.post<Me>('/api/households', { name })); toast('Household created'); }
    catch (err) { toast((err as Error).message, 'error'); }
  };
  return (
    <div class="panel" style="max-width:520px">
      <div class="ph"><span>no household</span></div>
      <form class="pb form" onSubmit={create}>
        <p>You’re not in a household yet. Create one, or open an invite link from someone else’s household.</p>
        <Field label="household name"><input required value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="e.g. Maple Street house" /></Field>
        <button class="primary">create household</button>
      </form>
    </div>
  );
}
