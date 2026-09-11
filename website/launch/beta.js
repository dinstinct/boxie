const form = document.querySelector('#beta-form');
const error = document.querySelector('#form-error');
const withdrawalToken = new URLSearchParams(location.hash.slice(1)).get('withdraw');
if (withdrawalToken) {
  // Remove the capability from the visible URL; never put it in a request URL.
  history.replaceState(null,'',location.pathname);
  document.querySelector('#intake').hidden = true;
  document.querySelector('#withdraw').hidden = false;
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
  try {
    await post('/api/beta/withdraw',{token:withdrawalToken});
    result.textContent = 'Any application associated with this link has been removed. No further action is needed.';
    event.target.hidden = true;
  } catch (failure) { result.textContent = failure.message; event.target.disabled = false; }
});
