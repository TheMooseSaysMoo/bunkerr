import { describe, expect, it } from 'vitest';
import { login, makeApp, seedUser } from './helpers.js';

describe('idempotency keys (offline replay)', () => {
  it('a replayed change applies once and returns the first response', async () => {
    const { app, db } = await makeApp();
    await seedUser(db, 'o@example.com');
    const O = await login(app, 'o@example.com');
    const send = (method: 'POST' | 'PATCH' | 'DELETE', url: string, payload: object | undefined, key: string) =>
      app.inject({ method, url, payload, headers: { cookie: O.cookie, 'x-bunkerr': '1', 'idempotency-key': key } });

    const add1 = await send('POST', '/api/items', { name: 'Black beans, 15 oz can', qty: 6, unit: 'can', category: 'food' }, 'add-key-0001');
    const add2 = await send('POST', '/api/items', { name: 'Black beans, 15 oz can', qty: 6, unit: 'can', category: 'food' }, 'add-key-0001');
    expect(add2.json()).toEqual(add1.json());
    expect(add2.headers['idempotent-replay']).toBe('true');
    expect(db.prepare('SELECT SUM(qty) AS q, COUNT(*) AS n FROM items').get()).toEqual({ q: 6, n: 1 });

    const id = add1.json().id;
    for (let i = 0; i < 3; i++) await send('POST', `/api/items/${id}/consume`, { qty: 1, kind: 'use' }, 'use-key-0001');
    expect((db.prepare('SELECT qty FROM items WHERE id=?').get(id) as { qty: number }).qty).toBe(5);
    // A new key is a new change.
    await send('POST', `/api/items/${id}/consume`, { qty: 1, kind: 'use' }, 'use-key-0002');
    expect((db.prepare('SELECT qty FROM items WHERE id=?').get(id) as { qty: number }).qty).toBe(4);

    // Errors are remembered too (a 404 stays a 404), and a key can't be reused for another request.
    expect((await send('DELETE', '/api/items/99999', undefined, 'del-key-0001')).statusCode).toBe(404);
    expect((await send('DELETE', '/api/items/99999', undefined, 'del-key-0001')).statusCode).toBe(404);
    expect((await send('DELETE', `/api/items/${id}`, undefined, 'use-key-0001')).statusCode).toBe(422);
    expect((await send('POST', `/api/items/${id}/consume`, { qty: 1 }, 'bad key!')).statusCode).toBe(400);
  });

  it('keys are per user', async () => {
    const { app, db } = await makeApp();
    await seedUser(db, 'a@example.com');
    await seedUser(db, 'b@example.com');
    const A = await login(app, 'a@example.com');
    const B = await login(app, 'b@example.com');
    const add = (c: string) => app.inject({ method: 'POST', url: '/api/items', payload: { name: 'Rice', qty: 1, unit: 'bag', category: 'food' }, headers: { cookie: c, 'x-bunkerr': '1', 'idempotency-key': 'shared-key-01' } });
    const a = (await add(A.cookie)).json();
    const b = (await add(B.cookie)).json();
    expect(a.id).not.toBe(b.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM items').get()).toEqual({ n: 2 });
  });
});
