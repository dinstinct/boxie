// Screening concept: @dinstinct, https://github.com/dion-labs/boxie/pull/1.
// Independently implemented intake only. No public review API or email sender.
const DAY = 86400;
export const CONSENT_VERSION = '2026-09-11';
const headers = {'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer'};
const json = (body, status = 200, extra = {}) => Response.json(body, {status, headers:{...headers,...extra}});
export const validEmail = value => typeof value === 'string' && value.length <= 254 &&
  /^[a-z0-9][a-z0-9._+\-]{0,63}@[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?)+$/i.test(value) && !value.includes('..');
const hex = data => [...new Uint8Array(data)].map(n=>n.toString(16).padStart(2,'0')).join('');
export const digest = async value => hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
const token = () => hex(crypto.getRandomValues(new Uint8Array(32)));
async function bucketKey(secret, ip, hour) {
  const key = await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return hex(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`${hour}:${ip}`)));
}
async function readBody(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw 415;
  if (Number(request.headers.get('content-length') || 0) > 2048) throw 413;
  const reader = request.body?.getReader();
  if (!reader) throw 400;
  let bytes = 0; const chunks = [];
  while (true) {
    const {done,value} = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > 2048) { await reader.cancel(); throw 413; }
    chunks.push(value);
  }
  const buffer = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk,offset); offset += chunk.length; }
  let data;
  try { data = JSON.parse(new TextDecoder().decode(buffer)); } catch { throw 400; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw 400;
  return data;
}
export async function purgeBeta(env, now = Math.floor(Date.now()/1000)) {
  if (!env.BETA_DB) return;
  await env.BETA_DB.batch([
    env.BETA_DB.prepare('DELETE FROM beta_applications WHERE expires_at <= ?').bind(now),
    env.BETA_DB.prepare('DELETE FROM beta_limits WHERE expires_at <= ?').bind(now)
  ]);
}
export async function handleBeta(request, env) {
  const path = new URL(request.url).pathname;
  if (!['/api/beta/apply','/api/beta/withdraw'].includes(path)) return json({error:'Not found.'},404);
  if (request.method !== 'POST') return json({error:'Use POST.'},405,{Allow:'POST'});
  if (request.headers.get('origin') !== new URL(request.url).origin) return json({error:'Open the form on this website.'},403);
  // Withdrawal remains available while intake is paused.
  if (!env.BETA_DB || (path.endsWith('/apply') && (env.BETA_ENABLED !== 'true' || !env.BETA_RATE_SECRET)))
    return json({error:'Applications are temporarily unavailable. Please try again later.'},503);
  try {
    const data = await readBody(request);
    if (path.endsWith('/withdraw')) {
      if (typeof data.token !== 'string' || !/^[a-f0-9]{64}$/.test(data.token)) throw 400;
      await env.BETA_DB.prepare('DELETE FROM beta_applications WHERE withdrawal_hash = ?').bind(await digest(data.token)).run();
      return json({ok:true}); // Invalid/already-used receipts never reveal a record.
    }
    const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
    if (!validEmail(email) || data.android !== true || data.outlook !== true || data.commitment !== true || data.consent !== true || data.consentVersion !== CONSENT_VERSION) throw 400;
    const receipt = token();
    if (data.website) return json({ok:true,withdrawalToken:receipt},202);
    const now = Math.floor(Date.now()/1000);
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip) return json({error:'Applications are temporarily unavailable.'},503);
    const bucket = await bucketKey(env.BETA_RATE_SECRET,ip,Math.floor(now/3600));
    // Count every valid attempt, including duplicates. D1 batch is transactional.
    const [limit] = await env.BETA_DB.batch([
      env.BETA_DB.prepare(`INSERT INTO beta_limits(bucket,count,expires_at) VALUES (?,1,?)
        ON CONFLICT(bucket) DO UPDATE SET count = MIN(count+1,6) RETURNING count`).bind(bucket,now+DAY),
      env.BETA_DB.prepare(`INSERT OR IGNORE INTO beta_applications(id,email,withdrawal_hash,created_at,expires_at,consent_version)
        SELECT ?,?,?,?,?,? WHERE (SELECT count FROM beta_limits WHERE bucket = ?) <= 5`)
        .bind(crypto.randomUUID(),email,await digest(receipt),now,now+30*DAY,CONSENT_VERSION,bucket)
    ]);
    if (limit.results[0].count > 5) return json({error:'Too many attempts. Please try again in an hour.'},429,{'Retry-After':'3600'});
    // Same shape for new and duplicate emails; never return review status.
    return json({ok:true,withdrawalToken:receipt},202);
  } catch (error) {
    if (typeof error === 'number') return json({error:error === 413 ? 'Request too large.' : 'Check the form and try again.'},error);
    // Do not log request bodies, email addresses, tokens or database error text.
    return json({error:'We could not save your application. Please try again later.'},503);
  }
}
