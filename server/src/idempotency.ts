import type { FastifyInstance } from 'fastify';
import type { DB } from './db.js';

/**
 * Offline clients queue changes and replay them when they reconnect, each with an
 * Idempotency-Key. If a replayed request already reached the server (the response was what got
 * lost), the stored response is returned instead of applying it twice. "Used 1 can" must
 * never become "used 2". Keys are per user and kept 14 days.
 */
const KEY = /^[A-Za-z0-9_-]{8,80}$/;
export const IDEMPOTENCY_TTL_MS = 14 * 86400000;

declare module 'fastify' {
  interface FastifyRequest { idemKey?: string }
}

export function registerIdempotency(app: FastifyInstance, db: DB) {
  app.addHook('preHandler', async (req, reply) => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !req.ctx || req.method === 'GET' || !req.url.startsWith('/api/')) return;
    if (!KEY.test(key)) return reply.status(400).send({ error: 'Bad Idempotency-Key' });
    const hit = db.prepare('SELECT method, url, status, body FROM idempotency WHERE user_id=? AND key=?').get(req.ctx.user.id, key) as
      { method: string; url: string; status: number; body: string } | undefined;
    if (hit) {
      // Same key for a different request is a client bug, not a replay.
      if (hit.method !== req.method || hit.url !== req.url) return reply.status(422).send({ error: 'Idempotency-Key reused for a different request' });
      return reply.status(hit.status).header('idempotent-replay', 'true').type('application/json; charset=utf-8').send(hit.body);
    }
    req.idemKey = key;
  });

  app.addHook('onSend', async (req, reply, payload) => {
    // Only definite outcomes are remembered; a 5xx should be retried for real.
    if (!req.idemKey || !req.ctx || reply.statusCode >= 500 || reply.getHeader('idempotent-replay')) return payload;
    const body = typeof payload === 'string' ? payload : Buffer.isBuffer(payload) ? payload.toString('utf8') : JSON.stringify(payload ?? null);
    db.prepare('INSERT OR IGNORE INTO idempotency (key,user_id,method,url,status,body,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(req.idemKey, req.ctx.user.id, req.method, req.url, reply.statusCode, body, Date.now());
    return payload;
  });
}
