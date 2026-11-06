/* =========================================================================
   Login, sessions, password reset (recovery codes)
   Passwords and recovery codes are stored only as salted SHA-256 hashes.
   ========================================================================= */

/* earlier default admin password hashes — upgraded automatically to the current default if never changed */
const OLD_DEFAULT_ADMIN_HASHES = ['a81639367d03e8f94d54160ef520ade2099021cdc3e4b7c42350752a5de951ec'];
const DEFAULT_ADMIN_AUTH = {
  username: 'digihelpmedia',
  salt: 'dhm_392d7cc2e9e8e091',
  passHash: '93be3708a8297960298290ac42eda93cf5df04c2619a7085561d39a7b5871277',
  recHash: '25c4b48e0de1de630d00216f6c5dac0aba0d529af3635e34d97d2931914ab756',
};

const Auth = {
  SESSION_KEY: 'dhm_session',
  CODE_ALPHABET: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',

  async sha(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  },
  newSalt() {
    const a = new Uint8Array(8); crypto.getRandomValues(a);
    return 'dhm_' + [...a].map(b => b.toString(16).padStart(2, '0')).join('');
  },
  normCode(c) { return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); },
  genCode() {
    const a = new Uint8Array(12); crypto.getRandomValues(a);
    const s = [...a].map(b => this.CODE_ALPHABET[b % 32]).join('');
    return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
  },
  normUser(u) { return String(u || '').trim().toLowerCase(); },

  findByUsername(u) {
    u = this.normUser(u);
    return u ? Store.state.members.find(m => this.normUser(m.username) === u) : null;
  },
  usernameTaken(u, exceptId) {
    const m = this.findByUsername(u);
    return !!m && m.id !== exceptId;
  },

  /* ---------- password & recovery ---------- */
  validatePassword(pw) {
    if (!pw || pw.length < 6) return 'Password must be at least 6 characters';
    return '';
  },
  async setPassword(member, pw) {
    member.salt = member.salt || this.newSalt();
    member.passHash = await this.sha(member.salt + '|' + pw);
    member.passwordChangedAt = new Date().toISOString();
  },
  /* creates a new recovery code, stores its hash, returns the plain code (shown once) */
  async newRecoveryCode(member) {
    member.salt = member.salt || this.newSalt();
    const code = this.genCode();
    member.recHash = await this.sha(member.salt + '|rec:' + this.normCode(code));
    return code;
  },
  async checkPassword(member, pw) {
    return !!(member && member.passHash && member.salt) && (await this.sha(member.salt + '|' + pw)) === member.passHash;
  },
  async checkRecovery(member, code) {
    return !!(member && member.recHash && member.salt) && (await this.sha(member.salt + '|rec:' + this.normCode(code))) === member.recHash;
  },

  /* ---------- brute-force throttle (per browser) ---------- */
  fails: 0, lockUntil: 0,
  throttle() {
    if (Date.now() < this.lockUntil) throw new Error(`Too many attempts. Try again in ${Math.ceil((this.lockUntil - Date.now()) / 1000)} sec.`);
  },
  failed() { this.fails++; if (this.fails >= 5) { this.lockUntil = Date.now() + 60000; this.fails = 0; } },

  async login(username, pw) {
    this.throttle();
    const m = this.findByUsername(username);
    if (!m || !(await this.checkPassword(m, pw))) { this.failed(); throw new Error('Incorrect username or password'); }
    if (!m.active) throw new Error('This account is inactive. Contact your admin.');
    this.fails = 0;
    return m;
  },

  async resetWithCode(username, code, newPw) {
    this.throttle();
    const m = this.findByUsername(username);
    if (!m || !(await this.checkRecovery(m, code))) { this.failed(); throw new Error('Username or recovery code is incorrect'); }
    const err = this.validatePassword(newPw);
    if (err) throw new Error(err);
    await this.setPassword(m, newPw);
    const fresh = await this.newRecoveryCode(m); // a used code can't be used twice
    Store.touchConfig();
    return { member: m, newCode: fresh };
  },

  /* ---------- session ---------- */
  startSession(member, remember) {
    const days = remember ? 30 : 0.5;
    localStorage.setItem(this.SESSION_KEY, JSON.stringify({ id: member.id, exp: Date.now() + days * 864e5, pc: member.passwordChangedAt || '' }));
    Store.s.currentUser = member.id;
    Store.save();
  },
  session() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(this.SESSION_KEY) || 'null'); } catch (e) { s = null; }
    if (!s || Date.now() > s.exp) return null;
    const m = Store.member(s.id);
    // invalid if user removed/deactivated or password changed elsewhere
    if (!m || !m.active || !m.passHash || (m.passwordChangedAt || '') !== (s.pc || '')) return null;
    return m;
  },
  refreshSessionStamp(member) {
    const s = JSON.parse(localStorage.getItem(this.SESSION_KEY) || 'null');
    if (s && s.id === member.id) { s.pc = member.passwordChangedAt || ''; localStorage.setItem(this.SESSION_KEY, JSON.stringify(s)); }
  },
  logout() {
    localStorage.removeItem(this.SESSION_KEY);
    location.hash = '';
    location.reload();
  },
};

/* ============================================================ Login screen */
const AuthUI = {
  show(mode = 'login', msg = '') {
    document.body.classList.add('locked');
    const el = document.getElementById('auth');
    el.classList.add('open');
    const cloud = Store.s.cloud;
    const brand = `<div class="auth-brand"><div class="brand-logo">D</div><div><div class="auth-title">${esc(Store.s.company || 'Digi Help Media')}</div><div class="muted small">Lead CRM</div></div></div>`;
    const alert = msg ? `<div class="auth-msg ${msg.startsWith('✓') ? 'ok' : 'err'}">${esc(msg)}</div>` : '';
    if (mode === 'login') {
      el.innerHTML = `<div class="auth-card">${brand}
        <h2>Sign in</h2>${alert}
        <form id="auth-login" class="auth-form">
          <label class="field"><span>Username / ID</span><input class="input" name="u" autocomplete="username" required autofocus></label>
          <label class="field"><span>Password</span>
            <div class="pw-wrap"><input class="input" name="p" type="password" autocomplete="current-password" required><button type="button" class="pw-eye" data-eye>👁</button></div></label>
          <div class="row between"><label class="check small"><input type="checkbox" name="r" checked> Keep me signed in</label>
            <a href="#" data-auth="forgot" class="small">Forgot password?</a></div>
          <button class="btn btn-primary block">Sign in</button>
        </form>
        <details class="auth-cloud" ${cloud.url ? '' : ''}><summary>New computer? Connect to team database</summary>
          <p class="muted small">Paste the Team Sync URL (from Integrations) so your account and leads load on this computer.</p>
          <form id="auth-cloud" class="row gap"><input class="input" name="url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(cloud.url)}"><button class="btn">Connect</button></form>
        </details>
      </div>`;
    } else if (mode === 'forgot') {
      el.innerHTML = `<div class="auth-card">${brand}
        <h2>Reset password</h2>${alert}
        <p class="muted small">Enter your username and your <b>recovery code</b>, then choose a new password.</p>
        <form id="auth-reset" class="auth-form">
          <label class="field"><span>Username / ID</span><input class="input" name="u" required autofocus></label>
          <label class="field"><span>Recovery code</span><input class="input mono" name="c" placeholder="XXXX-XXXX-XXXX" required></label>
          <label class="field"><span>New password</span><div class="pw-wrap"><input class="input" name="p1" type="password" autocomplete="new-password" required minlength="6"><button type="button" class="pw-eye" data-eye>👁</button></div></label>
          <label class="field"><span>Confirm new password</span><input class="input" name="p2" type="password" autocomplete="new-password" required minlength="6"></label>
          <button class="btn btn-primary block">Reset password</button>
        </form>
        <div class="auth-help">
          <b>Don't have a recovery code?</b>
          <ul>
            <li><b>Telecallers / managers:</b> ask your admin — they can reset your password or give you a new recovery code from the <b>Team</b> page.</li>
            <li><b>Admin:</b> use the master recovery code you saved when the CRM was set up, or ask another admin to reset it.</li>
          </ul>
        </div>
        <a href="#" data-auth="login" class="small">← Back to sign in</a>
      </div>`;
    } else if (mode === 'newcode') {
      el.innerHTML = `<div class="auth-card">${brand}
        <h2>✓ Password changed</h2>
        <p>Your old recovery code no longer works. Here is your <b>new recovery code</b> — write it down and keep it safe:</p>
        <div class="code-box">${esc(msg)}</div>
        <button class="btn btn-ghost block" data-copy="${esc(msg)}">Copy code</button>
        <a href="#" data-auth="login" class="btn btn-primary block mt">Continue to sign in</a>
      </div>`;
    }
    this.bind();
  },

  hide() {
    document.body.classList.remove('locked');
    const el = document.getElementById('auth');
    el.classList.remove('open'); el.innerHTML = '';
  },

  bind() {
    const el = document.getElementById('auth');
    el.querySelectorAll('[data-auth]').forEach(a => a.onclick = e => { e.preventDefault(); this.show(a.dataset.auth); });
    el.querySelectorAll('[data-eye]').forEach(b => b.onclick = () => { const i = b.previousElementSibling; i.type = i.type === 'password' ? 'text' : 'password'; });
    el.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => { navigator.clipboard && navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied ✓'; });
    const login = el.querySelector('#auth-login');
    if (login) login.onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(login);
      const btn = login.querySelector('button.btn-primary'); btn.disabled = true;
      try {
        const m = await Auth.login(fd.get('u'), fd.get('p'));
        Auth.startSession(m, !!fd.get('r'));
        this.hide();
        App.start();
      } catch (err) { this.show('login', err.message); }
    };
    const reset = el.querySelector('#auth-reset');
    if (reset) reset.onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(reset);
      if (fd.get('p1') !== fd.get('p2')) return this.show('forgot', 'Passwords do not match');
      try {
        const r = await Auth.resetWithCode(fd.get('u'), fd.get('c'), fd.get('p1'));
        if (Cloud.enabled()) { try { await Cloud.post({ action: 'saveConfig', config: Cloud.sharedConfig() }); } catch (e2) { /* retried by normal sync */ } }
        this.show('newcode', r.newCode);
      } catch (err) { this.show('forgot', err.message); }
    };
    const cloud = el.querySelector('#auth-cloud');
    if (cloud) cloud.onsubmit = async e => {
      e.preventDefault();
      const url = new FormData(cloud).get('url').trim();
      if (!url) return;
      Store.s.cloud.url = url; Store.s.cloud.enabled = true; Store.save();
      try { await Cloud.pull(); this.show('login', '✓ Connected to team database. Sign in with your account.'); }
      catch (err) { this.show('login', 'Could not connect: ' + err.message); }
    };
  },
};
