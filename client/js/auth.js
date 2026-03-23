// =============================================================================
// IPAM SIW — auth.js  (login page)
// =============================================================================

import { post, setSession, getToken, checkHttps, showToast, initTheme } from './api.js';

const DASH = '/site.html';

document.addEventListener('DOMContentLoaded', () => {
  checkHttps();
  initTheme();

  // Already logged in? redirect
  if (getToken()) { window.location.replace(DASH); return; }

  // ── Toggle panels ──────────────────────────────────────────────────────────
  function showLogin() {
    document.getElementById('box-register').classList.add('hidden');
    document.getElementById('box-login').classList.remove('hidden');
  }
  function showRegister() {
    document.getElementById('box-login').classList.add('hidden');
    document.getElementById('box-register').classList.remove('hidden');
  }
  document.getElementById('btn-show-register').addEventListener('click', showRegister);
  document.getElementById('btn-show-login').addEventListener('click', showLogin);

  // ── Login form ─────────────────────────────────────────────────────────────
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

  // ── Register form ──────────────────────────────────────────────────────────
  const regForm     = document.getElementById('register-form');
  const regFullname = document.getElementById('reg-fullname');
  const regUsername = document.getElementById('reg-username');
  const regPassword = document.getElementById('reg-password');
  const regBtn      = document.getElementById('btn-register');
  const regErr      = document.getElementById('register-error');

  function setRegError(msg) {
    regErr.textContent = msg;
    regErr.classList.toggle('hidden', !msg);
  }

  function setRegLoading(loading) {
    regBtn.disabled = loading;
    regBtn.textContent = loading ? 'Envoi en cours…' : 'Envoyer la demande';
  }

  regForm.addEventListener('submit', async e => {
    e.preventDefault();
    setRegError('');

    const full_name = regFullname.value.trim();
    const username  = regUsername.value.trim();
    const password  = regPassword.value;

    if (!full_name) { setRegError('Nom et prénom requis.'); return; }
    if (!username)  { setRegError('Identifiant requis.'); return; }
    if (!password || password.length < 8) { setRegError('Mot de passe : minimum 8 caractères.'); return; }

    setRegLoading(true);
    try {
      await post('/api/account_requests', { full_name, username, password });
      // Success: show toast, reset form, go back to login
      showToast('Votre demande a été transmise à un administrateur.', 'success', 5000);
      regForm.reset();
      showLogin();
    } catch (err) {
      setRegError(err.message || 'Une erreur est survenue.');
    } finally {
      setRegLoading(false);
    }
  });
});
