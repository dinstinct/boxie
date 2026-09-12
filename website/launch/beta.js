const form = document.querySelector('#beta-form');
const error = document.querySelector('#form-error');
let withdrawalToken = null;
function consumeWithdrawalLink() {
  const nextToken = new URLSearchParams(location.hash.slice(1)).get('withdraw');
  if (!nextToken) return;
  // Handle both initial loads and same-document navigation. Never send the capability in a URL.
  history.replaceState(null,'',location.pathname + location.search);
  withdrawalToken = nextToken;
  document.querySelector('#intake').hidden = true;
  document.querySelector('#withdraw').hidden = false;
  const button = document.querySelector('#withdraw-button');
  button.hidden = false;
  button.disabled = false;
  document.querySelector('#withdraw-result').textContent = '';
  button.focus();
}
window.addEventListener('hashchange', consumeWithdrawalLink);
consumeWithdrawalLink();
// Previously shared /beta links land on the embedded form; the full story remains above.
if (/^\/beta\/?$/.test(location.pathname) && !withdrawalToken && !location.hash) {
  document.querySelector('#beta')?.scrollIntoView();
}
async function post(path, data) {
  const response = await fetch(path, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const result = await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(result.error || 'Could not complete the request. Please try again later.');
  return result;
}
form.addEventListener('submit',async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true; error.textContent = '';
  try {
    const values = new FormData(form);
    const result = await post('/api/beta/apply', {
      email:values.get('email'), android:values.has('android'), outlook:values.has('outlook'),
      commitment:values.has('commitment'), consent:values.has('consent'), consentVersion:'2026-09-11', website:values.get('website')
    });
    if (!/^[a-f0-9]{64}$/.test(result.withdrawalToken)) throw new Error('Unexpected response. Please try again later.');
    document.querySelector('#withdrawal-link').value = `${location.origin}/beta#withdraw=${result.withdrawalToken}`;
    form.hidden = true;
    const success = document.querySelector('#success'); success.hidden = false; success.focus();
    form.reset();
  } catch (failure) { error.textContent = failure.message; }
  finally { button.disabled = false; }
});
document.querySelector('#withdrawal-link').addEventListener('click',event=>event.target.select());
document.querySelector('#withdraw-button').addEventListener('click',async event => {
  event.target.disabled = true;
  const result = document.querySelector('#withdraw-result');
  const submittedToken = withdrawalToken;
  try {
    await post('/api/beta/withdraw',{token:submittedToken});
    if (withdrawalToken !== submittedToken) return;
    result.textContent = 'Any application associated with this link has been removed. No further action is needed.';
    event.target.hidden = true;
  } catch (failure) {
    if (withdrawalToken !== submittedToken) return;
    result.textContent = failure.message; event.target.disabled = false;
  }
});
