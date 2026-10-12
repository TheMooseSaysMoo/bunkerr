import mqtt from 'mqtt';
import type { DB } from '../db.js';
import type { Config } from '../config.js';

/** Meshtastic MQTT JSON envelope (gateway "JSON output enabled", ESP32 gateways only). */
export interface MeshJson {
  from: number;
  to?: number;
  type?: string;
  sender?: string; // gateway node id that uplinked this packet
  rssi?: number;
  snr?: number;
  hops_away?: number;
  timestamp?: number;
  payload?: Record<string, unknown>;
}

const HW: Record<number, string> = { 4: 'T-Beam', 9: 'RAK4631', 43: 'Heltec V3', 48: 'Heltec Wireless Tracker', 50: 'T-Deck', 71: 'T1000-E' };
const ROLES = ['CLIENT', 'CLIENT_MUTE', 'ROUTER', 'ROUTER_CLIENT', 'REPEATER', 'TRACKER', 'SENSOR', 'TAK', 'CLIENT_HIDDEN', 'LOST_AND_FOUND', 'TAK_TRACKER', 'ROUTER_LATE', 'CLIENT_BASE'];

export const nodeIdFromNum = (n: number) => '!' + (n >>> 0).toString(16).padStart(8, '0');

export interface IngestState {
  connected: boolean;
  lastMessageAt: number | null;
  messages: number;
  error: string | null;
  /** Recently heard nodes nobody has claimed (admin-only view, helps first-time claiming). */
  unclaimed: Map<string, { node_id: string; long_name?: string; short_name?: string; hw_model?: string; last_heard: number }>;
}

export const newIngestState = (): IngestState => ({ connected: false, lastMessageAt: null, messages: 0, error: null, unclaimed: new Map() });

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === 'string' && v.length ? v : null);

/**
 * Applies one decoded packet. Only nodes claimed by a household are stored, and only into that household.
 * Returns the household id that received it, or null.
 */
export function handlePacket(db: DB, state: IngestState, msg: MeshJson, at = Date.now()): number | null {
  if (typeof msg.from !== 'number') return null;
  const nodeId = nodeIdFromNum(msg.from);
  const p = msg.payload ?? {};
  const node = db.prepare('SELECT id, household_id FROM mesh_nodes WHERE node_id=?').get(nodeId) as { id: number; household_id: number } | undefined;

  if (!node) {
    const prev = state.unclaimed.get(nodeId);
    state.unclaimed.set(nodeId, {
      node_id: nodeId,
      long_name: (msg.type === 'nodeinfo' ? str(p.longname) : null) ?? prev?.long_name,
      short_name: (msg.type === 'nodeinfo' ? str(p.shortname) : null) ?? prev?.short_name,
      hw_model: (msg.type === 'nodeinfo' && num(p.hardware) != null ? HW[num(p.hardware)!] ?? `hw#${num(p.hardware)}` : null) ?? prev?.hw_model,
      last_heard: at,
    });
    if (state.unclaimed.size > 300) state.unclaimed.delete(state.unclaimed.keys().next().value!);
    return null;
  }

  const set: Record<string, unknown> = { last_heard: at };
  if (str(msg.sender)) set.via_gateway = msg.sender;
  if (num(msg.hops_away) != null) set.hops_away = msg.hops_away;
  // RSSI/SNR are as heard by the uplinking gateway; only meaningful for direct (0-hop) reception.
  if (num(msg.rssi) != null && msg.rssi !== 0) set.rssi = msg.rssi;
  if (num(msg.snr) != null && msg.snr !== 0) set.snr = msg.snr;

  let telemetry = false;
  switch (msg.type) {
    case 'nodeinfo': {
      if (str(p.longname)) set.long_name = p.longname;
      if (str(p.shortname)) set.short_name = p.shortname;
      const hw = num(p.hardware);
      if (hw != null) set.hw_model = HW[hw] ?? `hw#${hw}`;
      const role = num(p.role);
      if (role != null) set.role = ROLES[role] ?? `role#${role}`;
      break;
    }
    case 'telemetry': {
      const fields: [string, string][] = [['battery_level', 'battery'], ['voltage', 'voltage'], ['channel_utilization', 'ch_util'], ['air_util_tx', 'air_util'], ['uptime_seconds', 'uptime'], ['temperature', 'temperature']];
      for (const [src, dst] of fields) {
        const v = num(p[src]);
        if (v != null) { set[dst] = v; telemetry = true; }
      }
      break;
    }
    case 'position': {
      const lat = num(p.latitude_i), lon = num(p.longitude_i);
      if (lat != null && lon != null && (lat !== 0 || lon !== 0)) { set.lat = lat / 1e7; set.lon = lon / 1e7; }
      break;
    }
  }

  const cols = Object.keys(set);
  db.prepare(`UPDATE mesh_nodes SET ${cols.map((c) => `${c}=@${c}`).join(',')} WHERE id=@id`).run({ ...set, id: node.id });
  if (telemetry) {
    const r = db.prepare('SELECT battery,voltage,ch_util,air_util,snr,rssi,temperature FROM mesh_nodes WHERE id=?').get(node.id) as Record<string, number | null>;
    db.prepare(`INSERT INTO mesh_telemetry (household_id,node_id,at,battery,voltage,ch_util,air_util,snr,rssi,temperature) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(node.household_id, nodeId, at, r.battery, r.voltage, r.ch_util, r.air_util, r.snr, r.rssi, r.temperature);
  }
  state.lastMessageAt = at;
  return node.household_id;
}

export function startMqtt(db: DB, cfg: Config, state: IngestState, log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void }) {
  if (!cfg.mqttUrl) { state.error = 'MQTT_URL not set'; return null; }
  const client = mqtt.connect(cfg.mqttUrl, {
    username: cfg.mqttUsername || undefined,
    password: cfg.mqttPassword || undefined,
    clientId: `bunkerr-${cfg.nodeName}-${Math.random().toString(16).slice(2, 8)}`,
    reconnectPeriod: 5000,
    // mqtts:// with a self-signed certificate on your own broker
    rejectUnauthorized: !cfg.mqttTlsInsecure,
  });
  client.on('connect', () => {
    state.connected = true; state.error = null;
    client.subscribe(cfg.mqttTopics, (err) => err && log.warn({ err }, 'mqtt subscribe failed'));
    log.info({ topics: cfg.mqttTopics }, 'mqtt connected');
  });
  client.on('close', () => { state.connected = false; });
  client.on('error', (err) => { state.error = err.message; });
  client.on('message', (topic, buf) => {
    if (!topic.includes('/json/')) return; // protobuf (/e/) and map-report topics are skipped
    state.messages++;
    try { handlePacket(db, state, JSON.parse(buf.toString('utf8')) as MeshJson); }
    catch { /* non-JSON or malformed: ignore */ }
  });
  return client;
}
