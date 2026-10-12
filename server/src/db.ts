import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { PLANT_SEED } from './plants-seed.js';

export type DB = Database.Database;

const MIGRATIONS: string[] = [
  /* 1: tenancy + core */ `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    pw_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE households (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    receipt_quota INTEGER NOT NULL DEFAULT 40,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE memberships (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner','member','viewer')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, household_id)
  );
  CREATE TABLE invites (
    id INTEGER PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    household_id INTEGER REFERENCES households(id) ON DELETE CASCADE, -- NULL = invite to start a new household
    role TEXT NOT NULL CHECK (role IN ('owner','member','viewer')),
    note TEXT,
    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_by INTEGER REFERENCES users(id),
    used_at INTEGER,
    revoked INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, -- sha256 of the cookie token
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    household_id INTEGER REFERENCES households(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE settings (
    household_id INTEGER PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
    json TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE items (
    id INTEGER PRIMARY KEY,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'food',
    qty REAL NOT NULL DEFAULT 1,
    unit TEXT NOT NULL DEFAULT 'ea',
    location TEXT NOT NULL DEFAULT '',
    barcode TEXT,
    expires_on TEXT,
    opened_on TEXT,
    min_qty REAL,
    kcal_per_unit REAL,
    notes TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX items_hh ON items(household_id, expires_on);
  CREATE TABLE item_events (
    id INTEGER PRIMARY KEY,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    item_id INTEGER,
    item_name TEXT NOT NULL,
    kind TEXT NOT NULL, -- add | use | discard | edit | delete
    qty REAL,
    user_id INTEGER,
    at INTEGER NOT NULL
  );
  CREATE INDEX item_events_hh ON item_events(household_id, at);
  CREATE TABLE barcode_cache (
    upc TEXT PRIMARY KEY,
    name TEXT,
    brand TEXT,
    quantity TEXT,
    category TEXT,
    image TEXT,
    found INTEGER NOT NULL DEFAULT 1,
    fetched_at INTEGER NOT NULL
  );
  CREATE TABLE receipt_usage (
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    month TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (household_id, month)
  );

  CREATE TABLE gardens (
    id INTEGER PRIMARY KEY,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    rows INTEGER NOT NULL,
    cols INTEGER NOT NULL,
    cell_size_ft REAL NOT NULL DEFAULT 1,
    notes TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX gardens_hh ON gardens(household_id);
  CREATE TABLE plants (
    id INTEGER PRIMARY KEY,
    household_id INTEGER REFERENCES households(id) ON DELETE CASCADE, -- NULL = global catalog
    name TEXT NOT NULL,
    glyph TEXT NOT NULL,
    color TEXT NOT NULL,
    days_to_germ INTEGER NOT NULL,
    days_to_maturity INTEGER NOT NULL,
    water_every_days INTEGER NOT NULL,
    spacing_in INTEGER NOT NULL,
    sow TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE plantings (
    id INTEGER PRIMARY KEY,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    garden_id INTEGER NOT NULL REFERENCES gardens(id) ON DELETE CASCADE,
    plant_id INTEGER NOT NULL REFERENCES plants(id),
    row INTEGER NOT NULL,
    col INTEGER NOT NULL,
    w INTEGER NOT NULL DEFAULT 1,
    h INTEGER NOT NULL DEFAULT 1,
    planted_on TEXT NOT NULL,
    last_watered TEXT,
    harvested_on TEXT,
    notes TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX plantings_garden ON plantings(household_id, garden_id);

  CREATE TABLE mesh_nodes (
    id INTEGER PRIMARY KEY,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL UNIQUE, -- "!a1b2c3d4"; one household per node
    label TEXT NOT NULL DEFAULT '',
    site TEXT NOT NULL DEFAULT '',
    long_name TEXT,
    short_name TEXT,
    hw_model TEXT,
    role TEXT,
    last_heard INTEGER,
    battery REAL,
    voltage REAL,
    ch_util REAL,
    air_util REAL,
    uptime INTEGER,
    snr REAL,
    rssi REAL,
    hops_away INTEGER,
    temperature REAL,
    lat REAL,
    lon REAL,
    via_gateway TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE mesh_telemetry (
    id INTEGER PRIMARY KEY,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    battery REAL, voltage REAL, ch_util REAL, air_util REAL, snr REAL, rssi REAL, temperature REAL
  );
  CREATE INDEX mesh_tel_node ON mesh_telemetry(household_id, node_id, at);

  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    UNIQUE (household_id, kind, ref)
  );
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  /* 2: armory */ `
  CREATE TABLE firearms (
    id INTEGER PRIMARY KEY,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT '',          -- nickname
    make TEXT NOT NULL,
    model TEXT NOT NULL,
    variant TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'rifle',     -- handgun | rifle | shotgun | pcc | other
    action TEXT NOT NULL DEFAULT '',        -- semi-auto, bolt, pump, lever, revolver, break, single
    caliber TEXT NOT NULL,
    barrel_in REAL,
    capacity INTEGER,
    serial TEXT NOT NULL DEFAULT '',
    acquired_on TEXT,
    price REAL,
    condition TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    round_count INTEGER NOT NULL DEFAULT 0,
    rounds_at_clean INTEGER NOT NULL DEFAULT 0,
    last_cleaned TEXT,
    clean_every INTEGER,                    -- rounds between cleanings
    status TEXT NOT NULL DEFAULT 'active',  -- active | stored | sold | transferred
    notes TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX firearms_hh ON firearms(household_id);
  CREATE TABLE firearm_parts (
    id INTEGER PRIMARY KEY,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    firearm_id INTEGER REFERENCES firearms(id) ON DELETE SET NULL, -- NULL = spare / unassigned
    category TEXT NOT NULL,
    make TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL,
    qty INTEGER NOT NULL DEFAULT 1,
    serial TEXT NOT NULL DEFAULT '',
    installed_on TEXT,
    price REAL,
    notes TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX firearm_parts_hh ON firearm_parts(household_id, firearm_id);
  CREATE TABLE ammo (
    id INTEGER PRIMARY KEY,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    caliber TEXT NOT NULL,
    brand TEXT NOT NULL DEFAULT '',
    line TEXT NOT NULL DEFAULT '',          -- product line, e.g. "Gold Dot", "White Box"
    grain REAL,
    bullet TEXT NOT NULL DEFAULT '',        -- FMJ, JHP, SP, OTM, buckshot, slug, birdshot...
    purpose TEXT NOT NULL DEFAULT 'range',  -- range | defense | hunting | other
    rounds INTEGER NOT NULL DEFAULT 0,
    min_rounds INTEGER,
    location TEXT NOT NULL DEFAULT '',
    barcode TEXT,
    lot TEXT NOT NULL DEFAULT '',
    price_per_round REAL,
    notes TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX ammo_hh ON ammo(household_id, caliber);
  CREATE TABLE range_sessions (
    id INTEGER PRIMARY KEY,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    firearm_id INTEGER REFERENCES firearms(id) ON DELETE SET NULL,
    ammo_id INTEGER REFERENCES ammo(id) ON DELETE SET NULL,
    firearm_label TEXT NOT NULL,
    ammo_label TEXT NOT NULL DEFAULT '',
    rounds INTEGER NOT NULL,
    on_date TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    user_id INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX range_sessions_hh ON range_sessions(household_id, on_date);
  `,
  /* 3: online barcode cache carries calories and where the answer came from */ `
  ALTER TABLE barcode_cache ADD COLUMN kcal REAL;
  ALTER TABLE barcode_cache ADD COLUMN source TEXT;
  DELETE FROM barcode_cache WHERE found = 0;
  `,
  /* 4: public access requests, approved from a webhook router's actions or the admin panel */ `
  CREATE TABLE access_requests (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | completed
    token_hash TEXT NOT NULL UNIQUE,        -- the requester's private status link
    ip TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER,
    decided_by TEXT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX access_requests_status ON access_requests(status, created_at);
  CREATE INDEX access_requests_email ON access_requests(email);
  `,
  /* 5: power equipment (power banks, stations, UPS, generators) with charge/maintenance reminders */ `
  CREATE TABLE equipment (
    id INTEGER PRIMARY KEY,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'power_bank',
    brand TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    capacity_wh REAL,
    capacity_mah REAL,
    output_w REAL,
    fuel TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    serial TEXT NOT NULL DEFAULT '',
    purchased_on TEXT,
    charge_pct INTEGER,
    run_hours REAL,
    notes TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX equipment_hh ON equipment(household_id);
  CREATE TABLE equipment_tasks (
    id INTEGER PRIMARY KEY,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    every_days INTEGER NOT NULL DEFAULT 90,
    last_done_on TEXT,
    next_due_on TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX equipment_tasks_due ON equipment_tasks(household_id, next_due_on);
  CREATE TABLE equipment_log (
    id INTEGER PRIMARY KEY,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
    task_id INTEGER REFERENCES equipment_tasks(id) ON DELETE SET NULL,
    task_label TEXT NOT NULL,
    done_on TEXT NOT NULL,
    charge_pct INTEGER,
    run_hours REAL,
    note TEXT NOT NULL DEFAULT '',
    user_id INTEGER,
    at INTEGER NOT NULL
  );
  CREATE INDEX equipment_log_eq ON equipment_log(equipment_id, done_on);
  `,
  /* 6: email alerts: per-person subscriptions per household; access-request emails */ `
  CREATE TABLE email_subscriptions (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    digest INTEGER NOT NULL DEFAULT 0,
    alerts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, household_id)
  );
  ALTER TABLE users ADD COLUMN email_access_requests INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE access_requests ADD COLUMN token_sealed TEXT;
  `,
  /* 7: emailed invites (address, resend) */ `
  ALTER TABLE invites ADD COLUMN email TEXT;
  ALTER TABLE invites ADD COLUMN token_sealed TEXT;
  ALTER TABLE invites ADD COLUMN emailed_at INTEGER;
  ALTER TABLE invites ADD COLUMN email_count INTEGER NOT NULL DEFAULT 0;
  `,
  /* 8: idempotency keys, so offline changes replayed after a lost response apply once */ `
  CREATE TABLE idempotency (
    key TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    method TEXT NOT NULL,
    url TEXT NOT NULL,
    status INTEGER NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, key)
  );
  CREATE INDEX idempotency_created ON idempotency(created_at);
  `,
];

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  const seeded = db.prepare('SELECT COUNT(*) AS n FROM plants WHERE household_id IS NULL').get() as { n: number };
  if (seeded.n === 0) {
    const ins = db.prepare(`INSERT INTO plants (household_id,name,glyph,color,days_to_germ,days_to_maturity,water_every_days,spacing_in,sow,notes)
      VALUES (NULL,@name,@glyph,@color,@germ,@maturity,@water,@spacing,@sow,@notes)`);
    db.transaction(() => PLANT_SEED.forEach((p) => ins.run(p)))();
  }
}

export const now = () => Date.now();

export function touchWrite(db: DB) {
  db.prepare(`INSERT INTO meta(key,value) VALUES('last_write',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(Date.now()));
}
