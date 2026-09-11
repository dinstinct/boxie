import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {handleBeta, purgeBeta, digest, CONSENT_VERSION} from './beta.js';
import worker from './worker.js';
let sqlite, env;
function prepare(sql) {
  const statement = sqlite.prepare(sql);
  return {bind(...args) { return {
    async run() { return statement.run(...args); },
    execute() { return {results:statement.columns().length ? statement.all(...args) : (statement.run(...args),[])}; }
  }; }};
}
beforeEach(()=>{
  sqlite = new DatabaseSync(':memory:'); sqlite.exec(readFileSync(new URL('./migrations/0001_beta.sql',import.meta.url),'utf8'));
  env = {BETA_ENABLED:'true',BETA_RATE_SECRET:'test-only-no-production-secret',BETA_DB:{prepare,async batch(statements) {
    sqlite.exec('BEGIN'); try { const result = statements.map(s=>s.execute()); sqlite.exec('COMMIT'); return result; }
    catch(error) { sqlite.exec('ROLLBACK'); throw error; }
  }}};
});
afterEach(()=>{sqlite.close();vi.restoreAllMocks();});
const data = extra => ({email:'test@example.com',android:true,outlook:true,commitment:true,consent:true,consentVersion:CONSENT_VERSION,...extra});
const req = (body, path='apply', headers={})=>new Request(`https://boxie.dionlabs.ai/api/beta/${path}`,{method:'POST',headers:{Origin:'https://boxie.dionlabs.ai','Content-Type':'application/json','CF-Connecting-IP':'192.0.2.1',...headers},body:JSON.stringify(body)});
const rows = ()=>sqlite.prepare('SELECT * FROM beta_applications').all();
describe('beta intake boundary',()=>{
  it('stores only minimal fields and hashes the withdrawal capability',async()=>{
    const response = await handleBeta(req(data()),env); expect(response.status).toBe(202);
    const body = await response.json(); const row = rows()[0];
    expect(row.withdrawal_hash).toBe(await digest(body.withdrawalToken));
    expect(row.expires_at-row.created_at).toBe(30*86400);
    expect(Object.keys(row)).toEqual(['id','email','withdrawal_hash','created_at','expires_at','consent_version','status']);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(JSON.stringify(sqlite.prepare('SELECT * FROM beta_limits').all())).not.toContain('192.0.2.1');
  });
  it.each([null,[],data({email:'<img/src=x>@example.com'}),data({consent:false}),data({outlook:false}),data({android:'yes'}),data({consentVersion:'old'}),data({email:'x'.repeat(300)+'@example.com'})])('rejects malformed or unqualified data without storage: %j',async body=>{
    expect((await handleBeta(req(body),env)).status).toBe(400);expect(rows()).toHaveLength(0);
  });
  it('rejects cross-origin requests, methods, unknown APIs and oversized streamed bodies',async()=>{
    expect((await handleBeta(req(data(),'apply',{Origin:'https://evil.example'}),env)).status).toBe(403);
    expect((await handleBeta(new Request('https://boxie.dionlabs.ai/api/beta/apply'),env)).status).toBe(405);
    expect((await handleBeta(req({},'status'),env)).status).toBe(404);
    expect((await handleBeta(req(data({website:'x'.repeat(2100)})),env)).status).toBe(413);
    expect((await handleBeta(req(data(),'apply',{'Content-Type':'text/plain'}),env)).status).toBe(415);
    expect(rows()).toHaveLength(0);
  });
  it('fails closed when intake is disabled or incomplete',async()=>{
    for (const settings of [{BETA_ENABLED:'false'},{BETA_RATE_SECRET:''},{BETA_DB:null}])
      expect((await handleBeta(req(data()),{...env,...settings})).status).toBe(503);
    expect(rows()).toHaveLength(0);
  });
  it('does not disclose duplicates or overwrite their receipt or status',async()=>{
    const first = await (await handleBeta(req(data()),env)).json();
    sqlite.exec("UPDATE beta_applications SET status='contacted'");
    const second = await (await handleBeta(req(data({email:'TEST@example.com'})),env)).json();
    expect(Object.keys(second)).toEqual(Object.keys(first));expect(rows()).toHaveLength(1);
    expect(rows()[0].status).toBe('contacted');
    await handleBeta(req({token:second.withdrawalToken},'withdraw'),env);expect(rows()).toHaveLength(1);
    await handleBeta(req({token:first.withdrawalToken},'withdraw'),{...env,BETA_ENABLED:'false'});expect(rows()).toHaveLength(0);
    expect((await handleBeta(req({token:first.withdrawalToken},'withdraw'),env)).status).toBe(200);
  });
  it('atomically limits concurrent distinct and duplicate attempts',async()=>{
    const responses = await Promise.all(Array.from({length:12},(_,i)=>handleBeta(req(data({email:`test${i}@example.com`})),env)));
    expect(responses.filter(r=>r.status===202)).toHaveLength(5);expect(rows()).toHaveLength(5);
    expect((await handleBeta(req(data({email:rows()[0].email})),env)).status).toBe(429);
  });
  it('never stores honeypot submissions',async()=>{
    expect((await handleBeta(req(data({website:'bot'})),env)).status).toBe(202);expect(rows()).toHaveLength(0);
  });
  it('deletes expired records and rate buckets without removing active applications',async()=>{
    await handleBeta(req(data()),env);const now=rows()[0].created_at;
    await purgeBeta(env,now+86401);expect(rows()).toHaveLength(1);expect(sqlite.prepare('SELECT * FROM beta_limits').all()).toHaveLength(0);
    await purgeBeta(env,now+30*86400);expect(rows()).toHaveLength(0);
  });
  it('returns a retryable generic error if persistence fails',async()=>{
    env.BETA_DB.batch = async()=>{throw new Error('sensitive database detail');};
    const response = await handleBeta(req(data()),env);expect(response.status).toBe(503);expect(await response.text()).not.toContain('sensitive');
  });
  it('keeps app routes and protects the beta document',async()=>{
    env.ASSETS={fetch:async r=>new Response(new URL(r.url).pathname)};
    for (const path of ['/app','/feedback','/delete-account','/?onboarding=1']) expect(await (await worker.fetch(new Request(`https://boxie.dionlabs.ai${path}`),env)).text()).toBe('/app/');
    const beta = await worker.fetch(new Request('https://boxie.dionlabs.ai/beta'),env);
    expect(await beta.text()).toBe('/beta/');expect(beta.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });
});
