/* =========================================================================
   Digi Help Media CRM — UI
   ========================================================================= */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const localDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function fmtDate(iso) { if (!iso) return '—'; const d = new Date(iso); return isNaN(d) ? esc(iso) : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); }
function fmtDT(iso) { if (!iso) return '—'; const d = new Date(iso); return isNaN(d) ? esc(iso) : d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
function timeAgo(iso) {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso)) / 1000;
  if (isNaN(s)) return '—';
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
  return fmtDate(iso);
}
const toLocalInput = iso => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : `${localDay(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

const isClosed = status => { const s = Store.s.statuses.find(x => x.name === status); return !!(s && s.closed); };
function fuState(l) {
  if (!l.followUp || isClosed(l.status)) return '';
  const d = new Date(l.followUp), now = new Date();
  if (isNaN(d)) return '';
  if (d < now) return 'overdue';
  if (localDay(d) === localDay(now)) return 'today';
  return 'upcoming';
}
const statusPill = s => `<span class="pill" style="--c:${esc(Store.statusColor(s))}">${esc(s)}</span>`;
const initials = n => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(x => x[0].toUpperCase()).join('') || '?';

/* ===================================================================== UI */
const UI = {
  toast(msg, type = 'info') {
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    t.textContent = msg;
    $('#toasts').appendChild(t);
    setTimeout(() => t.classList.add('out'), 3500);
    setTimeout(() => t.remove(), 4000);
  },
  modal(html, { wide = false } = {}) {
    const m = $('#modal');
    m.className = 'modal' + (wide ? ' wide' : '');
    m.innerHTML = html;
    $('#modal-backdrop').classList.add('open');
    const f = m.querySelector('input:not([type=hidden]),textarea,select');
    if (f) setTimeout(() => f.focus(), 50);
    return m;
  },
  closeModal() { $('#modal-backdrop').classList.remove('open'); $('#modal').innerHTML = ''; },
  confirm(msg) { return window.confirm(msg); },
};

/* ================================================================ Actions */
const Actions = {
  updateLead(id, patch) {
    const l = Store.lead(id);
    if (!l) return;
    const before = { ...l };
    const changed = Object.keys(patch).filter(k => (l[k] ?? '') !== (patch[k] ?? ''));
    if (!changed.length) return;
    changed.forEach(k => { l[k] = patch[k]; });
    const events = [];
    if (changed.includes('status')) {
      Store.addActivity(l, 'status', `Status changed: ${before.status} → ${l.status}`);
      events.push(['lead.status_changed', { lead: l, previousStatus: before.status }]);
    }
    if (changed.includes('assignedTo')) {
      Store.addActivity(l, 'assign', l.assignedTo ? `Assigned to ${Store.memberName(l.assignedTo)}` : 'Unassigned');
      events.push(['lead.assigned', { lead: l, previousAssignee: before.assignedTo ? Store.memberName(before.assignedTo) : null }]);
    }
    if (changed.includes('followUp') && l.followUp) {
      Store.addActivity(l, 'followup', `Follow-up set for ${fmtDT(l.followUp)}`);
      events.push(['lead.followup_set', { lead: l }]);
    }
    const other = changed.filter(k => !['status', 'assignedTo', 'followUp'].includes(k));
    if (other.length) {
      Store.addActivity(l, 'edit', 'Updated ' + other.join(', '));
      events.push(['lead.updated', { lead: l, changedFields: other }]);
    }
    Store.markDirty(l);
    Store.save();
    events.forEach(([e, d]) => Webhook.fire(e, d));
  },

  addNote(id, text) {
    const l = Store.lead(id);
    if (!l || !text.trim()) return;
    Store.addActivity(l, 'note', text.trim());
    l.lastContactAt = new Date().toISOString();
    Store.markDirty(l); Store.save();
    Webhook.fire('lead.note_added', { lead: l, note: text.trim() });
  },

  logCall(id) {
    const l = Store.lead(id);
    if (!l) return;
    Store.addActivity(l, 'call', 'Call placed to ' + l.phone);
    l.lastContactAt = new Date().toISOString();
    Store.markDirty(l); Store.save();
  },

  addLead(data) {
    const dupe = data.phone && Store.state.leads.find(l => Phone.last10(l.phone) === Phone.last10(data.phone));
    if (dupe && !UI.confirm(`A lead with this phone already exists (${dupe.name}). Add anyway?`)) return null;
    const l = Store.newLead(data);
    Store.addActivity(l, 'system', 'Lead created manually');
    if (!l.assignedTo && Store.s.autoAssign === 'roundrobin') {
      l.assignedTo = Store.nextAssignee();
      if (l.assignedTo) Store.addActivity(l, 'assign', 'Auto-assigned to ' + Store.memberName(l.assignedTo));
    }
    Store.state.leads.push(l);
    Store.markDirty(l); Store.save();
    Webhook.fire('lead.created', { lead: l });
    if (l.assignedTo) Webhook.fire('lead.assigned', { lead: l });
    return l;
  },

  deleteLeads(ids) {
    const set = new Set(ids);
    const gone = Store.state.leads.filter(l => set.has(l.id));
    Store.state.leads = Store.state.leads.filter(l => !set.has(l.id));
    Store.save();
    gone.forEach(l => { if (window.Cloud) Cloud.queueLead(l.id); Webhook.fire('lead.deleted', { lead: l }); });
  },

  distributeUnassigned() {
    const callers = Store.activeCallers();
    if (!callers.length) { UI.toast('Add at least one active Telecaller in Team first', 'error'); return 0; }
    const un = Store.state.leads.filter(l => !l.assignedTo && !isClosed(l.status));
    un.forEach(l => Actions.updateLead(l.id, { assignedTo: Store.nextAssignee() }));
    Store.save();
    return un.length;
  },

  async syncSheet({ silent = false } = {}) {
    const pill = $('#sync-pill');
    pill.textContent = 'Sheet: syncing…';
    try {
      const r = await Sheets.sync();
      pill.textContent = 'Sheet: synced ' + new Date().toLocaleTimeString();
      pill.className = 'sync-pill ok';
      if (!silent || r.added) UI.toast(r.added ? `✅ ${r.added} new lead(s) imported` : 'No new leads in the sheet', r.added ? 'success' : 'info');
      if (r.added) App.refresh();
      return r;
    } catch (e) {
      pill.textContent = 'Sheet: error';
      pill.className = 'sync-pill err';
      Store.s.sheet.lastResult = 'Error: ' + e.message; Store.save();
      if (!silent) UI.toast(e.message, 'error');
      return null;
    }
  },
};

/* ================================================================= Router */
const ROUTES = {
  dashboard: { title: 'Dashboard', render: () => Views.dashboard() },
  leads: { title: 'Leads', render: () => Views.leads(), after: () => Views.leadsTable() },
  followups: { title: 'Follow-ups', render: () => Views.followups() },
  team: { title: 'Team', admin: true, render: () => Views.team() },
  whatsapp: { title: 'WhatsApp Templates', render: () => Views.whatsapp() },
  integrations: { title: 'Integrations', admin: true, render: () => Views.integrations() },
  settings: { title: 'Settings', admin: true, render: () => Views.settings() },
};

const App = {
  route: 'dashboard',
  drawerLead: null,

  started: false,

  init() {
    Store.load();
    if (!window.crypto || !crypto.subtle) {
      document.getElementById('auth').innerHTML = '<div class="auth-card"><h2>Secure connection required</h2><p>Please open the CRM over https:// (e.g. the Vercel link) or from a local file.</p></div>';
      document.getElementById('auth').classList.add('open');
      return;
    }
    const m = Auth.session();
    if (!m) { AuthUI.show('login'); if (Cloud.enabled()) Cloud.pull().catch(() => {}); return; }
    Store.s.currentUser = m.id;
    this.start();
  },

  /* runs once after a successful sign-in */
  start() {
    if (this.started) { this.go(); return; }
    this.started = true;
    AuthUI.hide();
    this.bindGlobal();
    window.addEventListener('hashchange', () => this.go());
    this.renderUserSwitch();
    this.go();
    this.startTimers();
    const sh = Store.s.sheet;
    if (sh.url) { $('#sync-pill').textContent = 'Sheet: ' + (sh.lastSync ? 'last ' + timeAgo(sh.lastSync) : 'connected'); $('#sync-pill').className = 'sync-pill ok'; }
    if (Cloud.enabled()) Cloud.pull().then(c => { if (c) this.refresh(); }).catch(() => {});
    else Cloud.status('off');
  },

  go() {
    let r = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('?')[0];
    if (!ROUTES[r]) r = 'dashboard';
    if (ROUTES[r].admin && !Store.isAdmin()) r = 'dashboard';
    this.route = r;
    this.render();
    $('#sidebar').classList.remove('open');
  },

  render() {
    const R = ROUTES[this.route];
    $('#page-title').textContent = R.title;
    $('#view').innerHTML = R.render();
    if (R.after) R.after();
    $$('#nav a').forEach(a => {
      a.classList.toggle('active', a.dataset.route === this.route);
      a.style.display = a.hasAttribute('data-admin') && !Store.isAdmin() ? 'none' : '';
    });
    this.updateBadges();
  },

  /* re-render without stealing focus from inputs on the leads page */
  refresh() {
    if (!Auth.session()) { UI.toast('Your session ended — please sign in again', 'error'); setTimeout(() => Auth.logout(), 1200); return; }
    this.renderUserSwitch();
    if (this.route === 'leads') { Views.leadsTable(); this.updateBadges(); }
    else this.render();
    if (this.drawerLead) Drawer.render();
  },

  updateBadges() {
    const vis = Store.visibleLeads();
    const firstStatus = Store.s.statuses[0] ? Store.s.statuses[0].name : 'New';
    const n = vis.filter(l => l.status === firstStatus).length;
    const fu = vis.filter(l => ['overdue', 'today'].includes(fuState(l))).length;
    $('#badge-new').textContent = n || '';
    $('#badge-fu').textContent = fu || '';
  },

  renderUserSwitch() {
    const me = Store.me();
    if (!me) return;
    $('#user-menu').innerHTML = `
      <span class="avatar sm">${esc(initials(me.name))}</span>
      <div class="user-info"><b>${esc(me.name)}</b><span class="muted small">@${esc(me.username || '')} · ${esc(me.role)}</span></div>
      <button class="btn btn-sm btn-ghost" data-act="my-password" title="Change password">🔑</button>
      <button class="btn btn-sm btn-ghost" data-act="logout" title="Sign out">⎋ Logout</button>`;
  },

  startTimers() {
    // Google Sheet auto-sync (admins only, so one machine drives imports)
    setInterval(() => {
      const sh = Store.s.sheet;
      if (!sh.url || !sh.autoSync || !Store.isAdmin()) return;
      const due = !sh.lastSync || Date.now() - new Date(sh.lastSync) >= Math.max(1, +sh.intervalMin || 5) * 60000;
      if (due) Actions.syncSheet({ silent: true });
    }, 30000);
    // Team cloud pull
    setInterval(() => {
      if (Cloud.enabled()) Cloud.pull().then(c => { if (c) this.refresh(); }).catch(() => {});
    }, 30000);
  },

  bindGlobal() {
    document.addEventListener('click', e => {
      const el = e.target.closest('[data-act]');
      if (!el) return;
      const fn = Handlers[el.dataset.act];
      if (fn) { e.preventDefault(); fn(el, e); }
    });
    document.addEventListener('change', e => {
      const el = e.target.closest('[data-chg]');
      if (el && ChangeHandlers[el.dataset.chg]) ChangeHandlers[el.dataset.chg](el, e);
    });
    document.addEventListener('input', e => {
      const el = e.target.closest('[data-inp]');
      if (el && InputHandlers[el.dataset.inp]) InputHandlers[el.dataset.inp](el, e);
    });
    document.addEventListener('submit', e => {
      const f = e.target.closest('form[data-form]');
      if (f && Forms[f.dataset.form]) { e.preventDefault(); Forms[f.dataset.form](f, new FormData(f)); }
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { if ($('#modal-backdrop').classList.contains('open')) UI.closeModal(); else Drawer.close(); }
    });
    $('#modal-backdrop').addEventListener('mousedown', e => { if (e.target.id === 'modal-backdrop') UI.closeModal(); });
    $('#drawer-backdrop').addEventListener('click', () => Drawer.close());
    $('#menu-btn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
    $('#quick-sync').addEventListener('click', () => Actions.syncSheet());
  },
};

/* ============================================================ Lead filter */
const LeadFilter = {
  q: '', status: '', assignee: '', source: '', platform: '', range: 'all', fu: '',
  sort: 'createdAt', dir: 'desc', page: 1, perPage: 50, selected: new Set(),

  apply(list) {
    const q = this.q.trim().toLowerCase();
    const now = new Date();
    const today = localDay(now);
    const y = new Date(now); y.setDate(y.getDate() - 1);
    return list.filter(l => {
      if (this.status && l.status !== this.status) return false;
      if (this.assignee === '__none' && l.assignedTo) return false;
      if (this.assignee && this.assignee !== '__none' && l.assignedTo !== this.assignee) return false;
      if (this.source && l.source !== this.source) return false;
      if (this.platform && l.platform !== this.platform) return false;
      if (this.fu) { const s = fuState(l); if (this.fu === 'due' ? !['overdue', 'today'].includes(s) : s !== this.fu) return false; }
      if (this.range !== 'all') {
        const d = new Date(l.createdAt);
        if (this.range === 'today' && localDay(d) !== today) return false;
        if (this.range === 'yesterday' && localDay(d) !== localDay(y)) return false;
        if (this.range === '7d' && now - d > 7 * 864e5) return false;
        if (this.range === '30d' && now - d > 30 * 864e5) return false;
      }
      if (q) {
        const hay = [l.name, l.phone, l.email, l.city, l.campaign, l.ad, l.form, Store.memberName(l.assignedTo)].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }).sort((a, b) => {
      const k = this.sort;
      let va = a[k] || '', vb = b[k] || '';
      if (k === 'assignedTo') { va = Store.memberName(va); vb = Store.memberName(vb); }
      const r = String(va).localeCompare(String(vb), undefined, { numeric: true });
      return this.dir === 'asc' ? r : -r;
    });
  },
};

/* ================================================================== Views */
const Views = {
  /* ----------------------------------------------------------- Dashboard */
  dashboard() {
    const leads = Store.visibleLeads();
    const now = new Date();
    const today = localDay(now);
    const won = Store.s.wonStatus;
    const first = Store.s.statuses[0] ? Store.s.statuses[0].name : 'New';
    const total = leads.length;
    const newToday = leads.filter(l => localDay(new Date(l.createdAt)) === today).length;
    const unassigned = leads.filter(l => !l.assignedTo).length;
    const fresh = leads.filter(l => l.status === first).length;
    const due = leads.filter(l => ['overdue', 'today'].includes(fuState(l))).length;
    const conv = leads.filter(l => l.status === won).length;
    const rate = total ? ((conv / total) * 100).toFixed(1) : '0.0';
    const admin = Store.isAdmin();

    // last 14 days
    const days = [];
    for (let i = 13; i >= 0; i--) { const d = new Date(now); d.setDate(d.getDate() - i); days.push(localDay(d)); }
    const perDay = Object.fromEntries(days.map(d => [d, 0]));
    leads.forEach(l => { const k = localDay(new Date(l.createdAt)); if (k in perDay) perDay[k]++; });
    const maxDay = Math.max(1, ...Object.values(perDay));

    const countBy = key => { const m = {}; leads.forEach(l => { const v = l[key] || 'Unknown'; m[v] = (m[v] || 0) + 1; }); return Object.entries(m).sort((a, b) => b[1] - a[1]); };
    const bars = (entries, colorFn) => {
      const max = Math.max(1, ...entries.map(e => e[1]));
      return entries.length ? entries.map(([k, v]) => `
        <div class="bar-row"><div class="bar-label" title="${esc(k)}">${esc(k)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${(v / max) * 100}%;background:${colorFn ? colorFn(k) : 'var(--accent)'}"></div></div>
          <div class="bar-val">${v}</div></div>`).join('') : '<div class="empty-sm">No data yet</div>';
    };
    const statusEntries = Store.s.statuses.map(s => [s.name, leads.filter(l => l.status === s.name).length]);

    const team = Store.state.members.filter(m => m.role === 'Telecaller' || leads.some(l => l.assignedTo === m.id)).map(m => {
      const mine = Store.state.leads.filter(l => l.assignedTo === m.id);
      const worked = mine.filter(l => l.status !== first).length;
      const c = mine.filter(l => l.status === won).length;
      const pend = mine.filter(l => ['overdue', 'today'].includes(fuState(l))).length;
      const td = mine.filter(l => (l.activity || []).some(a => a.by === m.name && localDay(new Date(a.at)) === today && ['call', 'note', 'status', 'whatsapp'].includes(a.type))).length;
      return { m, total: mine.length, worked, c, pend, td, rate: mine.length ? Math.round((c / mine.length) * 100) : 0 };
    });

    const recent = [...leads].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 8);

    return `
      ${!Store.s.sheet.url && admin ? `<div class="banner">👋 Connect your Meta leads Google Sheet to start importing leads automatically. <a href="#/integrations" class="btn btn-sm">Connect Google Sheet</a></div>` : ''}
      <div class="kpis">
        ${this.kpi('Total Leads', total, admin ? 'All time' : 'Assigned to you', '#5b4dff', 'leads')}
        ${this.kpi('New Today', newToday, 'Received today', '#0ea5e9', 'leads?range=today')}
        ${this.kpi(`Untouched (${first})`, fresh, 'Not called yet', '#f59e0b', 'leads?status=' + encodeURIComponent(first))}
        ${admin ? this.kpi('Unassigned', unassigned, 'Need assignment', '#ef4444', 'leads?assignee=__none') : ''}
        ${this.kpi('Follow-ups Due', due, 'Today + overdue', '#06b6d4', 'followups')}
        ${this.kpi(won, conv, rate + '% conversion', '#16a34a', 'leads?status=' + encodeURIComponent(won))}
      </div>

      <div class="grid-2">
        <div class="card">
          <div class="card-head"><h3>Leads — last 14 days</h3></div>
          <div class="cols-chart">
            ${days.map(d => `<div class="col" title="${d}: ${perDay[d]} lead(s)"><div class="col-val">${perDay[d] || ''}</div><div class="col-bar" style="height:${(perDay[d] / maxDay) * 100}%"></div><div class="col-lbl">${d.slice(8)}</div></div>`).join('')}
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h3>Lead pipeline by status</h3></div>
          ${bars(statusEntries, k => Store.statusColor(k))}
        </div>
      </div>

      <div class="grid-3">
        <div class="card"><div class="card-head"><h3>By platform</h3></div>${bars(countBy('platform'), () => '#8b5cf6')}</div>
        <div class="card"><div class="card-head"><h3>By lead source</h3></div>${bars(countBy('source'), () => '#0ea5e9')}</div>
        <div class="card"><div class="card-head"><h3>Top campaigns</h3></div>${bars(countBy('campaign').slice(0, 6), () => '#f59e0b')}</div>
      </div>

      <div class="grid-2">
        ${admin ? `<div class="card">
          <div class="card-head"><h3>Team performance</h3><a href="#/team" class="link">Manage team →</a></div>
          ${team.length ? `<table class="table compact"><thead><tr><th>Telecaller</th><th>Assigned</th><th>Worked</th><th>${esc(won)}</th><th>Conv.</th><th>Due F/U</th><th>Touched today</th></tr></thead><tbody>
            ${team.map(t => `<tr><td><span class="avatar sm">${esc(initials(t.m.name))}</span>${esc(t.m.name)}</td><td>${t.total}</td><td>${t.worked}</td><td>${t.c}</td><td>${t.rate}%</td><td>${t.pend ? `<span class="tag warn">${t.pend}</span>` : 0}</td><td>${t.td}</td></tr>`).join('')}
          </tbody></table>` : '<div class="empty-sm">Add telecallers in the Team page.</div>'}
        </div>` : ''}
        <div class="card">
          <div class="card-head"><h3>Latest leads</h3><a href="#/leads" class="link">View all →</a></div>
          ${recent.length ? `<div class="list">${recent.map(l => `
            <div class="list-item" data-act="open-lead" data-id="${esc(l.id)}">
              <span class="avatar">${esc(initials(l.name))}</span>
              <div class="grow"><div class="strong">${esc(l.name)}</div><div class="muted small">${esc(l.platform || l.source)} · ${esc(l.campaign || '—')}</div></div>
              <div class="right">${statusPill(l.status)}<div class="muted small">${timeAgo(l.createdAt)}</div></div>
            </div>`).join('')}</div>` : '<div class="empty-sm">No leads yet.</div>'}
        </div>
      </div>`;
  },

  kpi(label, value, sub, color, link) {
    return `<a class="kpi" href="#/${link}" data-act="kpi-link" data-link="${esc(link)}" style="--k:${color}">
      <div class="kpi-label">${esc(label)}</div><div class="kpi-value">${value}</div><div class="kpi-sub">${esc(sub)}</div></a>`;
  },

  /* --------------------------------------------------------------- Leads */
  leads() {
    const s = Store.s, F = LeadFilter, admin = Store.isAdmin();
    const opt = (arr, cur) => arr.map(v => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(v)}</option>`).join('');
    return `
      <div class="status-tabs" id="status-tabs"></div>
      <div class="toolbar">
        <input class="input search" type="search" placeholder="Search name, phone, email, campaign…" value="${esc(F.q)}" data-inp="lead-search" />
        ${admin ? `<select class="input" data-chg="lf" data-k="assignee"><option value="">All team members</option><option value="__none" ${F.assignee === '__none' ? 'selected' : ''}>— Unassigned —</option>${Store.state.members.map(m => `<option value="${esc(m.id)}" ${m.id === F.assignee ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>` : ''}
        <select class="input" data-chg="lf" data-k="source"><option value="">All sources</option>${opt(s.sources, F.source)}</select>
        <select class="input" data-chg="lf" data-k="platform"><option value="">All platforms</option>${opt(s.platforms, F.platform)}</select>
        <select class="input" data-chg="lf" data-k="range">
          ${[['all', 'Any date'], ['today', 'Today'], ['yesterday', 'Yesterday'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days']].map(([v, t]) => `<option value="${v}" ${F.range === v ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
        <select class="input" data-chg="lf" data-k="fu">
          ${[['', 'Any follow-up'], ['due', 'Due (today + overdue)'], ['overdue', 'Overdue'], ['today', 'Today'], ['upcoming', 'Upcoming']].map(([v, t]) => `<option value="${v}" ${F.fu === v ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
        <div class="spacer"></div>
        <button class="btn btn-ghost" data-act="clear-filters">Reset</button>
        <button class="btn btn-ghost" data-act="export-csv">⭳ Export CSV</button>
        <button class="btn btn-primary" data-act="add-lead">+ Add Lead</button>
      </div>
      <div id="bulk-bar"></div>
      <div class="card flush"><div id="leads-table"></div></div>`;
  },

  leadsTable() {
    const F = LeadFilter, admin = Store.isAdmin();
    const base = Store.visibleLeads();
    // status tab counts use all filters except status
    const st = F.status; F.status = '';
    const noStatus = F.apply(base);
    F.status = st;
    const tabs = [['', 'All', noStatus.length], ...Store.s.statuses.map(s => [s.name, s.name, noStatus.filter(l => l.status === s.name).length])];
    $('#status-tabs').innerHTML = tabs.map(([v, t, c]) => `<button class="stab ${F.status === v ? 'active' : ''}" data-act="status-tab" data-v="${esc(v)}" ${v ? `style="--c:${esc(Store.statusColor(v))}"` : ''}>${esc(t)} <b>${c}</b></button>`).join('');

    const list = F.apply(base);
    const pages = Math.max(1, Math.ceil(list.length / F.perPage));
    if (F.page > pages) F.page = pages;
    const rows = list.slice((F.page - 1) * F.perPage, F.page * F.perPage);
    // drop selections that are no longer visible
    const visIds = new Set(list.map(l => l.id));
    [...F.selected].forEach(id => { if (!visIds.has(id)) F.selected.delete(id); });

    const sortTh = (k, t) => `<th class="sortable" data-act="sort" data-k="${k}">${t}${F.sort === k ? (F.dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>`;
    const allChecked = rows.length && rows.every(l => F.selected.has(l.id));
    const statusOpts = cur => Store.statusNames().map(n => `<option ${n === cur ? 'selected' : ''}>${esc(n)}</option>`).join('');
    const memberOpts = cur => `<option value="">— Unassigned —</option>` + Store.state.members.filter(m => m.active || m.id === cur).map(m => `<option value="${esc(m.id)}" ${m.id === cur ? 'selected' : ''}>${esc(m.name)}</option>`).join('');

    $('#leads-table').innerHTML = list.length ? `
      <div class="table-wrap"><table class="table">
        <thead><tr>
          <th class="chk"><input type="checkbox" data-chg="sel-all" ${allChecked ? 'checked' : ''}></th>
          ${sortTh('name', 'Lead')}<th>Contact</th>${sortTh('status', 'Status')}${sortTh('assignedTo', 'Assigned to')}
          ${sortTh('platform', 'Source / Platform')}${sortTh('campaign', 'Campaign')}${sortTh('followUp', 'Follow-up')}${sortTh('createdAt', 'Received')}
        </tr></thead>
        <tbody>${rows.map(l => {
          const fs = fuState(l);
          return `<tr class="${F.selected.has(l.id) ? 'selected' : ''}">
            <td class="chk"><input type="checkbox" data-chg="sel" data-id="${esc(l.id)}" ${F.selected.has(l.id) ? 'checked' : ''}></td>
            <td><a href="#" class="lead-name" data-act="open-lead" data-id="${esc(l.id)}"><span class="avatar sm">${esc(initials(l.name))}</span>${esc(l.name)}</a>${l.city ? `<div class="muted small">${esc(l.city)}</div>` : ''}</td>
            <td class="nowrap">
              <div>${esc(l.phone || '—')}</div>
              <div class="row-actions">
                ${l.phone ? `<a class="mini-btn call" href="tel:${esc(Phone.clean(l.phone))}" data-act="call" data-id="${esc(l.id)}" title="Call">📞</a>
                <button class="mini-btn wa" data-act="wa" data-id="${esc(l.id)}" title="WhatsApp">💬</button>` : ''}
                ${l.email ? `<a class="mini-btn" href="mailto:${esc(l.email)}" title="${esc(l.email)}">✉</a>` : ''}
              </div>
            </td>
            <td><select class="pill-select" style="--c:${esc(Store.statusColor(l.status))}" data-chg="row-status" data-id="${esc(l.id)}">${statusOpts(l.status)}</select></td>
            <td>${admin ? `<select class="input input-sm" data-chg="row-assign" data-id="${esc(l.id)}">${memberOpts(l.assignedTo)}</select>` : esc(Store.memberName(l.assignedTo))}</td>
            <td><div>${esc(l.source || '—')}</div><div class="muted small">${esc(l.platform || '')}</div></td>
            <td class="truncate" title="${esc(l.campaign)}">${esc(l.campaign || '—')}${l.form ? `<div class="muted small truncate">${esc(l.form)}</div>` : ''}</td>
            <td class="nowrap">${l.followUp ? `<span class="fu ${fs}">${fmtDT(l.followUp)}</span>` : '<span class="muted">—</span>'}</td>
            <td class="nowrap" title="${esc(fmtDT(l.createdAt))}">${timeAgo(l.createdAt)}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>
      <div class="pager">
        <span class="muted">${(F.page - 1) * F.perPage + 1}–${Math.min(F.page * F.perPage, list.length)} of ${list.length} leads</span>
        <div><button class="btn btn-sm btn-ghost" data-act="page" data-d="-1" ${F.page <= 1 ? 'disabled' : ''}>‹ Prev</button>
        <span class="muted">Page ${F.page} / ${pages}</span>
        <button class="btn btn-sm btn-ghost" data-act="page" data-d="1" ${F.page >= pages ? 'disabled' : ''}>Next ›</button></div>
      </div>` : `<div class="empty">
        <div class="empty-ico">📭</div>
        <h3>No leads found</h3>
        <p class="muted">${base.length ? 'Try changing the filters.' : (admin ? 'Connect your Google Sheet in Integrations or add a lead manually.' : 'No leads have been assigned to you yet.')}</p>
      </div>`;
    this.bulkBar();
  },

  bulkBar() {
    const n = LeadFilter.selected.size, el = $('#bulk-bar');
    if (!el) return;
    if (!n) { el.innerHTML = ''; return; }
    const admin = Store.isAdmin();
    el.innerHTML = `<div class="bulk">
      <b>${n} selected</b>
      ${admin ? `<select class="input input-sm" id="bulk-assign"><option value="">Assign to…</option><option value="__rr">↻ Round-robin (all active telecallers)</option><option value="__none">— Unassign —</option>${Store.state.members.filter(m => m.active).map(m => `<option value="${esc(m.id)}">${esc(m.name)} (${esc(m.role)})</option>`).join('')}</select>
      <button class="btn btn-sm btn-primary" data-act="bulk-assign">Assign</button>` : ''}
      <select class="input input-sm" id="bulk-status"><option value="">Change status…</option>${Store.statusNames().map(s => `<option>${esc(s)}</option>`).join('')}</select>
      <button class="btn btn-sm" data-act="bulk-status">Apply</button>
      ${admin ? `<button class="btn btn-sm btn-danger" data-act="bulk-delete">Delete</button>` : ''}
      <button class="btn btn-sm btn-ghost" data-act="bulk-clear">Clear selection</button>
    </div>`;
  },

  /* ---------------------------------------------------------- Follow-ups */
  followups() {
    const leads = Store.visibleLeads().filter(l => l.followUp && !isClosed(l.status)).sort((a, b) => String(a.followUp).localeCompare(String(b.followUp)));
    const groups = { overdue: [], today: [], upcoming: [] };
    leads.forEach(l => { const s = fuState(l); if (groups[s]) groups[s].push(l); });
    const col = (key, title, cls) => `
      <div class="card fu-col ${cls}">
        <div class="card-head"><h3>${title} <span class="count">${groups[key].length}</span></h3></div>
        ${groups[key].length ? groups[key].map(l => `
          <div class="fu-card" data-act="open-lead" data-id="${esc(l.id)}">
            <div class="fu-top"><b>${esc(l.name)}</b>${statusPill(l.status)}</div>
            <div class="muted small">📅 ${fmtDT(l.followUp)} · 👤 ${esc(Store.memberName(l.assignedTo))}</div>
            <div class="muted small">${esc(l.phone)} ${l.campaign ? '· ' + esc(l.campaign) : ''}</div>
            ${l.activity && l.activity.find(a => a.type === 'note') ? `<div class="fu-note">“${esc(l.activity.find(a => a.type === 'note').text.slice(0, 120))}”</div>` : ''}
            <div class="row-actions">
              ${l.phone ? `<a class="mini-btn call" href="tel:${esc(Phone.clean(l.phone))}" data-act="call" data-id="${esc(l.id)}">📞 Call</a>
              <button class="mini-btn wa" data-act="wa" data-id="${esc(l.id)}">💬 WhatsApp</button>` : ''}
            </div>
          </div>`).join('') : '<div class="empty-sm">Nothing here 🎉</div>'}
      </div>`;
    return `<div class="grid-3 fu-grid">${col('overdue', '🔴 Overdue', 'red')}${col('today', '🟡 Today', 'amber')}${col('upcoming', '🟢 Upcoming', 'green')}</div>`;
  },

  /* ---------------------------------------------------------------- Team */
  team() {
    const s = Store.s;
    const first = s.statuses[0] ? s.statuses[0].name : 'New';
    const unassigned = Store.state.leads.filter(l => !l.assignedTo && !isClosed(l.status)).length;
    return `
      <div class="grid-2 top">
        <div class="card">
          <div class="card-head"><h3>Lead assignment</h3></div>
          <label class="field"><span>Auto-assign new leads from Google Sheet</span>
            <select class="input" data-chg="auto-assign">
              <option value="off" ${s.autoAssign === 'off' ? 'selected' : ''}>Off — I will assign manually</option>
              <option value="roundrobin" ${s.autoAssign === 'roundrobin' ? 'selected' : ''}>Round-robin between active telecallers</option>
            </select></label>
          <p class="muted small">Round-robin gives each new lead to the next active telecaller in turn, so everyone gets an equal share.</p>
          <div class="row gap">
            <button class="btn btn-primary" data-act="distribute" ${unassigned ? '' : 'disabled'}>↻ Distribute ${unassigned} unassigned lead(s) now</button>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h3>How roles work</h3></div>
          <ul class="help-list">
            <li><b>Admin / Manager</b> — sees every lead, assigns leads, manages team, templates, integrations & settings.</li>
            <li><b>Telecaller</b> — sees only leads assigned to them, updates status, adds call notes, sets follow-ups and sends WhatsApp templates.</li>
            <li>Every member signs in with their own <b>username & password</b>. Use <b>🔑 Password</b> to reset a member's password, and <b>Recovery code</b> to give them a code for the “Forgot password?” screen.</li>
          </ul>
        </div>
      </div>
      <div class="card flush">
        <div class="card-head pad"><h3>Team members (${Store.state.members.length})</h3><button class="btn btn-primary" data-act="member-edit">+ Add member</button></div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Name</th><th>Username / ID</th><th>Role</th><th>Phone</th><th>Email</th><th>Assigned</th><th>${esc(first)}</th><th>${esc(s.wonStatus)}</th><th>Status</th><th></th></tr></thead>
          <tbody>${Store.state.members.map(m => {
            const mine = Store.state.leads.filter(l => l.assignedTo === m.id);
            return `<tr>
              <td><span class="avatar sm">${esc(initials(m.name))}</span><b>${esc(m.name)}</b>${m.id === s.currentUser ? ' <span class="tag">you</span>' : ''}</td>
              <td>${m.username ? `<code>${esc(m.username)}</code>` : '<span class="tag warn">no login</span>'}${m.username && !m.passHash ? ' <span class="tag warn">no password</span>' : ''}</td>
              <td>${esc(m.role)}</td><td>${esc(m.phone || '—')}</td><td>${esc(m.email || '—')}</td>
              <td><a href="#/leads" data-act="member-leads" data-id="${esc(m.id)}">${mine.length}</a></td>
              <td>${mine.filter(l => l.status === first).length}</td>
              <td>${mine.filter(l => l.status === s.wonStatus).length}</td>
              <td>${m.active ? '<span class="tag ok">Active</span>' : '<span class="tag">Inactive</span>'}</td>
              <td class="nowrap right"><button class="btn btn-sm btn-ghost" data-act="member-edit" data-id="${esc(m.id)}">Edit</button>
                <button class="btn btn-sm btn-ghost" data-act="member-pw" data-id="${esc(m.id)}" title="Set a new password">🔑 Password</button>
                <button class="btn btn-sm btn-ghost" data-act="member-code" data-id="${esc(m.id)}" title="Generate a new recovery code">Recovery code</button>
                ${m.id !== s.currentUser ? `<button class="btn btn-sm btn-ghost danger" data-act="member-del" data-id="${esc(m.id)}">Delete</button>` : ''}</td>
            </tr>`;
          }).join('')}</tbody>
        </table></div>
      </div>`;
  },

  /* ----------------------------------------------------------- WhatsApp */
  whatsapp() {
    const w = Store.s.whatsapp, admin = Store.isAdmin();
    return `
      ${admin ? `<div class="card">
        <div class="card-head"><h3>WhatsApp sending method</h3></div>
        <div class="radio-cards">
          <label class="radio-card ${w.mode === 'wame' ? 'on' : ''}"><input type="radio" name="wamode" value="wame" data-chg="wa-mode" ${w.mode === 'wame' ? 'checked' : ''}>
            <b>WhatsApp Web / App (wa.me)</b><span class="muted small">Opens WhatsApp with the message pre-filled from the telecaller's own number. Free, no setup.</span></label>
          <label class="radio-card ${w.mode === 'n8n' ? 'on' : ''}"><input type="radio" name="wamode" value="n8n" data-chg="wa-mode" ${w.mode === 'n8n' ? 'checked' : ''}>
            <b>WhatsApp Business API via n8n</b><span class="muted small">Sends a <code>whatsapp.sent</code> webhook to n8n, which sends the message through WhatsApp Cloud API / Interakt / Wati etc.</span></label>
        </div>
        <label class="check"><input type="checkbox" data-chg="wa-auto" ${w.autoContacted ? 'checked' : ''}> Automatically move lead from “${esc(Store.s.statuses[0] ? Store.s.statuses[0].name : 'New')}” to “Contacted” after a WhatsApp is sent</label>
      </div>` : ''}
      <div class="section-head"><h2>Message templates</h2>${admin ? '<button class="btn btn-primary" data-act="tpl-edit">+ New template</button>' : ''}</div>
      <div class="tpl-grid">
        ${Store.state.templates.map(t => `
          <div class="card tpl">
            <div class="card-head"><div><h3>${esc(t.name)}</h3><span class="tag">${esc(t.category || 'General')}</span></div>
              ${admin ? `<div><button class="btn btn-sm btn-ghost" data-act="tpl-edit" data-id="${esc(t.id)}">Edit</button><button class="btn btn-sm btn-ghost danger" data-act="tpl-del" data-id="${esc(t.id)}">Delete</button></div>` : ''}</div>
            <div class="wa-bubble">${esc(WhatsApp.render(t.body, null)).replace(/\n/g, '<br>')}</div>
          </div>`).join('') || '<div class="empty-sm">No templates yet.</div>'}
      </div>`;
  },

  /* -------------------------------------------------------- Integrations */
  integrations() {
    const sh = Store.s.sheet, w = Store.s.webhook, c = Store.s.cloud;
    return `
      <div class="card">
        <div class="card-head"><h3>📗 Google Sheet — Meta Ads leads</h3>${sh.url ? '<span class="tag ok">Connected</span>' : '<span class="tag">Not connected</span>'}</div>
        <form data-form="sheet" class="form-grid">
          <label class="field span-2"><span>Google Sheet URL</span>
            <input class="input" name="url" placeholder="https://docs.google.com/spreadsheets/d/…/edit#gid=0" value="${esc(sh.url)}"></label>
          <label class="field"><span>Tab / sheet name <em class="muted">(optional — uses the tab in the URL)</em></span>
            <input class="input" name="tab" placeholder="e.g. Sheet1" value="${esc(sh.tab)}"></label>
          <label class="field"><span>Default lead source</span>
            <select class="input" name="defaultSource">${Store.s.sources.map(x => `<option ${x === sh.defaultSource ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
          <label class="field"><span>Auto-sync every (minutes)</span>
            <input class="input" type="number" min="1" name="intervalMin" value="${esc(sh.intervalMin)}"></label>
          <label class="check field"><input type="checkbox" name="autoSync" ${sh.autoSync ? 'checked' : ''}> Auto-fetch new leads while the CRM is open</label>
          <div class="span-2 row gap">
            <button class="btn btn-primary" type="submit">Save & sync now</button>
            ${sh.url ? `<a class="btn btn-ghost" href="${esc(sh.url)}" target="_blank" rel="noopener">Open sheet ↗</a>` : ''}
          </div>
        </form>
        ${sh.lastSync || sh.lastResult ? `<div class="sync-result ${/^Error/.test(sh.lastResult) ? 'err' : ''}"><b>Last sync:</b> ${sh.lastSync ? fmtDT(sh.lastSync) : '—'} — ${esc(sh.lastResult)}</div>` : ''}
        ${sh.headers && sh.headers.length ? `<details class="mt"><summary>Detected columns (${sh.headers.length})</summary><div class="chips">${sh.headers.map(h => `<span class="chip">${esc(h)}</span>`).join('')}</div></details>` : ''}
        <details class="mt help"><summary>How to set this up (2 minutes)</summary>
          <ol>
            <li>Connect your Meta Lead Ads form to a Google Sheet (Meta Business Suite integration, Zapier, Pabbly, LeadsBridge or n8n).</li>
            <li>In Google Sheets click <b>Share → General access → “Anyone with the link” → Viewer</b>.</li>
            <li>Copy the sheet URL from the browser and paste it above.</li>
            <li>Columns are detected automatically: <code>id, created_time, campaign_name, adset_name, ad_name, form_name, platform, full_name, phone_number, email, city</code>. Extra form questions are saved on the lead too.</li>
            <li>Leads already in the CRM are matched by Meta lead ID or phone number, so they are never imported twice.</li>
          </ol>
        </details>
      </div>

      <div class="card">
        <div class="card-head"><h3>⚡ n8n Automation — Webhook</h3>${w.enabled && w.url ? '<span class="tag ok">Active</span>' : '<span class="tag">Off</span>'}</div>
        <form data-form="webhook" class="form-grid">
          <label class="field span-2"><span>n8n Webhook URL (Production URL of a “Webhook” node, method POST)</span>
            <input class="input" name="url" placeholder="https://your-n8n.com/webhook/digi-help-crm" value="${esc(w.url)}"></label>
          <label class="field"><span>Secret header value <em class="muted">(sent as X-CRM-Secret)</em></span>
            <input class="input" name="secret" placeholder="optional" value="${esc(w.secret)}"></label>
          <label class="check field"><input type="checkbox" name="enabled" ${w.enabled ? 'checked' : ''}> Enable webhook</label>
          <div class="span-2"><div class="field-label">Send these events</div>
            <div class="event-grid">${Object.entries(ALL_WEBHOOK_EVENTS).map(([k, d]) => `<label class="check"><input type="checkbox" name="ev_${k}" ${w.events[k] ? 'checked' : ''}><code>${k}</code><span class="muted small">${esc(d)}</span></label>`).join('')}</div></div>
          <div class="span-2 row gap"><button class="btn btn-primary" type="submit">Save</button><button class="btn btn-ghost" type="button" data-act="wh-test">Send test event</button></div>
        </form>
        <details class="mt help"><summary>Example payload & ideas</summary>
<pre class="code">{
  "event": "lead.status_changed",
  "timestamp": "2026-11-06T10:15:00.000Z",
  "company": "${esc(Store.s.company)}",
  "actor": { "id": "m_x", "name": "Priya", "role": "Telecaller" },
  "previousStatus": "New",
  "lead": { "id": "L_…", "name": "Rahul Sharma", "phone": "+919876543210",
            "phoneIntl": "919876543210", "status": "Interested", "source": "Meta Ads",
            "platform": "Instagram", "campaign": "…", "assignedTo": { "name": "Priya" }, … }
}</pre>
          <ul class="help-list">
            <li><b>lead.assigned</b> → n8n sends a WhatsApp/SMS to the telecaller: “New lead assigned: Rahul, 98765…”.</li>
            <li><b>lead.status_changed</b> to Converted → create invoice / add to Google Contacts / notify owner.</li>
            <li><b>whatsapp.sent</b> (API mode) → n8n sends the message text via WhatsApp Cloud API.</li>
            <li><b>lead.followup_set</b> → create Google Calendar reminder.</li>
          </ul>
          <p class="muted small">If the CRM is opened directly as a file, set <b>Allowed Origins (CORS)</b> to <code>*</code> in the n8n Webhook node options.</p>
        </details>
        ${Store.state.webhookLog.length ? `<details class="mt"><summary>Recent webhook log (${Store.state.webhookLog.length})</summary>
          <table class="table compact"><thead><tr><th>Time</th><th>Event</th><th>Lead</th><th>Result</th></tr></thead><tbody>
          ${Store.state.webhookLog.slice(0, 25).map(x => `<tr><td class="nowrap">${fmtDT(x.at)}</td><td><code>${esc(x.event)}</code></td><td>${esc(x.lead)}</td><td>${x.ok ? '<span class="tag ok">' : '<span class="tag err">'}${esc(x.info)}</span></td></tr>`).join('')}
          </tbody></table></details>` : ''}
      </div>

      <div class="card">
        <div class="card-head"><h3>☁ Team Cloud Sync (share leads across all team computers)</h3>${c.enabled && c.url ? '<span class="tag ok">On</span>' : '<span class="tag">Off</span>'}</div>
        <p class="muted">Without this, data is saved only in this browser. Turn it on so every telecaller sees their assigned leads, and every status update / note reaches the admin in real time (every 30 sec). Uses a free Google Apps Script in your own Google account.</p>
        <form data-form="cloud" class="form-grid">
          <label class="field span-2"><span>Apps Script Web App URL</span>
            <input class="input" name="url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(c.url)}"></label>
          <label class="check field"><input type="checkbox" name="enabled" ${c.enabled ? 'checked' : ''}> Enable team sync</label>
          <div class="field muted small">${c.lastSync ? 'Last sync ' + fmtDT(c.lastSync) + ' — ' + esc(c.lastResult) : esc(c.lastResult || '')}</div>
          <div class="span-2 row gap"><button class="btn btn-primary" type="submit">Save & sync now</button></div>
        </form>
        <details class="mt help"><summary>Setup steps (5 minutes, one time)</summary>
          <ol>
            <li>Create a new blank Google Sheet named <b>“DHM CRM Database”</b> (keep it private).</li>
            <li>Open <b>Extensions → Apps Script</b>, delete the sample code, paste the contents of <code>apps-script/Code.gs</code> from the CRM folder, and save.</li>
            <li>Click <b>Deploy → New deployment → Web app</b>. Execute as: <b>Me</b>. Who has access: <b>Anyone</b>. Deploy and authorise.</li>
            <li>Copy the Web app URL (ends with <code>/exec</code>), paste it above on <b>every</b> team computer, and enable.</li>
          </ol>
        </details>
      </div>`;
  },

  /* ------------------------------------------------------------ Settings */
  settings() {
    const s = Store.s;
    return `
      <div class="grid-2 top">
        <div class="card">
          <div class="card-head"><h3>Business</h3></div>
          <form data-form="biz" class="form-grid one">
            <label class="field"><span>Company name (used in WhatsApp templates)</span><input class="input" name="company" value="${esc(s.company)}"></label>
            <label class="field"><span>Default country code (for 10-digit numbers)</span><input class="input" name="countryCode" value="${esc(s.countryCode)}"></label>
            <label class="field"><span>“Won” status (counted as conversion)</span><select class="input" name="wonStatus">${Store.statusNames().map(n => `<option ${n === s.wonStatus ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
            <label class="field"><span>Lead sources (one per line)</span><textarea class="input" rows="6" name="sources">${esc(s.sources.join('\n'))}</textarea></label>
            <label class="field"><span>Platforms (one per line)</span><textarea class="input" rows="6" name="platforms">${esc(s.platforms.join('\n'))}</textarea></label>
            <div><button class="btn btn-primary">Save</button></div>
          </form>
        </div>
        <div class="card">
          <div class="card-head"><h3>Customer status pipeline</h3></div>
          <p class="muted small">The first status is given to every new lead. “Closed” statuses are excluded from follow-ups and auto-distribution.</p>
          <div id="status-editor">${s.statuses.map((x, i) => this.statusRow(x, i)).join('')}</div>
          <div class="row gap mt"><button class="btn btn-ghost" data-act="status-add">+ Add status</button><button class="btn btn-primary" data-act="status-save">Save statuses</button></div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Data & backup</h3></div>
        <p class="muted small">${Store.state.leads.length} leads · ${Store.state.members.length} team members · ${Store.state.templates.length} templates. Data is stored in this browser${Cloud.enabled() ? ' and synced to your Google Apps Script database' : ''}.</p>
        <div class="row gap wrap">
          <button class="btn" data-act="backup">⭳ Download full backup (JSON)</button>
          <label class="btn">⭱ Restore backup<input type="file" accept=".json" hidden data-chg="restore"></label>
          <button class="btn" data-act="export-csv-all">⭳ Export all leads (CSV)</button>
          <button class="btn" data-act="demo">✨ Load demo leads</button>
          <button class="btn btn-danger" data-act="reset">Delete all leads</button>
        </div>
      </div>`;
  },

  statusRow(x, i) {
    return `<div class="status-row" data-i="${i}">
      <input type="color" class="color" value="${esc(x.color)}">
      <input class="input s-name" value="${esc(x.name)}">
      <label class="check small"><input type="checkbox" class="s-closed" ${x.closed ? 'checked' : ''}> Closed</label>
      <button class="btn btn-sm btn-ghost" data-act="status-up" title="Move up">↑</button>
      <button class="btn btn-sm btn-ghost danger" data-act="status-del" title="Remove">✕</button>
    </div>`;
  },
};

/* ================================================================= Drawer */
const Drawer = {
  open(id) { App.drawerLead = id; this.render(); $('#drawer').classList.add('open'); $('#drawer-backdrop').classList.add('open'); $('#drawer').setAttribute('aria-hidden', 'false'); },
  close() { App.drawerLead = null; $('#drawer').classList.remove('open'); $('#drawer-backdrop').classList.remove('open'); $('#drawer').setAttribute('aria-hidden', 'true'); },

  render() {
    const l = Store.lead(App.drawerLead);
    if (!l) { this.close(); return; }
    const s = Store.s, admin = Store.isAdmin();
    const fs = fuState(l);
    const opt = (arr, cur) => arr.map(v => `<option ${v === cur ? 'selected' : ''}>${esc(v)}</option>`).join('');
    const withCur = (arr, cur) => (cur && !arr.includes(cur) ? [cur, ...arr] : arr);
    const actIco = { note: '📝', call: '📞', whatsapp: '💬', status: '🔄', assign: '👤', followup: '⏰', edit: '✏️', system: '⚙' };
    const quickFU = [['+1h', 1 / 24], ['Tomorrow', 1], ['+2 days', 2], ['+1 week', 7]];
    $('#drawer').innerHTML = `
      <div class="drawer-head">
        <span class="avatar lg">${esc(initials(l.name))}</span>
        <div class="grow">
          <h2>${esc(l.name)}</h2>
          <div class="muted small">${esc(l.source)}${l.platform ? ' · ' + esc(l.platform) : ''} · received ${fmtDT(l.createdAt)}</div>
        </div>
        <button class="icon-btn" data-act="drawer-close" aria-label="Close">✕</button>
      </div>
      <div class="drawer-actions">
        ${l.phone ? `<a class="btn btn-call" href="tel:${esc(Phone.clean(l.phone))}" data-act="call" data-id="${esc(l.id)}">📞 Call ${esc(l.phone)}</a>
        <button class="btn btn-wa" data-act="wa" data-id="${esc(l.id)}">💬 WhatsApp</button>` : '<span class="muted">No phone number</span>'}
        ${l.email ? `<a class="btn btn-ghost" href="mailto:${esc(l.email)}">✉ Email</a>` : ''}
      </div>

      <div class="drawer-body">
        <div class="field-label">Customer status</div>
        <div class="status-chips">${s.statuses.map(x => `<button class="schip ${x.name === l.status ? 'on' : ''}" style="--c:${esc(x.color)}" data-act="d-status" data-v="${esc(x.name)}">${esc(x.name)}</button>`).join('')}</div>

        <div class="form-grid mt">
          <label class="field"><span>Assigned to</span>
            ${admin ? `<select class="input" data-chg="d-field" data-f="assignedTo"><option value="">— Unassigned —</option>${Store.state.members.filter(m => m.active || m.id === l.assignedTo).map(m => `<option value="${esc(m.id)}" ${m.id === l.assignedTo ? 'selected' : ''}>${esc(m.name)} (${esc(m.role)})</option>`).join('')}</select>`
              : `<input class="input" disabled value="${esc(Store.memberName(l.assignedTo))}">`}</label>
          <label class="field"><span>Next follow-up ${fs ? `<span class="fu ${fs}">${fs}</span>` : ''}</span>
            <input class="input" type="datetime-local" value="${toLocalInput(l.followUp)}" data-chg="d-followup"></label>
          <div class="span-2 quick-fu">${quickFU.map(([t, d]) => `<button class="btn btn-sm btn-ghost" data-act="d-fu" data-days="${d}">${t}</button>`).join('')}${l.followUp ? '<button class="btn btn-sm btn-ghost danger" data-act="d-fu" data-days="clear">Clear</button>' : ''}</div>
        </div>

        <div class="add-note">
          <textarea class="input" id="note-text" rows="2" placeholder="Add call remark / note… (e.g. Asked to call back after 6pm, budget 20k/month)"></textarea>
          <button class="btn btn-primary" data-act="d-note">Add note</button>
        </div>

        <details class="mt" open><summary>Lead details</summary>
          <div class="form-grid mt">
            <label class="field"><span>Name</span><input class="input" value="${esc(l.name)}" data-chg="d-field" data-f="name"></label>
            <label class="field"><span>Phone</span><input class="input" value="${esc(l.phone)}" data-chg="d-field" data-f="phone"></label>
            <label class="field"><span>Email</span><input class="input" value="${esc(l.email)}" data-chg="d-field" data-f="email"></label>
            <label class="field"><span>City</span><input class="input" value="${esc(l.city)}" data-chg="d-field" data-f="city"></label>
            <label class="field"><span>Lead source</span><select class="input" data-chg="d-field" data-f="source">${opt(withCur(s.sources, l.source), l.source)}</select></label>
            <label class="field"><span>Platform</span><select class="input" data-chg="d-field" data-f="platform"><option value="">—</option>${opt(withCur(s.platforms, l.platform), l.platform)}</select></label>
            <label class="field"><span>Campaign</span><input class="input" value="${esc(l.campaign)}" data-chg="d-field" data-f="campaign"></label>
            <label class="field"><span>Deal value (₹)</span><input class="input" type="number" value="${esc(l.value)}" data-chg="d-field" data-f="value"></label>
            ${l.adset ? `<div class="field"><span>Ad set</span><div class="ro">${esc(l.adset)}</div></div>` : ''}
            ${l.ad ? `<div class="field"><span>Ad</span><div class="ro">${esc(l.ad)}</div></div>` : ''}
            ${l.form ? `<div class="field"><span>Form</span><div class="ro">${esc(l.form)}</div></div>` : ''}
            ${l.metaId ? `<div class="field"><span>Meta lead ID</span><div class="ro">${esc(l.metaId)}</div></div>` : ''}
          </div>
        </details>

        ${l.extra && Object.keys(l.extra).length ? `<details class="mt" open><summary>Form answers (${Object.keys(l.extra).length})</summary>
          <dl class="kv">${Object.entries(l.extra).map(([k, v]) => `<dt>${esc(k.replace(/_/g, ' '))}</dt><dd>${esc(v)}</dd>`).join('')}</dl></details>` : ''}

        <div class="field-label mt">Activity timeline</div>
        <div class="timeline">
          ${(l.activity || []).map(a => `<div class="tl ${esc(a.type)}"><div class="tl-ico">${actIco[a.type] || '•'}</div>
            <div class="tl-body"><div class="tl-text">${esc(a.text).replace(/\n/g, '<br>')}</div><div class="muted small">${esc(a.by)} · ${fmtDT(a.at)}</div></div></div>`).join('') || '<div class="empty-sm">No activity yet</div>'}
        </div>
        ${admin ? `<div class="mt right"><button class="btn btn-sm btn-ghost danger" data-act="d-delete">Delete lead</button></div>` : ''}
      </div>`;
  },
};

/* ======================================================= WhatsApp composer */
function openWhatsApp(leadId) {
  const l = Store.lead(leadId);
  if (!l) return;
  if (!l.phone) { UI.toast('This lead has no phone number', 'error'); return; }
  const tpls = Store.state.templates;
  const first = tpls[0];
  const m = UI.modal(`
    <div class="modal-head"><h3>💬 WhatsApp ${esc(l.name)} <span class="muted small">+${esc(Phone.intl(l.phone))}</span></h3><button class="icon-btn" data-act="modal-close">✕</button></div>
    <div class="wa-compose">
      <div class="tpl-list">
        <div class="field-label">Templates</div>
        ${tpls.map((t, i) => `<button class="tpl-pick ${i === 0 ? 'on' : ''}" data-act="wa-pick" data-id="${esc(t.id)}"><b>${esc(t.name)}</b><span class="muted small">${esc(t.category || '')}</span></button>`).join('')}
        <button class="tpl-pick" data-act="wa-pick" data-id=""><b>✏ Blank message</b></button>
      </div>
      <div class="wa-edit">
        <div class="field-label">Message (you can edit before sending)</div>
        <textarea class="input" id="wa-text" rows="11">${esc(first ? WhatsApp.render(first.body, l) : '')}</textarea>
        <input type="hidden" id="wa-tpl" value="${esc(first ? first.id : '')}">
        <div class="muted small">${Store.s.whatsapp.mode === 'n8n' ? 'Mode: WhatsApp Business API via n8n webhook' : 'Mode: opens WhatsApp Web / App with this message'}</div>
      </div>
    </div>
    <div class="modal-foot"><button class="btn btn-ghost" data-act="modal-close">Cancel</button><button class="btn btn-wa" data-act="wa-send" data-id="${esc(l.id)}">Send on WhatsApp ➤</button></div>`, { wide: true });
  m.dataset.lead = l.id;
}

/* =============================================================== Handlers */
const Handlers = {
  'modal-close': () => UI.closeModal(),
  'copy-text': el => { if (navigator.clipboard) navigator.clipboard.writeText(el.dataset.text); el.textContent = 'Copied ✓'; },
  'drawer-close': () => Drawer.close(),
  'kpi-link': el => {
    const [route, qs] = el.dataset.link.split('?');
    if (route === 'leads') {
      Object.assign(LeadFilter, { q: '', status: '', assignee: '', source: '', platform: '', range: 'all', fu: '', page: 1 });
      if (qs) new URLSearchParams(qs).forEach((v, k) => { LeadFilter[k] = v; });
    }
    if (location.hash === '#/' + route) App.go(); else location.hash = '#/' + route;
  },
  'open-lead': el => Drawer.open(el.dataset.id),
  call: el => { Actions.logCall(el.dataset.id); window.location.href = el.getAttribute('href'); if (App.drawerLead) Drawer.render(); },
  wa: el => openWhatsApp(el.dataset.id),
  'wa-pick': el => {
    const l = Store.lead($('#modal').dataset.lead);
    const t = Store.state.templates.find(x => x.id === el.dataset.id);
    $('#wa-text').value = t ? WhatsApp.render(t.body, l) : '';
    $('#wa-tpl').value = t ? t.id : '';
    $$('.tpl-pick').forEach(b => b.classList.toggle('on', b === el));
    $('#wa-text').focus();
  },
  'wa-send': el => {
    const l = Store.lead(el.dataset.id);
    const text = $('#wa-text').value.trim();
    if (!text) { UI.toast('Message is empty', 'error'); return; }
    const tpl = Store.state.templates.find(x => x.id === $('#wa-tpl').value);
    const mode = Store.s.whatsapp.mode;
    if (mode === 'wame') window.open(WhatsApp.link(l.phone, text), '_blank', 'noopener');
    Store.addActivity(l, 'whatsapp', `WhatsApp sent${tpl ? ' (' + tpl.name + ')' : ''}:\n${text}`);
    l.lastContactAt = new Date().toISOString();
    Store.markDirty(l); Store.save();
    Webhook.fire('whatsapp.sent', { lead: l, message: text, template: tpl ? tpl.name : null, mode, to: Phone.intl(l.phone) }, { force: mode === 'n8n' })
      .then(r => { if (mode === 'n8n') UI.toast(r.ok ? 'Sent to n8n for delivery' : 'n8n webhook failed: ' + (r.info || 'not configured'), r.ok ? 'success' : 'error'); });
    const first = Store.s.statuses[0] && Store.s.statuses[0].name;
    if (Store.s.whatsapp.autoContacted && l.status === first && Store.statusNames().includes('Contacted')) Actions.updateLead(l.id, { status: 'Contacted' });
    UI.closeModal();
    if (mode === 'wame') UI.toast('WhatsApp opened — message logged', 'success');
    App.refresh();
  },

  /* leads list */
  'status-tab': el => { LeadFilter.status = el.dataset.v; LeadFilter.page = 1; Views.leadsTable(); },
  sort: el => { const k = el.dataset.k; if (LeadFilter.sort === k) LeadFilter.dir = LeadFilter.dir === 'asc' ? 'desc' : 'asc'; else { LeadFilter.sort = k; LeadFilter.dir = k === 'createdAt' ? 'desc' : 'asc'; } Views.leadsTable(); },
  page: el => { LeadFilter.page += +el.dataset.d; Views.leadsTable(); $('#view').scrollTop = 0; },
  'clear-filters': () => { Object.assign(LeadFilter, { q: '', status: '', assignee: '', source: '', platform: '', range: 'all', fu: '', page: 1 }); LeadFilter.selected.clear(); App.render(); },
  'add-lead': () => leadForm(),
  'export-csv': () => exportCSV(LeadFilter.apply(Store.visibleLeads()), 'leads-filtered'),
  'export-csv-all': () => exportCSV(Store.state.leads, 'leads-all'),
  'bulk-clear': () => { LeadFilter.selected.clear(); Views.leadsTable(); },
  'bulk-assign': () => {
    const v = $('#bulk-assign').value;
    if (!v) return UI.toast('Choose a team member', 'error');
    const ids = [...LeadFilter.selected];
    if (v === '__rr' && !Store.activeCallers().length) return UI.toast('No active telecallers in Team', 'error');
    ids.forEach(id => Actions.updateLead(id, { assignedTo: v === '__rr' ? Store.nextAssignee() : v === '__none' ? '' : v }));
    Store.save();
    UI.toast(`${ids.length} lead(s) assigned`, 'success');
    LeadFilter.selected.clear(); App.refresh();
  },
  'bulk-status': () => {
    const v = $('#bulk-status').value;
    if (!v) return UI.toast('Choose a status', 'error');
    const ids = [...LeadFilter.selected];
    ids.forEach(id => Actions.updateLead(id, { status: v }));
    UI.toast(`${ids.length} lead(s) updated`, 'success');
    LeadFilter.selected.clear(); App.refresh();
  },
  'bulk-delete': () => {
    const ids = [...LeadFilter.selected];
    if (!UI.confirm(`Delete ${ids.length} lead(s)? This cannot be undone.`)) return;
    Actions.deleteLeads(ids); LeadFilter.selected.clear(); UI.toast('Deleted'); App.refresh();
  },

  /* drawer */
  'd-status': el => { Actions.updateLead(App.drawerLead, { status: el.dataset.v }); Drawer.render(); App.refresh(); },
  'd-fu': el => {
    let v = '';
    if (el.dataset.days !== 'clear') {
      const d = new Date(); const days = +el.dataset.days;
      if (days < 1) d.setHours(d.getHours() + 1, 0, 0, 0); else { d.setDate(d.getDate() + days); d.setHours(11, 0, 0, 0); }
      v = d.toISOString();
    }
    Actions.updateLead(App.drawerLead, { followUp: v }); Drawer.render(); App.refresh();
  },
  'd-note': () => {
    const t = $('#note-text').value;
    if (!t.trim()) return;
    Actions.addNote(App.drawerLead, t); Drawer.render(); UI.toast('Note added', 'success');
  },
  'd-delete': () => {
    if (!UI.confirm('Delete this lead permanently?')) return;
    Actions.deleteLeads([App.drawerLead]); Drawer.close(); App.refresh();
  },

  /* team */
  distribute: () => { const n = Actions.distributeUnassigned(); if (n) UI.toast(`${n} lead(s) distributed`, 'success'); App.render(); },
  'member-edit': el => memberForm(el.dataset.id),
  logout: () => { if (UI.confirm('Sign out of the CRM?')) Auth.logout(); },
  'my-password': () => {
    const me = Store.me();
    UI.modal(`
      <div class="modal-head"><h3>🔑 Change my password</h3><button class="icon-btn" data-act="modal-close">✕</button></div>
      <p class="muted small">Signed in as <b>${esc(me.name)}</b> (<code>${esc(me.username)}</code>)</p>
      <form data-form="mypw" class="form-grid one">
        <label class="field"><span>Current password</span><input class="input" name="cur" type="password" autocomplete="current-password" required></label>
        <label class="field"><span>New password (min 6 characters)</span><input class="input" name="p1" type="password" autocomplete="new-password" minlength="6" required></label>
        <label class="field"><span>Confirm new password</span><input class="input" name="p2" type="password" autocomplete="new-password" minlength="6" required></label>
        <div class="modal-foot"><button type="button" class="btn btn-ghost" data-act="my-code">Get a new recovery code</button><button class="btn btn-primary">Change password</button></div>
      </form>`);
  },
  'my-code': async () => {
    if (!UI.confirm('Create a new recovery code? Your old code will stop working.')) return;
    const me = Store.me();
    const code = await Auth.newRecoveryCode(me);
    Store.touchConfig();
    showCredentials(me, null, code);
  },
  'member-pw': el => {
    const m = Store.member(el.dataset.id);
    if (m.role === 'Admin' && Store.me().role !== 'Admin') return UI.toast('Only an Admin can reset an Admin password', 'error');
    if (!m.username) return UI.toast('Set a username for this member first (Edit)', 'error');
    UI.modal(`
      <div class="modal-head"><h3>🔑 Reset password — ${esc(m.name)}</h3><button class="icon-btn" data-act="modal-close">✕</button></div>
      <form data-form="setpw" class="form-grid one">
        <input type="hidden" name="id" value="${esc(m.id)}">
        <label class="field"><span>Username / ID</span><input class="input" value="${esc(m.username || '')}" disabled></label>
        <label class="field"><span>New password (min 6 characters)</span><input class="input" name="p1" type="text" autocomplete="new-password" minlength="6" required></label>
        <label class="field"><span>Confirm new password</span><input class="input" name="p2" type="text" autocomplete="new-password" minlength="6" required></label>
        <p class="muted small">${esc(m.name)} will be signed out on all devices and must use the new password.</p>
        <div class="modal-foot"><button type="button" class="btn btn-ghost" data-act="modal-close">Cancel</button><button class="btn btn-primary">Set new password</button></div>
      </form>`);
  },
  'member-code': async el => {
    const m = Store.member(el.dataset.id);
    if (m.role === 'Admin' && Store.me().role !== 'Admin') return UI.toast('Only an Admin can do this for an Admin', 'error');
    if (!m.username) return UI.toast('Set a username for this member first (Edit)', 'error');
    if (!UI.confirm(`Create a new recovery code for ${m.name}? Their old code will stop working.`)) return;
    const code = await Auth.newRecoveryCode(m);
    Store.touchConfig();
    showCredentials(m, null, code);
  },
  'member-del': el => {
    const m = Store.member(el.dataset.id);
    const n = Store.state.leads.filter(l => l.assignedTo === m.id).length;
    if (!UI.confirm(`Delete ${m.name}?${n ? ` Their ${n} lead(s) will become unassigned.` : ''}`)) return;
    Store.state.leads.forEach(l => { if (l.assignedTo === m.id) Actions.updateLead(l.id, { assignedTo: '' }); });
    Store.state.members = Store.state.members.filter(x => x.id !== m.id);
    Store.touchConfig(); App.renderUserSwitch(); App.render();
  },
  'member-leads': el => { Object.assign(LeadFilter, { q: '', status: '', assignee: el.dataset.id, source: '', platform: '', range: 'all', fu: '', page: 1 }); location.hash = '#/leads'; },

  /* templates */
  'tpl-edit': el => templateForm(el.dataset.id),
  'tpl-del': el => {
    if (!UI.confirm('Delete this template?')) return;
    Store.state.templates = Store.state.templates.filter(t => t.id !== el.dataset.id);
    Store.touchConfig(); App.render();
  },
  'tpl-ph': el => {
    const ta = $('#tpl-body');
    const ins = `{{${el.dataset.ph}}}`;
    const s = ta.selectionStart ?? ta.value.length, e = ta.selectionEnd ?? ta.value.length;
    ta.value = ta.value.slice(0, s) + ins + ta.value.slice(e);
    ta.focus(); ta.selectionStart = ta.selectionEnd = s + ins.length;
    InputHandlers['tpl-preview']();
  },

  /* integrations */
  'wh-test': async () => {
    const f = $('form[data-form="webhook"]');
    Forms.webhook(f, new FormData(f), true);
    if (!Store.s.webhook.url) return UI.toast('Enter the n8n webhook URL first', 'error');
    const sample = Store.state.leads[0] || Store.newLead({ name: 'Test Lead', phone: '+919876543210', email: 'test@example.com', platform: 'Instagram', campaign: 'Test Campaign' });
    const r = await Webhook.fire('test.ping', { lead: sample, message: 'Test event from Digi Help Media CRM' }, { force: true });
    UI.toast(r.ok ? 'Test sent: ' + r.info : 'Failed: ' + r.info, r.ok ? 'success' : 'error');
    App.render();
  },

  /* settings */
  'status-add': () => {
    const ed = $('#status-editor');
    ed.insertAdjacentHTML('beforeend', Views.statusRow({ name: 'New status', color: '#64748b' }, ed.children.length));
  },
  'status-del': el => el.closest('.status-row').remove(),
  'status-up': el => { const r = el.closest('.status-row'); if (r.previousElementSibling) r.parentNode.insertBefore(r, r.previousElementSibling); },
  'status-save': () => {
    const rows = $$('#status-editor .status-row').map(r => ({ name: $('.s-name', r).value.trim(), color: $('.color', r).value, closed: $('.s-closed', r).checked })).filter(x => x.name);
    if (!rows.length) return UI.toast('Keep at least one status', 'error');
    const names = rows.map(r => r.name);
    if (new Set(names).size !== names.length) return UI.toast('Status names must be unique', 'error');
    const removed = Store.statusNames().filter(n => !names.includes(n));
    const inUse = removed.filter(n => Store.state.leads.some(l => l.status === n));
    if (inUse.length && !UI.confirm(`Leads still use: ${inUse.join(', ')}. They will be moved to “${names[0]}”. Continue?`)) return;
    Store.state.leads.forEach(l => { if (inUse.includes(l.status)) Actions.updateLead(l.id, { status: names[0] }); });
    Store.s.statuses = rows;
    if (!names.includes(Store.s.wonStatus)) Store.s.wonStatus = names[names.length - 1];
    Store.touchConfig(); UI.toast('Statuses saved', 'success'); App.render();
  },
  backup: () => download(`dhm-crm-backup-${localDay(new Date())}.json`, JSON.stringify(Store.state, null, 2), 'application/json'),
  demo: () => {
    const names = ['Rahul Sharma', 'Priya Patel', 'Amit Verma', 'Sneha Iyer', 'Vikram Singh', 'Neha Gupta', 'Arjun Reddy', 'Kavya Nair', 'Rohit Mehta', 'Pooja Joshi', 'Sanjay Kumar', 'Anjali Desai'];
    const camps = ['Diwali Offer – Lead Gen', 'Website Design Leads', 'SEO Package – Nov', 'Social Media Mgmt'];
    const cities = ['Mumbai', 'Delhi', 'Pune', 'Bengaluru', 'Ahmedabad', 'Jaipur'];
    const st = Store.statusNames();
    names.forEach((n, i) => {
      const d = new Date(); d.setDate(d.getDate() - (i % 9)); d.setHours(9 + i % 8);
      const l = Store.newLead({
        id: 'L_' + stableHash('demo:' + n), name: n, phone: '+9198' + String(76543210 + i * 1111).slice(0, 8), email: n.split(' ')[0].toLowerCase() + '@example.com',
        city: cities[i % cities.length], source: i % 5 === 4 ? 'Website' : 'Meta Ads', platform: i % 5 === 4 ? 'Website' : (i % 2 ? 'Instagram' : 'Facebook'),
        campaign: camps[i % camps.length], form: 'Free Consultation Form', status: st[i % Math.min(st.length, 7)] || st[0], createdAt: d.toISOString(),
        extra: { 'what_is_your_monthly_budget?': ['₹10k–25k', '₹25k–50k', '₹50k+'][i % 3], 'business_type': ['Restaurant', 'Clinic', 'Real Estate', 'Salon'][i % 4] },
      });
      if (i % 3 === 0) { const f = new Date(); f.setDate(f.getDate() + (i % 4) - 1); l.followUp = f.toISOString(); }
      if (!Store.lead(l.id)) { Store.addActivity(l, 'system', 'Demo lead'); Store.state.leads.push(l); Store.markDirty(l); }
    });
    Store.save(); UI.toast('Demo leads added', 'success'); App.render();
  },
  reset: () => {
    if (!UI.confirm('Delete ALL leads from this browser? Download a backup first if unsure.')) return;
    if (prompt('Type DELETE to confirm') !== 'DELETE') return;
    Actions.deleteLeads(Store.state.leads.map(l => l.id)); UI.toast('All leads deleted'); App.render();
  },
};

const ChangeHandlers = {
  lf: el => { LeadFilter[el.dataset.k] = el.value; LeadFilter.page = 1; Views.leadsTable(); },
  sel: el => { el.checked ? LeadFilter.selected.add(el.dataset.id) : LeadFilter.selected.delete(el.dataset.id); el.closest('tr').classList.toggle('selected', el.checked); Views.bulkBar(); },
  'sel-all': el => { $$('input[data-chg="sel"]').forEach(c => { c.checked = el.checked; el.checked ? LeadFilter.selected.add(c.dataset.id) : LeadFilter.selected.delete(c.dataset.id); c.closest('tr').classList.toggle('selected', el.checked); }); Views.bulkBar(); },
  'row-status': el => { Actions.updateLead(el.dataset.id, { status: el.value }); el.style.setProperty('--c', Store.statusColor(el.value)); App.updateBadges(); },
  'row-assign': el => { Actions.updateLead(el.dataset.id, { assignedTo: el.value }); UI.toast('Assigned to ' + Store.memberName(el.value), 'success'); },
  'd-field': el => {
    let v = el.value.trim();
    if (el.dataset.f === 'phone') v = Phone.clean(v);
    Actions.updateLead(App.drawerLead, { [el.dataset.f]: v });
    if (['name', 'assignedTo', 'source', 'platform'].includes(el.dataset.f)) { Drawer.render(); App.refresh(); }
  },
  'd-followup': el => { Actions.updateLead(App.drawerLead, { followUp: el.value ? new Date(el.value).toISOString() : '' }); Drawer.render(); App.refresh(); },
  'auto-assign': el => { Store.s.autoAssign = el.value; Store.touchConfig(); UI.toast('Saved', 'success'); },
  'wa-mode': el => { Store.s.whatsapp.mode = el.value; Store.touchConfig(); App.render(); },
  'wa-auto': el => { Store.s.whatsapp.autoContacted = el.checked; Store.touchConfig(); },
  restore: el => {
    const file = el.files[0]; if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(r.result);
        if (!data.leads || !data.settings) throw new Error('Not a CRM backup file');
        if (!UI.confirm(`Restore backup with ${data.leads.length} leads? Current data in this browser will be replaced.`)) return;
        localStorage.setItem(DB_KEY, JSON.stringify(data));
        Store.load(); Store.state.leads.forEach(l => Store.markDirty(l)); Store.touchConfig();
        UI.toast('Backup restored', 'success'); App.renderUserSwitch(); App.go();
      } catch (e) { UI.toast('Restore failed: ' + e.message, 'error'); }
    };
    r.readAsText(file);
  },
};

const InputHandlers = {
  'lead-search': (() => { let t; return el => { clearTimeout(t); t = setTimeout(() => { LeadFilter.q = el.value; LeadFilter.page = 1; Views.leadsTable(); }, 200); }; })(),
  'tpl-preview': () => { const p = $('#tpl-preview'); if (p) p.innerHTML = esc(WhatsApp.render($('#tpl-body').value, null)).replace(/\n/g, '<br>'); },
};

/* ================================================================== Forms */
const Forms = {
  lead(f, fd) {
    const name = fd.get('name').trim(), phone = Phone.clean(fd.get('phone'));
    if (!name || (!phone && !fd.get('email').trim())) return UI.toast('Name and phone (or email) are required', 'error');
    const l = Actions.addLead({
      name, phone, email: fd.get('email').trim(), city: fd.get('city').trim(),
      source: fd.get('source'), platform: fd.get('platform'), campaign: fd.get('campaign').trim(),
      status: fd.get('status'), assignedTo: fd.get('assignedTo') || (Store.isAdmin() ? '' : Store.me().id),
    });
    if (!l) return;
    const note = fd.get('note').trim();
    if (note) Actions.addNote(l.id, note);
    UI.closeModal(); UI.toast('Lead added', 'success'); App.refresh();
  },
  async member(f, fd) {
    const id = fd.get('id');
    const data = { name: fd.get('name').trim(), role: fd.get('role'), phone: fd.get('phone').trim(), email: fd.get('email').trim(), active: !!fd.get('active'), username: Auth.normUser(fd.get('username')) };
    const pw = fd.get('password');
    if (!data.name) return UI.toast('Name is required', 'error');
    if (!/^[a-z0-9._@-]{3,40}$/.test(data.username)) return UI.toast('Username: 3–40 letters, numbers, . _ @ -', 'error');
    if (Auth.usernameTaken(data.username, id)) return UI.toast('That username is already used', 'error');
    const existing = id ? Store.member(id) : null;
    if (pw || !existing || !existing.passHash) { const err = Auth.validatePassword(pw); if (err) return UI.toast(err, 'error'); }
    if (existing && existing.role === 'Admin' && Store.me().role !== 'Admin') return UI.toast('Only an Admin can edit an Admin account', 'error');
    if (data.role === 'Admin' && Store.me().role !== 'Admin') return UI.toast('Only an Admin can create Admin accounts', 'error');
    if (existing && existing.id === Store.s.currentUser) {
      if (!data.active) return UI.toast('You cannot deactivate your own account', 'error');
      if (data.role !== 'Admin' && existing.role === 'Admin' && !Store.state.members.some(x => x.id !== existing.id && x.active && x.role === 'Admin' && x.passHash)) return UI.toast('Keep at least one active Admin', 'error');
    }
    const m = existing || { id: uid('m_') };
    Object.assign(m, data);
    if (pw) await Auth.setPassword(m, pw);
    let code = null;
    if (!m.recHash) code = await Auth.newRecoveryCode(m);
    if (!existing) Store.state.members.push(m);
    if (m.id === Store.s.currentUser) Auth.refreshSessionStamp(m);
    Store.touchConfig(); UI.closeModal(); App.renderUserSwitch(); App.go(); UI.toast('Team member saved', 'success');
    if (!existing || pw || code) showCredentials(m, pw, code);
  },
  async mypw(f, fd) {
    const me = Store.me();
    if (!(await Auth.checkPassword(me, fd.get('cur')))) return UI.toast('Current password is incorrect', 'error');
    if (fd.get('p1') !== fd.get('p2')) return UI.toast('New passwords do not match', 'error');
    const err = Auth.validatePassword(fd.get('p1')); if (err) return UI.toast(err, 'error');
    await Auth.setPassword(me, fd.get('p1'));
    Auth.refreshSessionStamp(me);
    Store.touchConfig(); UI.closeModal(); UI.toast('Password changed', 'success');
  },
  async setpw(f, fd) {
    const m = Store.member(fd.get('id'));
    if (fd.get('p1') !== fd.get('p2')) return UI.toast('Passwords do not match', 'error');
    const err = Auth.validatePassword(fd.get('p1')); if (err) return UI.toast(err, 'error');
    await Auth.setPassword(m, fd.get('p1'));
    if (m.id === Store.s.currentUser) Auth.refreshSessionStamp(m);
    Store.touchConfig(); UI.closeModal(); App.render();
    showCredentials(m, fd.get('p1'), null);
  },
  template(f, fd) {
    const id = fd.get('id');
    const data = { name: fd.get('name').trim(), category: fd.get('category').trim(), body: fd.get('body') };
    if (!data.name || !data.body.trim()) return UI.toast('Name and message are required', 'error');
    if (id) Object.assign(Store.state.templates.find(t => t.id === id), data);
    else Store.state.templates.push({ id: uid('t_'), ...data });
    Store.touchConfig(); UI.closeModal(); App.render(); UI.toast('Template saved', 'success');
  },
  sheet(f, fd) {
    const sh = Store.s.sheet;
    const url = fd.get('url').trim();
    if (url) { try { Sheets.toCsvUrl(url, ''); } catch (e) { return UI.toast(e.message, 'error'); } }
    if (url !== sh.url) { sh.lastSync = null; sh.headers = []; sh.lastResult = ''; }
    Object.assign(sh, { url, tab: fd.get('tab').trim(), defaultSource: fd.get('defaultSource'), intervalMin: Math.max(1, +fd.get('intervalMin') || 5), autoSync: !!fd.get('autoSync') });
    Store.touchConfig();
    if (url) Actions.syncSheet().then(() => App.render()); else App.render();
  },
  webhook(f, fd, quiet) {
    const w = Store.s.webhook;
    w.url = fd.get('url').trim(); w.secret = fd.get('secret').trim(); w.enabled = !!fd.get('enabled');
    Object.keys(ALL_WEBHOOK_EVENTS).forEach(k => { w.events[k] = !!fd.get('ev_' + k); });
    Store.touchConfig();
    if (!quiet) { UI.toast('Webhook settings saved', 'success'); App.render(); }
  },
  async cloud(f, fd) {
    const c = Store.s.cloud;
    c.url = fd.get('url').trim(); c.enabled = !!fd.get('enabled');
    Store.save();
    if (c.enabled && c.url) {
      UI.toast('Connecting to team database…');
      try { await Cloud.pull(); UI.toast('Team sync connected', 'success'); } catch (e) { UI.toast('Team sync failed: ' + e.message, 'error'); }
      App.renderUserSwitch();
    } else Cloud.status('off');
    App.render();
  },
  biz(f, fd) {
    const lines = v => v.split('\n').map(x => x.trim()).filter(Boolean);
    Object.assign(Store.s, { company: fd.get('company').trim() || 'Digi Help Media', countryCode: fd.get('countryCode').replace(/\D/g, ''), wonStatus: fd.get('wonStatus'), sources: lines(fd.get('sources')), platforms: lines(fd.get('platforms')) });
    Store.touchConfig(); UI.toast('Settings saved', 'success'); App.render();
  },
};

function leadForm() {
  const s = Store.s, admin = Store.isAdmin();
  const opt = (arr, cur) => arr.map(v => `<option ${v === cur ? 'selected' : ''}>${esc(v)}</option>`).join('');
  UI.modal(`
    <div class="modal-head"><h3>Add lead</h3><button class="icon-btn" data-act="modal-close">✕</button></div>
    <form data-form="lead" class="form-grid">
      <label class="field"><span>Full name *</span><input class="input" name="name" required></label>
      <label class="field"><span>Phone *</span><input class="input" name="phone" placeholder="+91 98765 43210"></label>
      <label class="field"><span>Email</span><input class="input" name="email" type="email"></label>
      <label class="field"><span>City</span><input class="input" name="city"></label>
      <label class="field"><span>Lead source</span><select class="input" name="source">${opt(s.sources, s.sources[0])}</select></label>
      <label class="field"><span>Platform</span><select class="input" name="platform"><option value="">—</option>${opt(s.platforms)}</select></label>
      <label class="field"><span>Campaign</span><input class="input" name="campaign"></label>
      <label class="field"><span>Status</span><select class="input" name="status">${opt(Store.statusNames(), Store.statusNames()[0])}</select></label>
      ${admin ? `<label class="field span-2"><span>Assign to</span><select class="input" name="assignedTo"><option value="">— Unassigned${s.autoAssign === 'roundrobin' ? ' (auto round-robin)' : ''} —</option>${Store.state.members.filter(m => m.active).map(m => `<option value="${esc(m.id)}">${esc(m.name)} (${esc(m.role)})</option>`).join('')}</select></label>` : '<input type="hidden" name="assignedTo" value="">'}
      <label class="field span-2"><span>Note</span><textarea class="input" name="note" rows="2"></textarea></label>
      <div class="span-2 modal-foot"><button type="button" class="btn btn-ghost" data-act="modal-close">Cancel</button><button class="btn btn-primary">Add lead</button></div>
    </form>`);
}

/* shows login details to hand over to a team member (password/code shown once) */
function showCredentials(m, pw, code) {
  const url = location.protocol.startsWith('http') ? location.origin + location.pathname : '';
  const text = [`${Store.s.company} CRM login`, url && `Link: ${url}`, `Username: ${m.username}`, pw && `Password: ${pw}`, code && `Recovery code (for "Forgot password"): ${code}`].filter(Boolean).join('\n');
  UI.modal(`
    <div class="modal-head"><h3>🔐 Login details — ${esc(m.name)}</h3><button class="icon-btn" data-act="modal-close">✕</button></div>
    <p class="muted small">Share these with ${esc(m.name)}. ${code ? '<b>The recovery code is shown only once</b> — it lets them reset their password from the “Forgot password?” link on the sign-in page.' : ''}</p>
    <div class="cred-box">
      ${url ? `<div><span>Link</span><code>${esc(url)}</code></div>` : ''}
      <div><span>Username / ID</span><code>${esc(m.username)}</code></div>
      ${pw ? `<div><span>Password</span><code>${esc(pw)}</code></div>` : ''}
      ${code ? `<div><span>Recovery code</span><code class="big">${esc(code)}</code></div>` : ''}
    </div>
    <div class="modal-foot">
      ${m.phone ? `<a class="btn btn-wa" target="_blank" rel="noopener" href="${esc(WhatsApp.link(m.phone, text))}">💬 Send on WhatsApp</a>` : ''}
      <button class="btn" data-act="copy-text" data-text="${esc(text)}">Copy</button>
      <button class="btn btn-primary" data-act="modal-close">Done</button>
    </div>`);
}

function memberForm(id) {
  const m = id ? Store.member(id) : { name: '', role: 'Telecaller', phone: '', email: '', active: true };
  UI.modal(`
    <div class="modal-head"><h3>${id ? 'Edit' : 'Add'} team member</h3><button class="icon-btn" data-act="modal-close">✕</button></div>
    <form data-form="member" class="form-grid">
      <input type="hidden" name="id" value="${esc(id || '')}">
      <label class="field"><span>Name *</span><input class="input" name="name" value="${esc(m.name)}" required></label>
      <label class="field"><span>Role</span><select class="input" name="role">${['Telecaller', 'Manager', 'Admin'].map(r => `<option ${r === m.role ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
      <label class="field"><span>Phone / WhatsApp</span><input class="input" name="phone" value="${esc(m.phone)}"></label>
      <label class="field"><span>Email</span><input class="input" name="email" type="email" value="${esc(m.email)}"></label>
      <label class="field"><span>Username / login ID *</span><input class="input" name="username" value="${esc(m.username || '')}" autocomplete="off" required minlength="3" maxlength="40"></label>
      <label class="field"><span>${id && m.passHash ? 'New password <em class="muted">(leave blank to keep current)</em>' : 'Password *'}</span><input class="input" name="password" type="text" autocomplete="new-password" minlength="6" ${id && m.passHash ? '' : 'required'}></label>
      <label class="check span-2"><input type="checkbox" name="active" ${m.active ? 'checked' : ''}> Active (receives new leads in round-robin)</label>
      <div class="span-2 modal-foot"><button type="button" class="btn btn-ghost" data-act="modal-close">Cancel</button><button class="btn btn-primary">Save</button></div>
    </form>`);
}

function templateForm(id) {
  const t = id ? Store.state.templates.find(x => x.id === id) : { name: '', category: '', body: 'Hi {{first_name}}, ' };
  UI.modal(`
    <div class="modal-head"><h3>${id ? 'Edit' : 'New'} WhatsApp template</h3><button class="icon-btn" data-act="modal-close">✕</button></div>
    <form data-form="template" class="tpl-form">
      <input type="hidden" name="id" value="${esc(id || '')}">
      <div class="form-grid">
        <label class="field"><span>Template name *</span><input class="input" name="name" value="${esc(t.name)}" required></label>
        <label class="field"><span>Category</span><input class="input" name="category" value="${esc(t.category)}" placeholder="Intro, Follow-up, Offer…"></label>
      </div>
      <div class="tpl-two">
        <div>
          <div class="field-label">Message — click a variable to insert it. Use *bold* and _italic_ like WhatsApp.</div>
          <div class="chips">${WhatsApp.PLACEHOLDERS.map(p => `<button type="button" class="chip btn-chip" data-act="tpl-ph" data-ph="${p}">{{${p}}}</button>`).join('')}</div>
          <textarea class="input" id="tpl-body" name="body" rows="12" data-inp="tpl-preview">${esc(t.body)}</textarea>
        </div>
        <div><div class="field-label">Preview (sample lead)</div><div class="wa-screen"><div class="wa-bubble" id="tpl-preview">${esc(WhatsApp.render(t.body, null)).replace(/\n/g, '<br>')}</div></div></div>
      </div>
      <div class="modal-foot"><button type="button" class="btn btn-ghost" data-act="modal-close">Cancel</button><button class="btn btn-primary">Save template</button></div>
    </form>`, { wide: true });
}

/* ================================================================= Export */
function download(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function exportCSV(leads, name) {
  if (!leads.length) return UI.toast('No leads to export', 'error');
  const extraKeys = [...new Set(leads.flatMap(l => Object.keys(l.extra || {})))];
  const head = ['Lead ID', 'Meta Lead ID', 'Name', 'Phone', 'Email', 'City', 'Status', 'Assigned To', 'Source', 'Platform', 'Campaign', 'Ad Set', 'Ad', 'Form', 'Follow-up', 'Deal Value', 'Received', 'Last Updated', 'Last Note', ...extraKeys];
  const rows = leads.map(l => {
    const note = (l.activity || []).find(a => a.type === 'note');
    return [l.id, l.metaId, l.name, l.phone, l.email, l.city, l.status, Store.memberName(l.assignedTo), l.source, l.platform, l.campaign, l.adset, l.ad, l.form,
      l.followUp ? fmtDT(l.followUp) : '', l.value, fmtDT(l.createdAt), fmtDT(l.updatedAt), note ? note.text : '', ...extraKeys.map(k => (l.extra || {})[k] || '')];
  });
  download(`${name}-${localDay(new Date())}.csv`, '﻿' + toCSV([head, ...rows]), 'text/csv;charset=utf-8');
}

document.addEventListener('DOMContentLoaded', () => App.init());
