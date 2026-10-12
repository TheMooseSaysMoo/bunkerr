import dns from 'node:dns/promises';
import net from 'node:net';
import { HttpError } from '../auth.js';

/**
 * Outbound requests to another Bunkerr go to an address a household owner typed in, so they're
 * limited to public https servers unless FEDERATION_ALLOW_PRIVATE is set (both servers on one
 * LAN or VPN). Otherwise a link code could point this server at things on its own network.
 */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) // CGNAT, Tailscale
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0)
      || (a === 198 && (b === 18 || b === 19));
  }
  const v6 = ip.toLowerCase();
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6);
}

/** Normalizes a server's base URL and checks it may be contacted. Returns the base without a trailing slash. */
export async function checkPeerUrl(raw: string, allowPrivate: boolean): Promise<string> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new HttpError(400, 'That isn’t a valid address'); }
  if (u.username || u.password) throw new HttpError(400, 'The address must not contain a username or password');
  if (u.protocol !== 'https:' && !(allowPrivate && u.protocol === 'http:')) {
    throw new HttpError(400, `${u.origin} isn’t https. Linked servers talk over https (or set FEDERATION_ALLOW_PRIVATE=true when both are on one private network)`);
  }
  if (!allowPrivate) {
    const host = u.hostname.replace(/^\[|\]$/g, '');
    let addrs: string[];
    try { addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address); }
    catch { throw new HttpError(400, `Can’t find ${u.hostname} (DNS lookup failed)`); }
    if (!addrs.length || addrs.some(isPrivateAddress)) {
      throw new HttpError(400, `${u.hostname} is a private address. Linked servers must be reachable on the internet (or set FEDERATION_ALLOW_PRIVATE=true when both are on one private network)`);
    }
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/** Splits "https://their.server/#/link/CODE" into the server's base URL and the code. */
export function parseLinkCode(input: string): { url: string; code: string } {
  const m = input.trim().match(/^(https?:\/\/[^\s#]+?)\/?#\/link\/([A-Za-z0-9_-]{20,80})$/);
  if (!m) throw new HttpError(400, 'Paste the whole link code, like https://their-bunkerr.example.com/#/link/…');
  return { url: m[1], code: m[2] };
}

/** fetch with a timeout, no redirects, and a cap on the response size. */
export async function peerFetch(url: string, opts: { method?: string; token?: string; body?: unknown; timeoutMs?: number; maxBytes?: number } = {}) {
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    redirect: 'manual',
    headers: {
      accept: 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
  });
  if (res.status >= 300 && res.status < 400) throw new Error(`the other server redirected (${res.status} to ${res.headers.get('location') ?? '?'}); check its address`);
  const max = opts.maxBytes ?? 8 * 1024 * 1024;
  const chunks: Buffer[] = [];
  let size = 0;
  if (res.body) {
    for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += c.length;
      if (size > max) throw new Error('the other server sent too much data');
      chunks.push(Buffer.from(c));
    }
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, ok: res.ok, json, text };
}
