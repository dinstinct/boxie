// Owner-operated CLI. Requires existing Cloudflare D1 access; never expose as HTTP.
import {execFileSync} from 'node:child_process';
const [action='list',id] = process.argv.slice(2);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
let sql;
if (action === 'list') sql = "SELECT id,email,status,datetime(created_at,'unixepoch') AS applied_utc,datetime(expires_at,'unixepoch') AS expires_utc FROM beta_applications WHERE expires_at > unixepoch() ORDER BY created_at LIMIT 500";
else if (action === 'count') sql = 'SELECT status,count(*) AS count FROM beta_applications WHERE expires_at > unixepoch() GROUP BY status';
else if (action === 'purge') sql = 'DELETE FROM beta_applications WHERE expires_at <= unixepoch(); DELETE FROM beta_limits WHERE expires_at <= unixepoch()';
else if (['contacted','declined','delete'].includes(action) && uuid.test(id || '')) {
  sql = action === 'delete' ? `DELETE FROM beta_applications WHERE id = '${id}'` : `UPDATE beta_applications SET status = '${action}' WHERE id = '${id}' AND expires_at > unixepoch()`;
} else { console.error('Usage: node scripts/beta-review.mjs [list|count|purge|contacted ID|declined ID|delete ID]'); process.exit(1); }
const output = execFileSync('pnpm',['exec','wrangler','d1','execute','boxie-beta','--remote','--command',sql,'--json'],{encoding:'utf8'});
process.stdout.write(output);
