// =============================================================================
// IPAM SIW — auth.js  (login page)
// =============================================================================

import { post, setSession, getToken, checkHttps, showToast } from './api.js';

const DASH = '/site.html';

document.addEventListener('DOMContentLoaded', () => {
  checkHttps();

  // Already logged in? redirect
  if (getToken()) { window.location.replace(DASH); return; }

  const form    = document.getElementById('login-form');
  const userEl  = document.getElementById('username');
  const passEl  = document.getElementById('password');
  const btnEl   = document.getElementById('btn-login');
  const errEl   = document.getElementById('login-error');

  function setError(msg) {
    errEl.textContent = msg;
    errEl.classList.toggle('hidden', !msg);
  }

  function setLoading(loading) {
    btnEl.disabled = loading;
    btnEl.textContent = loading ? 'Connexion…' : 'Se connecter';
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    setError('');
    const username = userEl.value.trim();
    const password = passEl.value;
    if (!username || !password) { setError('Identifiant et mot de passe requis.'); return; }

    setLoading(true);
    try {
      const data = await post('/api/login', { username, password });
      setSession(data.token, data.user);
      window.location.replace(DASH);
    } catch (err) {
      setError(err.message || 'Identifiant ou mot de passe incorrect.');
      passEl.value = '';
      passEl.focus();
    } finally {
      setLoading(false);
    }
  });

  userEl.focus();
});
