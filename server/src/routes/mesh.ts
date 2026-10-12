import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import { HttpError, requireHousehold } from '../auth.js';
import { touchWrite } from '../db.js';
import { getSettings } from '../settings.js';
import { idParam, parse } from '../util.js';

const nodeIdRe = /^!?[0-9a-fA-F]{8}$/;
const normalizeNodeId = (s: string) => '!' + s.replace(/^!/, '').toLowerCase();

export default async function meshRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, mesh } = deps;

  app.get('/api/mesh', async (req) => {
    const hh = requireHousehold(req);
    const s = getSettings(db, hh);
    const nodes = db.prepare('SELECT * FROM mesh_nodes WHERE household_id=? ORDER BY site, label, long_name').all(hh) as { last_heard: number | null; battery: number | null }[];
    const offlineMs = s.meshOfflineMinutes * 60000;
    return {
      broker: { connected: mesh.connected, lastMessageAt: mesh.lastMessageAt, error: mesh.error },
      thresholds: { offlineMinutes: s.meshOfflineMinutes, lowBattery: s.meshLowBattery },
      nodes: nodes.map((n) => ({
        ...n,
        online: n.last_heard != null && Date.now() - n.last_heard < offlineMs,
        lowBattery: n.battery != null && n.battery <= s.meshLowBattery,
      })),
      unclaimed: req.ctx!.user.isAdmin ? [...mesh.unclaimed.values()].sort((a, b) => b.last_heard - a.last_heard).slice(0, 50) : [],
    };
  });

  app.post('/api/mesh/nodes', async (req) => {
    const hh = requireHousehold(req, 'member');
    const b = parse(z.object({ node_id: z.string().trim().regex(nodeIdRe, 'node id looks like !a1b2c3d4'), label: z.string().max(60).default(''), site: z.string().max(60).default('') }), req.body);
    const nodeId = normalizeNodeId(b.node_id);
    const existing = db.prepare('SELECT household_id FROM mesh_nodes WHERE node_id=?').get(nodeId) as { household_id: number } | undefined;
    // Deliberately vague so other households' claims aren't revealed.
    if (existing) throw new HttpError(409, existing.household_id === hh ? 'Node already added' : 'That node is already claimed');
    const seen = mesh.unclaimed.get(nodeId);
    const id = db.prepare('INSERT INTO mesh_nodes (household_id,node_id,label,site,long_name,short_name,hw_model,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(hh, nodeId, b.label, b.site, seen?.long_name ?? null, seen?.short_name ?? null, seen?.hw_model ?? null, Date.now()).lastInsertRowid;
    mesh.unclaimed.delete(nodeId);
    touchWrite(db);
    return db.prepare('SELECT * FROM mesh_nodes WHERE id=?').get(id);
  });

  app.patch('/api/mesh/nodes/:id', async (req) => {
    const hh = requireHousehold(req, 'member');
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ label: z.string().max(60), site: z.string().max(60) }).partial(), req.body);
    const cur = db.prepare('SELECT label, site FROM mesh_nodes WHERE id=? AND household_id=?').get(id, hh) as { label: string; site: string } | undefined;
    if (!cur) throw new HttpError(404, 'Node not found');
    db.prepare('UPDATE mesh_nodes SET label=?, site=? WHERE id=? AND household_id=?').run(b.label ?? cur.label, b.site ?? cur.site, id, hh);
    return { ok: true };
  });

  app.delete('/api/mesh/nodes/:id', async (req) => {
    const hh = requireHousehold(req, 'member');
    const { id } = parse(idParam, req.params);
    const n = db.prepare('SELECT node_id FROM mesh_nodes WHERE id=? AND household_id=?').get(id, hh) as { node_id: string } | undefined;
    if (!n) throw new HttpError(404, 'Node not found');
    db.transaction(() => {
      db.prepare('DELETE FROM mesh_telemetry WHERE household_id=? AND node_id=?').run(hh, n.node_id);
      db.prepare('DELETE FROM mesh_nodes WHERE id=? AND household_id=?').run(id, hh);
    })();
    touchWrite(db);
    return { ok: true };
  });

  app.get('/api/mesh/nodes/:id/telemetry', async (req) => {
    const hh = requireHousehold(req);
    const { id } = parse(idParam, req.params);
    const { hours } = parse(z.object({ hours: z.coerce.number().int().min(1).max(720).default(48) }), req.query);
    const n = db.prepare('SELECT node_id FROM mesh_nodes WHERE id=? AND household_id=?').get(id, hh) as { node_id: string } | undefined;
    if (!n) throw new HttpError(404, 'Node not found');
    return db.prepare('SELECT at,battery,voltage,ch_util,air_util,snr,rssi,temperature FROM mesh_telemetry WHERE household_id=? AND node_id=? AND at>? ORDER BY at')
      .all(hh, n.node_id, Date.now() - hours * 3600000);
  });
}
