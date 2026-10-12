// Admin CLI. Usage (inside the container: `node server/dist/cli.js ...`, dev: `npm run cli -- ...`):
//   create-admin <email> <name> [household name]   first account + its household (prompts for password)
//   reset-password <email>                          prints a temporary password
//   invite [note]                                   new-household invite link
//   barcodes-refresh [usda|off] [--if-due]          rebuild the offline barcode mirror now (default: all, forced)
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { config } from './config.js';
import { openDb } from './db.js';
import { hashPassword, randomToken, sha256, validatePassword } from './auth.js';
import { getSettings, saveSettings } from './settings.js';
import { openMirror, type Source } from './barcodes/mirror.js';

const db = openDb(path.join(config.dataDir, 'bunkerr.db'));
const [cmd, ...args] = process.argv.slice(2);

async function ask(q: string) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(q);
  rl.close();
  return a;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

switch (cmd) {
  case 'create-admin': {
    const [email, name, hhName] = args;
    if (!email || !name) fail('usage: create-admin <email> <name> [household name]');
    if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) fail('user exists');
    const pw = process.env.BUNKERR_PASSWORD ?? await ask('Password (min 10 chars): ');
    validatePassword(pw);
    const h = await hashPassword(pw);
    db.transaction(() => {
      const t = Date.now();
      const uid = db.prepare('INSERT INTO users (email,name,pw_hash,is_admin,created_at) VALUES (?,?,?,1,?)').run(email, name, h, t).lastInsertRowid;
      const hh = Number(db.prepare('INSERT INTO households (name,created_at) VALUES (?,?)').run(hhName || `${name}'s household`, t).lastInsertRowid);
      db.prepare(`INSERT INTO memberships (user_id,household_id,role,created_at) VALUES (?,?,'owner',?)`).run(uid, hh, t);
      // The admin's own household alerts through the webhook router when this instance has one.
      if (config.webhookRouterUrl) {
        const s = getSettings(db, hh);
        saveSettings(db, hh, { ...s, notify: { ...s.notify, router: true, discord: false } });
      }
    })();
    console.log(`admin ${email} created${config.webhookRouterUrl ? ' (alerts via the webhook router)' : ''}`);
    break;
  }
  case 'reset-password': {
    const [email] = args;
    const temp = randomToken(9);
    const r = db.prepare('UPDATE users SET pw_hash=? WHERE email=?').run(await hashPassword(temp), email ?? '');
    if (!r.changes) fail('no such user');
    db.prepare('DELETE FROM sessions WHERE user_id=(SELECT id FROM users WHERE email=?)').run(email);
    console.log(`temporary password: ${temp}`);
    break;
  }
  case 'invite': {
    const admin = db.prepare('SELECT id FROM users WHERE is_admin=1 ORDER BY id LIMIT 1').get() as { id: number } | undefined;
    if (!admin) fail('create an admin first');
    const token = randomToken(24);
    const t = Date.now();
    db.prepare(`INSERT INTO invites (token_hash,household_id,role,note,created_by,created_at,expires_at) VALUES (?,NULL,'owner',?,?,?,?)`)
      .run(sha256(token), args.join(' ') || null, admin.id, t, t + 7 * 86400000);
    console.log(`${config.publicUrl}/#/join/${token}`);
    break;
  }
  case 'barcodes-refresh': {
    // Safe while the server runs: the import swaps tables atomically in the shared WAL database.
    const sources = args.filter((a) => a === 'usda' || a === 'off') as Source[];
    const log = { info: (o: object) => console.log(JSON.stringify(o)), warn: (o: object) => console.error(JSON.stringify(o)) };
    const mirror = openMirror(path.join(config.dataDir, 'barcodes.db'), { countries: config.barcodeCountries, log });
    await mirror.refresh({ sources: sources.length ? sources : undefined, force: !args.includes('--if-due') });
    const st = mirror.status();
    mirror.close();
    console.log(`${st.products.toLocaleString()} products, ${st.sizeMb} MB`);
    if (st.sources.some((s) => s.error && (!sources.length || sources.includes(s.source)))) process.exitCode = 1;
    break;
  }
  default:
    fail('commands: create-admin <email> <name> [household] | reset-password <email> | invite [note] | barcodes-refresh [usda|off] [--if-due]');
}
db.close();
