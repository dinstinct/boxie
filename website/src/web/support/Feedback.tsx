import {useState} from 'react';
import {sendReport} from './reporting';
import '../account/account-deletion.css';
export function Feedback() {
  const [message,setMessage]=useState(''); const [busy,setBusy]=useState(false); const [status,setStatus]=useState('');
  const [consent,setConsent]=useState(()=>{try{return localStorage.getItem('boxie-diagnostics-consent')==='yes';}catch{return false;}});
  return <main className="account-deletion"><article>
    <a href="/app">← Boxie</a><h1>Help shape Boxie</h1>
    <p>Something broke, or an idea could make Boxie better? Tell DionLabs what you expected and what happened.</p>
    <p>Please do not include email contents, names of your contacts, passwords, tokens or vault keys. Your message is sent privately to DionLabs, alongside the app version and platform. No mailbox data or screenshots are attached.</p>
    <label>Your feedback<textarea style={{display:'block',width:'100%',minHeight:160,background:'#202024',color:'#fff',padding:12,borderRadius:10}} maxLength={2000} value={message} disabled={busy} onChange={e=>setMessage(e.target.value)}/></label>
    <p><button disabled={busy||!message.trim()} onClick={async()=>{setBusy(true);setStatus('');try{await sendReport('feedback',message);setMessage('');setStatus('Thank you — your feedback has been sent.');}catch(e){setStatus(e instanceof Error?e.message:'Could not send. Please email support.');}finally{setBusy(false);}}}>{busy?'Sending…':'Send feedback'}</button></p>
    {status&&<p role="status">{status}</p>}
    <label><input type="checkbox" style={{display:'inline',marginRight:8}} checked={consent} onChange={e=>{const next=e.target.checked;try{localStorage.setItem('boxie-diagnostics-consent',next?'yes':'no');setConsent(next);}catch{setStatus('This browser could not save your preference.');}}}/>Share minimal error reports from this browser</label>
    <p>Optional reports contain only a fixed error category, version, platform and timestamp, associated with your Boxie sign-in. We never attach error messages, stack traces, URLs or email data. You can turn this off here. Reporting requires a working Google session; delivery is best effort.</p>
    <p>Cannot sign in or send feedback? Email <a href="mailto:support@dionlabs.ai?subject=Boxie%20feedback">support@dionlabs.ai</a>. Include a reply address in your message only if you want a reply.</p>
    <a href="/privacy">Privacy</a>
  </article></main>;
}
