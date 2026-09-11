/**
 * Founding Android beta: application intake, review, and invite emails.
 *
 * Routes (wired in worker.js):
 *   POST /api/beta/apply                       public application endpoint
 *   GET  /api/beta/applications?status=&format=  admin: list (json or csv)
 *   GET  /api/beta/summary                     admin: counts by status
 *   POST /api/beta/applications/:id/approve    admin: approve + send invite email
 *   POST /api/beta/applications/:id/decline    admin: decline
 *   GET  /beta-admin                           admin: minimal review UI
 *
 * Bindings and configuration (see BETA.md):
 *   DB                D1 database (cloudflare/beta-schema.sql)
 *   BETA_ADMIN_TOKEN  secret bearer token for admin routes
 *   PLAY_OPT_IN_URL   secret: closed-track opt-in link from Play Console
 *   BETA_NOTIFY_EMAIL var: where new-application notifications go
 *   BETA_FROM_EMAIL   var: sender for beta emails (SPF must allow the mail provider)
 */

const JSON_HEADERS = {'Content-Type': 'application/json; charset=utf-8'};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const APPLY_CAP_PER_IP_PER_HOUR = 5;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {status, headers: JSON_HEADERS});
}

function timingSafeEqual(a, b) {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

function isAdmin(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return !!env.BETA_ADMIN_TOKEN && !!token && timingSafeEqual(token, env.BETA_ADMIN_TOKEN);
}

async function sendEmail(env, to, subject, text) {
  const resp = await fetch('https://api.mailchannels.net/tx/v1/send', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      personalizations: [{to: [{email: to}]}],
      from: {email: env.BETA_FROM_EMAIL, name: 'Boxie'},
      subject,
      content: [{type: 'text/plain', value: text}],
    }),
  });
  if (!resp.ok) throw new Error(`mail send failed: ${resp.status} ${await resp.text()}`);
}

async function handleApply(request, env) {
  let data;
  try {
    data = await request.json();
  } catch {
    return json({error: 'invalid_json'}, 400);
  }

  // Honeypot: bots fill hidden fields; humans never see it.
  if (typeof data.website === 'string' && data.website.length > 0) {
    return json({qualified: false, reason: 'spam'});
  }

  const email = String(data.google_email || '').trim().toLowerCase();
  const android = data.android === true;
  const outlook = data.outlook === true;
  const commitment = data.commitment === true;

  if (!EMAIL_RE.test(email) || email.length > 254) return json({error: 'invalid_email'}, 400);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM beta_applications WHERE ip = ? AND created_at > datetime('now', '-1 hour')`
  ).bind(ip).first();
  if ((recent?.n ?? 0) >= APPLY_CAP_PER_IP_PER_HOUR) return json({error: 'rate_limited'}, 429);

  const qualified = android && outlook && commitment;
  const reason = !android ? 'android' : !outlook ? 'outlook' : !commitment ? 'commitment' : null;

  // Dedupe: one application per Google account email; repeat submits get the current state.
  const existing = await env.DB.prepare(
    `SELECT id, status FROM beta_applications WHERE google_email = ?`
  ).bind(email).first();
  if (existing) {
    return json({qualified: existing.status !== 'declined' && existing.status !== 'not_qualified', reason, status: existing.status});
  }

  await env.DB.prepare(
    `INSERT INTO beta_applications (google_email, android, outlook, commitment, qualified, reason, status, ip, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).bind(
    email, android ? 1 : 0, outlook ? 1 : 0, commitment ? 1 : 0,
    qualified ? 1 : 0, reason, qualified ? 'pending' : 'not_qualified',
    ip, (request.headers.get('User-Agent') || '').slice(0, 300)
  ).run();

  if (qualified) {
    try {
      await sendEmail(
        env, env.BETA_NOTIFY_EMAIL,
        `[Boxie beta] New application: ${email}`,
        `New qualified founding-beta application.\n\nGoogle account: ${email}\nTime (UTC): ${new Date().toISOString()}\n\nReview: https://boxie.dionlabs.ai/beta-admin`
      );
    } catch (e) {
      console.error('beta notify failed', e); // application is stored; notification is best-effort
    }
  }

  return json({qualified, reason});
}

function inviteEmailText(optInUrl) {
  return [
    "Welcome to the Boxie founding Android beta.",
    "",
    "You are approved. Three steps, about five minutes:",
    "",
    `1. On your Android phone, open ${optInUrl} and tap "Become a tester".`,
    "   Use the same Google account you applied with - the invite only works for that account.",
    "2. Install Boxie from the Play Store listing the link takes you to.",
    "3. Open Boxie, sign in with your Boxie account (or create one first at https://boxie.dionlabs.ai/app),",
    "   connect your personal Outlook, and approve the pairing from your other device.",
    "",
    "Then just read your email in Boxie most days for the next two weeks.",
    "Anything that feels off, slow, or confusing - one short note a week is plenty:",
    "https://boxie.dionlabs.ai/feedback or reply to this email.",
    "",
    "You are shaping what Boxie becomes. Thank you.",
    "",
    "- Davide / DionLabs",
  ].join("\n");
}

async function handleApprove(id, env) {
  const row = await env.DB.prepare(
    `SELECT id, google_email, status FROM beta_applications WHERE id = ?`
  ).bind(id).first();
  if (!row) return json({error: 'not_found'}, 404);
  if (row.status === 'approved') return json({ok: true, already: true});
  if (row.status !== 'pending') return json({error: 'not_pending', status: row.status}, 409);

  await sendEmail(env, row.google_email, "You're in: Boxie founding Android beta", inviteEmailText(env.PLAY_OPT_IN_URL));
  await env.DB.prepare(
    `UPDATE beta_applications SET status = 'approved', decided_at = datetime('now') WHERE id = ?`
  ).bind(id).run();
  return json({ok: true});
}

async function handleDecline(id, env) {
  const result = await env.DB.prepare(
    `UPDATE beta_applications SET status = 'declined', decided_at = datetime('now') WHERE id = ? AND status = 'pending'`
  ).bind(id).run();
  if (!result.meta.changes) return json({error: 'not_pending'}, 409);
  return json({ok: true});
}

async function handleList(url, env) {
  const status = url.searchParams.get('status');
  const where = status ? `WHERE status = ?` : '';
  const stmt = env.DB.prepare(
    `SELECT id, google_email, qualified, reason, status, created_at, decided_at FROM beta_applications ${where} ORDER BY created_at DESC LIMIT 500`
  );
  const {results} = await (status ? stmt.bind(status) : stmt).all();

  if (url.searchParams.get('format') === 'csv') {
    const lines = ['google_email,status,created_at']
      .concat((results || []).map((r) => `${r.google_email},${r.status},${r.created_at}`));
    return new Response(lines.join('\n'), {headers: {'Content-Type': 'text/csv; charset=utf-8'}});
  }
  return json({applications: results});
}

async function handleSummary(env) {
  const {results} = await env.DB.prepare(
    `SELECT status, COUNT(*) AS n FROM beta_applications GROUP BY status`
  ).all();
  return json({counts: results});
}

const ADMIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Boxie beta review</title><link rel="stylesheet" href="/launch.css">
<style>body{padding:30px 22px;max-width:760px;margin:auto;font-size:14px;background:#08080b;color:#f4f1eb;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}h1{font-family:Georgia,"Times New Roman",serif;font-weight:400;font-size:34px;letter-spacing:-1px}
.row{display:flex;gap:12px;align-items:center;border:1px solid #ffffff26;border-radius:12px;padding:13px 15px;margin-bottom:10px;background:#151318;flex-wrap:wrap}
.row b{flex:1;font-weight:500;word-break:break-all;min-width:180px}.row small{color:#b5aba8}
button{border:0;border-radius:8px;padding:9px 14px;cursor:pointer;font-family:inherit}
.approve{background:#f58b6b;color:#211410}.decline{background:transparent;border:1px solid #ffffff26;color:#f4f1eb}
#token{width:100%;background:#0e0d11;border:1px solid #ffffff26;border-radius:9px;color:#f4f1eb;padding:12px;font-family:inherit;margin:8px 0 16px;box-sizing:border-box}
.counts{color:#b5aba8;margin:14px 0 22px}.done{opacity:.45}</style></head><body>
<h1>Founding beta review</h1>
<input id="token" type="password" placeholder="Admin token" autocomplete="off">
<div class="counts" id="counts"></div>
<div id="list"></div>
<script>
var t=document.getElementById('token');t.value=localStorage.getItem('bt')||'';
t.addEventListener('change',function(){localStorage.setItem('bt',t.value);load();});
function api(p,m){return fetch(p,{method:m||'GET',headers:{Authorization:'Bearer '+t.value}}).then(function(r){if(r.status===401){document.getElementById('list').innerHTML='<p>Wrong or missing token.</p>';throw new Error('401');}return r.json();});}
function load(){
  api('/api/beta/summary').then(function(d){document.getElementById('counts').textContent=(d.counts||[]).map(function(c){return c.status+': '+c.n;}).join('  ·  ');});
  api('/api/beta/applications?status=pending').then(function(d){
    var el=document.getElementById('list');
    if(!d.applications||!d.applications.length){el.innerHTML='<p>Nothing pending.</p>';return;}
    el.innerHTML='';
    d.applications.forEach(function(a){
      var row=document.createElement('div');row.className='row';
      row.innerHTML='<b>'+a.google_email+'</b><small>'+a.created_at+'</small>';
      var ok=document.createElement('button');ok.className='approve';ok.textContent='Approve';
      ok.onclick=function(){api('/api/beta/applications/'+a.id+'/approve','POST').then(function(){row.classList.add('done');});};
      var no=document.createElement('button');no.className='decline';no.textContent='Decline';
      no.onclick=function(){api('/api/beta/applications/'+a.id+'/decline','POST').then(function(){row.classList.add('done');});};
      row.appendChild(ok);row.appendChild(no);el.appendChild(row);
    });
  }).catch(function(){});
}
if(t.value)load();
</script></body></html>`;

export async function handleBetaRequest(request, env, url) {
  const path = url.pathname;

  if (path === '/api/beta/apply' && request.method === 'POST') return handleApply(request, env);
  if (path === '/beta-admin' && request.method === 'GET') {
    return new Response(ADMIN_PAGE, {headers: {'Content-Type': 'text/html; charset=utf-8'}});
  }

  if (!isAdmin(request, env)) return json({error: 'unauthorized'}, 401);
  if (path === '/api/beta/applications' && request.method === 'GET') return handleList(url, env);
  if (path === '/api/beta/summary' && request.method === 'GET') return handleSummary(env);
  const m = path.match(/^\/api\/beta\/applications\/(\d+)\/(approve|decline)$/);
  if (m && request.method === 'POST') {
    const id = Number(m[1]);
    return m[2] === 'approve' ? handleApprove(id, env) : handleDecline(id, env);
  }
  return json({error: 'not_found'}, 404);
}
