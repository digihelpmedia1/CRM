/* =========================================================================
   Digi Help Media CRM — Data store
   All data lives in localStorage (per browser). Optional Team Cloud Sync
   (Google Apps Script) shares leads + config between team members.
   ========================================================================= */

const DB_KEY = 'dhm_crm_v1';

const uid = (p = '') => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* Deterministic id so the same Meta lead imported on two machines gets the same id */
function stableHash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

const ALL_WEBHOOK_EVENTS = {
  'lead.created': 'New lead added (sheet sync or manual)',
  'lead.assigned': 'Lead assigned / re-assigned to a team member',
  'lead.status_changed': 'Lead status changed',
  'lead.updated': 'Lead details edited',
  'lead.note_added': 'Note / call remark added',
  'lead.followup_set': 'Follow-up date set',
  'whatsapp.sent': 'WhatsApp message sent by telecaller',
  'lead.deleted': 'Lead deleted',
};

function defaultState() {
  return {
    version: 1,
    leads: [],
    members: [
      { id: 'm_admin', name: 'Digi Help Media Admin', role: 'Admin', phone: '', email: '', active: true, ...DEFAULT_ADMIN_AUTH },
    ],
    templates: [
      {
        id: 't_intro', name: 'Introduction (first contact)', category: 'Intro',
        body: 'Hi {{first_name}} 👋\n\nThis is {{agent}} from *{{company}}*. Thank you for your interest in our services via our ad.\n\nWhen would be a good time for a quick call to understand your requirement?',
      },
      {
        id: 't_nopick', name: 'Call not picked', category: 'Follow-up',
        body: 'Hi {{first_name}}, I tried calling you just now regarding your enquiry with {{company}} but couldn\'t reach you.\n\nPlease let me know a convenient time to call back. 🙏\n\n— {{agent}}\n📞 {{agent_phone}}',
      },
      {
        id: 't_follow', name: 'Follow-up reminder', category: 'Follow-up',
        body: 'Hi {{first_name}}, just following up on our last conversation. Do you have any questions I can help with?\n\n— {{agent}}, {{company}}',
      },
      {
        id: 't_thanks', name: 'Thank you / Onboarded', category: 'Closing',
        body: 'Hi {{first_name}}, welcome aboard! 🎉 Thank you for choosing *{{company}}*. Our team will reach out shortly with the next steps.',
      },
    ],
    settings: {
      company: 'Digi Help Media',
      countryCode: '91',
      currentUser: 'm_admin',
      statuses: [
        { name: 'New', color: '#3b82f6' },
        { name: 'Contacted', color: '#8b5cf6' },
        { name: 'Not Picked', color: '#f59e0b' },
        { name: 'Interested', color: '#10b981' },
        { name: 'Follow-up', color: '#06b6d4' },
        { name: 'Meeting Scheduled', color: '#6366f1' },
        { name: 'Converted', color: '#16a34a', closed: true },
        { name: 'Not Interested', color: '#ef4444', closed: true },
        { name: 'Invalid / Junk', color: '#6b7280', closed: true },
      ],
      wonStatus: 'Converted',
      sources: ['Meta Ads', 'Google Ads', 'Website', 'Referral', 'Organic', 'Walk-in', 'Other'],
      platforms: ['Facebook', 'Instagram', 'Messenger', 'WhatsApp', 'Audience Network', 'Google', 'Website', 'Other'],
      sheet: { url: '', tab: '', autoSync: true, intervalMin: 5, lastSync: null, lastResult: '', defaultSource: 'Meta Ads', headers: [] },
      autoAssign: 'off', // off | roundrobin
      rrIndex: 0,
      whatsapp: { mode: 'wame', autoContacted: true }, // wame | n8n
      webhook: { url: '', secret: '', enabled: false, events: Object.fromEntries(Object.keys(ALL_WEBHOOK_EVENTS).map(k => [k, true])) },
      cloud: { url: '', enabled: false, lastSync: null, lastResult: '' },
      configUpdatedAt: 0,
    },
    webhookLog: [],
  };
}

const Store = {
  state: null,
  listeners: [],

  load() {
    const def = defaultState();
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(DB_KEY) || 'null'); } catch (e) { saved = null; }
    if (!saved) { this.state = def; this.save(); return; }
    // shallow-merge defaults so new settings keys appear after upgrades
    saved.settings = Object.assign({}, def.settings, saved.settings || {});
    ['sheet', 'whatsapp', 'webhook', 'cloud'].forEach(k => {
      saved.settings[k] = Object.assign({}, def.settings[k], saved.settings[k] || {});
    });
    saved.settings.webhook.events = Object.assign({}, def.settings.webhook.events, saved.settings.webhook.events || {});
    saved.leads = saved.leads || [];
    saved.members = saved.members && saved.members.length ? saved.members : def.members;
    // first run of the login system: give the built-in admin its default credentials
    if (!saved.members.some(m => m.passHash)) {
      const adm = saved.members.find(m => m.id === 'm_admin') || saved.members.find(m => m.role === 'Admin');
      if (adm) Object.assign(adm, DEFAULT_ADMIN_AUTH, { active: true, role: 'Admin' });
      else saved.members.unshift(def.members[0]);
      saved.settings.configUpdatedAt = Date.now(); // make the credentials win over older team-sync config
    }
    saved.templates = saved.templates || def.templates;
    saved.webhookLog = saved.webhookLog || [];
    this.state = saved;
  },

  save() {
    try {
      localStorage.setItem(DB_KEY, JSON.stringify(this.state));
    } catch (e) {
      console.error(e);
      alert('Could not save data — browser storage may be full. Export a backup from Settings.');
    }
  },

  /* mark shared config (team, templates, statuses...) as changed → cloud push */
  touchConfig() {
    this.state.settings.configUpdatedAt = Date.now();
    this.save();
    if (window.Cloud) Cloud.pushConfigSoon();
  },

  get s() { return this.state.settings; },

  /* ---------- members ---------- */
  member(id) { return this.state.members.find(m => m.id === id); },
  memberName(id) { const m = this.member(id); return m ? m.name : 'Unassigned'; },
  me() { return this.member(this.s.currentUser) || this.state.members[0]; },
  isAdmin() { const m = this.me(); return !!m && (m.role === 'Admin' || m.role === 'Manager'); },
  activeCallers() { return this.state.members.filter(m => m.active && m.role === 'Telecaller'); },

  /* ---------- statuses ---------- */
  statusNames() { return this.s.statuses.map(s => s.name); },
  statusColor(name) { const s = this.s.statuses.find(x => x.name === name); return s ? s.color : '#6b7280'; },

  /* ---------- leads ---------- */
  lead(id) { return this.state.leads.find(l => l.id === id); },

  /* Leads visible to the current user (telecallers only see their own) */
  visibleLeads() {
    if (this.isAdmin()) return this.state.leads;
    const me = this.me();
    return this.state.leads.filter(l => l.assignedTo === me.id);
  },

  newLead(data) {
    const now = new Date().toISOString();
    return Object.assign({
      id: uid('L_'), metaId: '', name: '', phone: '', email: '', city: '',
      source: 'Meta Ads', platform: '', campaign: '', adset: '', ad: '', form: '',
      status: this.s.statuses[0] ? this.s.statuses[0].name : 'New',
      assignedTo: '', followUp: '', value: '', notes: [], activity: [], extra: {},
      createdAt: now, updatedAt: now, lastContactAt: '',
    }, data);
  },

  addActivity(lead, type, text) {
    lead.activity = lead.activity || [];
    lead.activity.unshift({ id: uid('a_'), type, text, by: this.me() ? this.me().name : 'System', at: new Date().toISOString() });
    if (lead.activity.length > 100) lead.activity.length = 100; // keeps each lead under the 50k-char Sheets cell limit
  },

  markDirty(lead) {
    lead.updatedAt = new Date().toISOString();
    if (window.Cloud) Cloud.queueLead(lead.id);
  },

  /* round-robin pick of next active telecaller */
  nextAssignee() {
    const callers = this.activeCallers();
    if (!callers.length) return '';
    const idx = (this.s.rrIndex || 0) % callers.length;
    this.s.rrIndex = idx + 1;
    return callers[idx].id;
  },
};
