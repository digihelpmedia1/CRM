/* =========================================================================
   Integrations: Google Sheets import, n8n webhooks, WhatsApp, Team Cloud Sync
   ========================================================================= */

/* ------------------------------------------------------------------ CSV */
function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => String(x).trim() !== ''));
}

function toCSV(rows) {
  return rows.map(r => r.map(v => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\r\n');
}

/* --------------------------------------------------------------- Phones */
const Phone = {
  clean(raw) {
    if (!raw) return '';
    let s = String(raw).trim().replace(/^p:/i, '');
    const plus = s.startsWith('+');
    s = s.replace(/\D/g, '');
    return (plus ? '+' : '') + s;
  },
  last10(raw) { const d = String(raw || '').replace(/\D/g, ''); return d.slice(-10); },
  /* international digits for wa.me / tel: */
  intl(raw) {
    let d = String(raw || '').replace(/\D/g, '');
    if (!d) return '';
    const cc = String(Store.s.countryCode || '').replace(/\D/g, '');
    if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
    if (d.length === 10 && cc) d = cc + d;
    return d;
  },
};

/* --------------------------------------------------------- Google Sheets */
const Sheets = {
  FIELD_MAP: {
    metaId: ['id', 'leadid', 'metaleadid', 'fbleadid'],
    name: ['fullname', 'name', 'leadname', 'customername', 'yourname', 'clientname'],
    firstName: ['firstname'],
    lastName: ['lastname', 'surname'],
    phone: ['phonenumber', 'phone', 'mobile', 'mobilenumber', 'mobileno', 'contactnumber', 'contactno', 'whatsappnumber', 'whatsapp', 'phoneno', 'contact'],
    email: ['email', 'emailaddress', 'emailid', 'workemail'],
    city: ['city', 'location', 'yourcity', 'town'],
    created: ['createdtime', 'createdat', 'date', 'timestamp', 'leaddate', 'created', 'submittedat'],
    platform: ['platform'],
    source: ['source', 'leadsource'],
    campaign: ['campaignname', 'campaign'],
    adset: ['adsetname', 'adset'],
    ad: ['adname', 'ad'],
    form: ['formname', 'form'],
  },

  norm(h) { return String(h || '').toLowerCase().replace(/[^a-z0-9]/g, ''); },

  /* Turn any Google Sheets link into a CSV endpoint */
  toCsvUrl(url, tab) {
    url = (url || '').trim();
    if (!url) throw new Error('Please enter the Google Sheet URL');
    // "Publish to web" links
    if (/\/spreadsheets\/d\/e\//.test(url)) {
      let u = url.replace(/\/pubhtml.*$/, '/pub').replace(/\/pub\?.*$/, '/pub');
      if (!/\/pub$/.test(u)) u = u.replace(/\/[^/]*$/, '/pub');
      const gid = (url.match(/[#&?]gid=(\d+)/) || [])[1];
      return u + '?output=csv' + (gid ? '&gid=' + gid : '');
    }
    if (/output=csv|format=csv|tqx=out:csv/.test(url)) return url;
    const id = this.sheetId(url);
    if (!id) throw new Error('This does not look like a Google Sheets link');
    const gid = (url.match(/[#&?]gid=(\d+)/) || [])[1];
    let q = `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&headers=1`;
    if (tab) q += '&sheet=' + encodeURIComponent(tab);
    else if (gid) q += '&gid=' + gid;
    return q;
  },

  sheetId(url) { const m = String(url).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]{20,})/); return m ? m[1] : ''; },

  async fetchRows(url, tab) {
    const csvUrl = this.toCsvUrl(url, tab);
    try {
      const res = await fetch(csvUrl, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      if (/^\s*<(!doctype|html)/i.test(text)) throw new Error('Sheet is not shared publicly');
      return parseCSV(text);
    } catch (err) {
      // Fallback: JSONP through the gviz endpoint (works even when fetch is blocked by CORS)
      if (this.sheetId(url)) {
        try { return await this.jsonp(url, tab); } catch (e2) { /* fall through */ }
      }
      throw new Error('Could not read the sheet. In Google Sheets click Share → "Anyone with the link" → Viewer. (' + err.message + ')');
    }
  },

  jsonp(url, tab) {
    return new Promise((resolve, reject) => {
      const id = this.sheetId(url);
      const gid = (url.match(/[#&?]gid=(\d+)/) || [])[1];
      const cb = '__dhm_gviz_' + Date.now();
      const s = document.createElement('script');
      const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, 15000);
      function cleanup() { clearTimeout(timer); delete window[cb]; s.remove(); }
      window[cb] = (resp) => {
        cleanup();
        if (!resp || resp.status === 'error' || !resp.table) return reject(new Error('gviz error'));
        const cols = resp.table.cols;
        const header = cols.map(c => c.label || c.id);
        const rows = (resp.table.rows || []).map(r => (r.c || []).map((c, i) => {
          if (!c) return '';
          const t = cols[i] && cols[i].type;
          if (t === 'date' || t === 'datetime') return c.f || '';
          if (typeof c.v === 'number') return String(c.v);
          return c.v != null ? String(c.v) : (c.f || '');
        }));
        resolve([header, ...rows]);
      };
      let src = `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?headers=1&tqx=out:json;responseHandler:${cb}`;
      if (tab) src += '&sheet=' + encodeURIComponent(tab); else if (gid) src += '&gid=' + gid;
      s.src = src;
      s.onerror = () => { cleanup(); reject(new Error('network')); };
      document.head.appendChild(s);
    });
  },

  buildMap(header) {
    const normed = header.map(h => this.norm(h));
    const map = {};
    const used = new Set();
    for (const [field, keys] of Object.entries(this.FIELD_MAP)) {
      const idx = normed.findIndex((h, i) => !used.has(i) && keys.includes(h));
      if (idx >= 0) { map[field] = idx; used.add(idx); }
    }
    // fuzzy fallbacks
    const fuzzy = (field, test) => {
      if (map[field] != null) return;
      const idx = normed.findIndex((h, i) => !used.has(i) && test(h));
      if (idx >= 0) { map[field] = idx; used.add(idx); }
    };
    fuzzy('phone', h => /phone|mobile|whatsapp|contact/.test(h));
    fuzzy('email', h => /email/.test(h));
    fuzzy('name', h => /name/.test(h) && !/campaign|adset|ad|form|company|business/.test(h));
    map._used = used;
    return map;
  },

  platformLabel(p) {
    const v = String(p || '').trim().toLowerCase();
    if (!v) return '';
    if (['fb', 'facebook'].includes(v)) return 'Facebook';
    if (['ig', 'instagram'].includes(v)) return 'Instagram';
    if (['msg', 'messenger'].includes(v)) return 'Messenger';
    if (['an', 'audience_network', 'audience network'].includes(v)) return 'Audience Network';
    if (['wa', 'whatsapp'].includes(v)) return 'WhatsApp';
    return v.charAt(0).toUpperCase() + v.slice(1);
  },

  parseDate(v) {
    if (!v) return '';
    const d = new Date(v);
    return isNaN(d) ? '' : d.toISOString();
  },

  /* Pull the sheet and merge new leads. Returns summary. */
  async sync({ silent = false } = {}) {
    const cfg = Store.s.sheet;
    if (!cfg.url) throw new Error('No Google Sheet URL configured (Integrations → Google Sheet)');
    const rows = await this.fetchRows(cfg.url, cfg.tab);
    if (rows.length < 1) throw new Error('Sheet is empty');
    const header = rows[0].map(h => String(h).trim());
    const map = this.buildMap(header);
    if (map.phone == null && map.email == null) throw new Error('Could not find a phone or email column in the sheet. Headers found: ' + header.join(', '));

    const byId = new Map(Store.state.leads.map(l => [l.id, l]));
    const byPhone = new Map();
    Store.state.leads.forEach(l => { const p = Phone.last10(l.phone); if (p) byPhone.set(p, l); });

    let added = 0, dup = 0, skipped = 0;
    const created = [];
    const get = (r, f) => (map[f] != null ? String(r[map[f]] ?? '').trim() : '');

    for (const r of rows.slice(1)) {
      let name = get(r, 'name');
      if (!name) name = [get(r, 'firstName'), get(r, 'lastName')].filter(Boolean).join(' ');
      const phone = Phone.clean(get(r, 'phone'));
      const email = get(r, 'email');
      if (!phone && !email) { skipped++; continue; }

      const metaId = get(r, 'metaId').replace(/^l:/i, '');
      const key = metaId ? 'meta:' + metaId : (phone ? 'ph:' + Phone.last10(phone) : 'em:' + email.toLowerCase());
      const id = 'L_' + stableHash(key);
      if (byId.has(id) || (phone && byPhone.has(Phone.last10(phone)))) { dup++; continue; }

      const extra = {};
      header.forEach((h, i) => { if (!map._used.has(i) && h && r[i] !== undefined && String(r[i]).trim() !== '') extra[h] = String(r[i]).trim(); });

      const platform = this.platformLabel(get(r, 'platform'));
      const lead = Store.newLead({
        id, metaId, name: name || '(No name)', phone, email,
        city: get(r, 'city'),
        source: get(r, 'source') || cfg.defaultSource || 'Meta Ads',
        platform, campaign: get(r, 'campaign'), adset: get(r, 'adset'), ad: get(r, 'ad'), form: get(r, 'form'),
        extra,
        createdAt: this.parseDate(get(r, 'created')) || new Date().toISOString(),
      });
      Store.addActivity(lead, 'system', 'Lead imported from Google Sheet');
      if (Store.s.autoAssign === 'roundrobin') {
        const a = Store.nextAssignee();
        if (a) { lead.assignedTo = a; Store.addActivity(lead, 'assign', 'Auto-assigned to ' + Store.memberName(a)); }
      }
      Store.markDirty(lead);
      Store.state.leads.push(lead);
      byId.set(id, lead);
      if (phone) byPhone.set(Phone.last10(phone), lead);
      created.push(lead);
      added++;
    }

    cfg.lastSync = new Date().toISOString();
    cfg.headers = header;
    cfg.lastResult = `${added} new, ${dup} already in CRM, ${skipped} skipped (no phone/email)`;
    Store.save();

    // fire webhooks after save
    created.forEach(l => {
      Webhook.fire('lead.created', { lead: l });
      if (l.assignedTo) Webhook.fire('lead.assigned', { lead: l, assignedTo: Store.member(l.assignedTo) });
    });
    return { added, dup, skipped, total: rows.length - 1 };
  },
};

/* ------------------------------------------------------------ n8n Webhook */
const Webhook = {
  leadPayload(l) {
    if (!l) return null;
    const a = Store.member(l.assignedTo);
    return {
      id: l.id, metaId: l.metaId, name: l.name, phone: l.phone, phoneIntl: Phone.intl(l.phone), email: l.email, city: l.city,
      source: l.source, platform: l.platform, campaign: l.campaign, adset: l.adset, ad: l.ad, form: l.form,
      status: l.status, followUp: l.followUp, value: l.value,
      assignedTo: a ? { id: a.id, name: a.name, phone: a.phone, email: a.email } : null,
      createdAt: l.createdAt, updatedAt: l.updatedAt, extra: l.extra,
    };
  },

  async fire(event, data = {}, { force = false } = {}) {
    const w = Store.s.webhook;
    if (!w.url || (!force && (!w.enabled || !w.events[event]))) return { skipped: true };
    const me = Store.me();
    const body = {
      event,
      timestamp: new Date().toISOString(),
      company: Store.s.company,
      actor: me ? { id: me.id, name: me.name, role: me.role } : null,
      ...data,
      lead: data.lead ? this.leadPayload(data.lead) : undefined,
    };
    const headers = { 'Content-Type': 'application/json' };
    if (w.secret) headers['X-CRM-Secret'] = w.secret;
    let ok = false, info = '';
    try {
      const res = await fetch(w.url, { method: 'POST', headers, body: JSON.stringify(body) });
      ok = res.ok; info = 'HTTP ' + res.status;
    } catch (e) {
      // CORS blocked (n8n "Allowed Origins" not set) → fire-and-forget without reading the response
      try {
        await fetch(w.url, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) });
        ok = true; info = 'sent (no-cors, response not readable)';
      } catch (e2) { ok = false; info = e2.message; }
    }
    Store.state.webhookLog.unshift({ at: body.timestamp, event, ok, info, lead: data.lead ? data.lead.name : '' });
    Store.state.webhookLog.length = Math.min(Store.state.webhookLog.length, 50);
    Store.save();
    return { ok, info };
  },
};

/* --------------------------------------------------------------- WhatsApp */
const WhatsApp = {
  PLACEHOLDERS: ['name', 'first_name', 'phone', 'email', 'city', 'campaign', 'platform', 'status', 'agent', 'agent_phone', 'company'],

  render(body, lead) {
    // the agent is whoever is sending the message (logged-in user)
    const agent = Store.me() || {};
    const vals = {
      name: lead ? lead.name : 'Rahul Sharma',
      first_name: lead ? String(lead.name || '').split(' ')[0] : 'Rahul',
      phone: lead ? lead.phone : '+919876543210',
      email: lead ? lead.email : 'rahul@example.com',
      city: lead ? lead.city : 'Mumbai',
      campaign: lead ? lead.campaign : 'Lead Gen Campaign',
      platform: lead ? lead.platform : 'Instagram',
      status: lead ? lead.status : 'New',
      agent: agent.name || '',
      agent_phone: agent.phone || '',
      company: Store.s.company,
    };
    return String(body || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in vals ? (vals[k] || '') : m));
  },

  link(phone, text) {
    return `https://wa.me/${Phone.intl(phone)}?text=${encodeURIComponent(text)}`;
  },
};

/* ------------------------------------------------ Team Cloud Sync (Apps Script) */
const Cloud = {
  dirty: new Set(),
  timer: null,
  cfgTimer: null,
  busy: false,

  enabled() { const c = Store.s.cloud; return !!(c.enabled && c.url); },

  sharedConfig() {
    const s = Store.s;
    return {
      updatedAt: s.configUpdatedAt || 0,
      members: Store.state.members,
      templates: Store.state.templates,
      settings: {
        company: s.company, countryCode: s.countryCode, statuses: s.statuses, wonStatus: s.wonStatus,
        sources: s.sources, platforms: s.platforms, autoAssign: s.autoAssign, whatsapp: s.whatsapp,
        webhook: s.webhook, sheet: { url: s.sheet.url, tab: s.sheet.tab, defaultSource: s.sheet.defaultSource, autoSync: s.sheet.autoSync, intervalMin: s.sheet.intervalMin },
      },
    };
  },

  queueLead(id) {
    if (!this.enabled()) return;
    this.dirty.add(id);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.pushLeads(), 1500);
  },

  pushConfigSoon() {
    if (!this.enabled()) return;
    clearTimeout(this.cfgTimer);
    this.cfgTimer = setTimeout(() => this.post({ action: 'saveConfig', config: this.sharedConfig() }).catch(e => this.status('error: ' + e.message)), 1500);
  },

  async post(payload) {
    const res = await fetch(Store.s.cloud.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'Cloud error');
    return json;
  },

  async pushLeads() {
    if (!this.enabled() || !this.dirty.size) return;
    const ids = [...this.dirty]; this.dirty.clear();
    const leads = ids.map(id => Store.lead(id)).filter(Boolean);
    const deleted = ids.filter(id => !Store.lead(id));
    try {
      for (let i = 0; i < leads.length; i += 200) await this.post({ action: 'upsertLeads', leads: leads.slice(i, i + 200) });
      if (deleted.length) await this.post({ action: 'deleteLeads', ids: deleted });
      this.status('synced ' + new Date().toLocaleTimeString());
    } catch (e) {
      ids.forEach(id => this.dirty.add(id)); // retry later
      this.status('error: ' + e.message);
    }
  },

  async pull() {
    if (!this.enabled() || this.busy) return null;
    this.busy = true;
    try {
      const url = Store.s.cloud.url + (Store.s.cloud.url.includes('?') ? '&' : '?') + 'action=pull&t=' + Date.now();
      const res = await fetch(url);
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || 'Cloud error');
      let changed = 0;
      const local = new Map(Store.state.leads.map(l => [l.id, l]));
      const remoteIds = new Set();
      (json.leads || []).forEach(r => {
        remoteIds.add(r.id);
        const l = local.get(r.id);
        if (!l) { if (!this.dirty.has(r.id)) { Store.state.leads.push(r); changed++; } }
        else if (new Date(r.updatedAt) > new Date(l.updatedAt) && !this.dirty.has(r.id)) {
          Object.assign(l, r); changed++;
        }
      });
      // local leads never pushed (e.g. created before cloud was enabled) → push them
      Store.state.leads.forEach(l => { if (!remoteIds.has(l.id)) this.dirty.add(l.id); });
      (json.deleted || []).forEach(id => {
        const i = Store.state.leads.findIndex(l => l.id === id);
        if (i >= 0) { Store.state.leads.splice(i, 1); changed++; }
      });
      if (json.config && json.config.updatedAt > (Store.s.configUpdatedAt || 0)) {
        const c = json.config;
        if (c.members) {
          // never let an older config without logins wipe out local credentials
          if (!c.members.some(m => m.passHash)) {
            c.members.forEach(m => { const loc = Store.member(m.id); if (loc) ['username', 'salt', 'passHash', 'recHash', 'passwordChangedAt'].forEach(k => { if (loc[k]) m[k] = loc[k]; }); });
          }
          if (c.members.some(m => m.passHash && m.active && m.role === 'Admin')) Store.state.members = c.members;
        }
        if (c.templates) Store.state.templates = c.templates;
        if (c.settings) {
          const { sheet, ...rest } = c.settings;
          Object.assign(Store.s, rest);
          if (sheet) Object.assign(Store.s.sheet, sheet);
        }
        Store.s.configUpdatedAt = c.updatedAt;
        changed++;
      } else if (!json.config || json.config.updatedAt < (Store.s.configUpdatedAt || 0)) {
        this.pushConfigSoon();
      }
      Store.s.cloud.lastSync = new Date().toISOString();
      Store.save();
      if (this.dirty.size) this.pushLeads();
      this.status('synced ' + new Date().toLocaleTimeString());
      return changed;
    } catch (e) {
      this.status('error: ' + e.message);
      throw e;
    } finally { this.busy = false; }
  },

  status(t) {
    Store.s.cloud.lastResult = t;
    const el = document.getElementById('cloud-pill');
    if (el) { el.textContent = 'Team sync: ' + t; el.classList.toggle('err', /^error/.test(t)); el.classList.toggle('ok', !/^error/.test(t)); }
  },
};
