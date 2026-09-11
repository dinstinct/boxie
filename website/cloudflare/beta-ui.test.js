import {describe,it,expect,vi} from 'vitest';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
const html = readFileSync(new URL('../launch/beta.html',import.meta.url),'utf8');
const js = readFileSync(new URL('../launch/beta.js',import.meta.url),'utf8');
function page(fetch,hash='') { const dom = new JSDOM(html,{url:`https://boxie.dionlabs.ai/beta${hash}`,runScripts:'outside-only'});dom.window.fetch=fetch;dom.window.eval(js);return dom; }
const tick = ()=>new Promise(resolve=>setTimeout(resolve,0));
describe('application UI',()=>{
  it('keeps the form on server error and renders error text safely',async()=>{
    const dom=page(async()=>Response.json({error:'<img src=x onerror=alert(1)>'},{status:429}));
    const form=dom.window.document.querySelector('form');form.dispatchEvent(new dom.window.Event('submit',{cancelable:true}));await tick();
    expect(form.hidden).toBe(false);expect(form.querySelector('button').disabled).toBe(false);
    const error=dom.window.document.querySelector('#form-error');expect(error.textContent).toContain('<img');expect(error.querySelector('img')).toBeNull();dom.window.close();
  });
  it('offers a private fragment link without local persistence',async()=>{
    const receipt='a'.repeat(64);const dom=page(async()=>Response.json({ok:true,withdrawalToken:receipt},{status:202}));
    dom.window.document.querySelector('form').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));await tick();
    expect(dom.window.document.querySelector('#success').hidden).toBe(false);
    expect(dom.window.document.querySelector('#withdrawal-link').value).toBe(`https://boxie.dionlabs.ai/beta#withdraw=${receipt}`);
    expect(dom.window.localStorage.length).toBe(0);dom.window.close();
  });
  it('requires a click to withdraw and sends the capability only in the POST body',async()=>{
    const fetch=vi.fn(async()=>Response.json({ok:true}));const receipt='b'.repeat(64);const dom=page(fetch,`#withdraw=${receipt}`);
    expect(dom.window.location.hash).toBe('');expect(fetch).not.toHaveBeenCalled();
    dom.window.document.querySelector('#withdraw-button').click();await tick();
    expect(fetch.mock.calls[0][0]).toBe('/api/beta/withdraw');expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({token:receipt});dom.window.close();
  });
});
