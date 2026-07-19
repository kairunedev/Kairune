'use strict';
// Kairune Console — dashboard logic (vanilla JS, no build step).
const API = '/api';
let state = { agents: [], selectedId: null, meta: null, holderWallet: '' };

// ---- tiny helpers ----
const $ = (sel, root) => (root || document).querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

async function api(path, opts) {
  const headers = { 'Content-Type': 'application/json' };
  const wallet = (state.holderWallet || '').trim();
  if (wallet) headers['X-Kairune-Wallet'] = wallet;
  const res = await fetch(API + path, Object.assign({
    headers,
  }, opts || {}));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

function toast(msg, kind) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + (kind || 'ok');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 3200);
}

function setConn(ok) {
  const c = $('#conn');
  c.className = 'conn ' + (ok ? 'ok' : 'err');
  c.innerHTML = '<i></i> ' + (ok ? 'live' : 'offline');
}

function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}
// ---- rendering: stats ----
async function loadStats() {
  const s = await api('/stats');
  $('#stAgents').textContent = s.total_agents;
  $('#stAtt').textContent = s.total_attestations;
  $('#stPerms').textContent = s.active_permissions;
  const spendEl = $('#stSpend');
  if (spendEl) spendEl.textContent = '$' + (s.total_spend != null ? s.total_spend : 0);
  $('#stAvg').textContent = s.avg_score;
}

// ---- rendering: agent list ----
function tierClass(t) { return 'tierpill tier-' + t; }

async function loadAgents() {
  const { agents } = await api('/agents');
  state.agents = agents;
  renderAgentList();
}

function renderAgentList() {
  const list = $('#agentList');
  list.innerHTML = '';
  const q = (($('#agentSearch') && $('#agentSearch').value) || '').trim().toLowerCase();
  const agents = !q
    ? state.agents
    : state.agents.filter((a) =>
        a.handle.toLowerCase().includes(q) ||
        (a.wallet || '').toLowerCase().includes(q) ||
        (a.operator || '').toLowerCase().includes(q)
      );
  if (!state.agents.length) {
    list.appendChild(el('div', 'empty', 'No agents yet. Register one to begin.'));
    return;
  }
  if (!agents.length) {
    list.appendChild(el('div', 'empty', 'No agents match “' + q + '”'));
    return;
  }
  agents.forEach((a) => {
    const row = el('div', 'agent-row' + (a.id === state.selectedId ? ' active' : ''));
    row.innerHTML =
      '<div class="agent-score">' + a.score + '</div>' +
      '<div class="agent-meta"><div class="h">' + a.handle + '</div>' +
      '<div class="w">' + a.wallet.slice(0, 10) + '…' + a.wallet.slice(-4) + '</div></div>' +
      '<div class="' + tierClass(a.tier) + '">T' + a.tier + '</div>';
    row.addEventListener('click', () => selectAgent(a.id));
    list.appendChild(row);
  });
}
// ---- rendering: detail panel ----
const CIRC = 2 * Math.PI * 53;

async function selectAgent(id) {
  state.selectedId = id;
  renderAgentList();
  const data = await api('/agents/' + id);
  renderDetail(data);
}

function renderDetail(data) {
  const a = data.agent;
  $('#detailEmpty').hidden = true;
  const body = $('#detailBody');
  body.hidden = false;

  const pct = a.score / (state.meta ? state.meta.max_score : 1000);
  const offset = CIRC * (1 - pct);
  const bd = a.breakdown || {};

  let html = '';
  html += '<div class="detail-inner">';
  html += '<div class="detail-top"><div>';
  html += '<p class="h">' + a.handle + '</p>';
  html += '<p class="w">' + a.wallet + '</p>';
  if (a.operator) html += '<p class="op">operator · ' + a.operator + '</p>';
  html += '<button type="button" class="share-btn" id="shareAgent" data-handle="' + a.handle + '">copy share link</button>';
  html += '</div><div class="' + tierClass(a.tier) + '">' + (a.label || '') + '</div></div>';

  // score hero ring
  html += '<div class="score-hero"><div class="score-ring">';
  html += '<svg width="120" height="120" viewBox="0 0 126 126">';
  html += '<circle class="bg" cx="63" cy="63" r="53" fill="none" stroke-width="10"/>';
  html += '<circle class="fg" cx="63" cy="63" r="53" fill="none" stroke-width="10" stroke-dasharray="' + CIRC.toFixed(2) + '" stroke-dashoffset="' + CIRC.toFixed(2) + '" id="ringFg"/>';
  html += '</svg><div class="lbl"><b>' + a.score + '</b><span>score</span></div></div>';
  html += '<div class="score-side">';
  html += '<div class="bd"><span>baseline</span><b>' + (bd.baseline || 0) + '</b></div>';
  html += '<div class="bd"><span>positive</span><b class="pos">+' + (bd.positive || 0) + '</b></div>';
  html += '<div class="bd"><span>volume_bonus</span><b class="pos">+' + (bd.volumeBonus || 0) + '</b></div>';
  html += '<div class="bd"><span>penalties</span><b class="neg">' + (bd.negative || 0) + '</b></div>';
  html += '<div class="bd"><span>suggested_ceiling</span><b>$' + (a.suggested_daily_ceiling || 0) + '/day</b></div>';
  html += '</div></div>';

  // attestation actions
  html += '<div class="subhead">record attestation</div><div class="act-row" id="attActions"></div>';

  // permissions
  html += '<div class="subhead">scoped permissions</div>';
  html += '<form class="grant-form" id="grantForm">';
  html += '<label>category<input type="text" name="category" required placeholder="compute" value="compute" /></label>';
  html += '<label>ceiling USD<input type="number" name="ceiling" required min="1" step="1" placeholder="100" value="100" /></label>';
  html += '<button type="submit" class="chip" id="grantSubmit">+ grant</button>';
  html += '</form>';
  html += '<div id="permList"></div>';

  // history
  html += '<div class="subhead">recent history</div><div class="hist" id="histList"></div>';

  html += '</div>';
  body.innerHTML = html;

  // animate ring
  requestAnimationFrame(() => {
    const fg = $('#ringFg');
    if (fg) fg.style.strokeDashoffset = String(offset);
  });

  renderAttActions(a.id);
  renderPermList(data.permissions || [], a.id);
  renderHist(data.attestations || []);
  wireGrantForm(a);

  const share = $('#shareAgent');
  if (share) {
    share.addEventListener('click', async () => {
      const url = location.origin + '/a/' + encodeURIComponent(a.handle);
      try {
        await navigator.clipboard.writeText(url);
        toast('share link copied', 'ok');
      } catch (_) {
        toast(url, 'ok');
      }
    });
  }
}
const POSITIVE_KINDS = ['task_completed', 'clean_payment', 'peer_vouch'];
const NEGATIVE_KINDS = ['dispute', 'chargeback', 'anomaly_flag'];

function renderAttActions(agentId) {
  const box = $('#attActions');
  box.innerHTML = '';
  POSITIVE_KINDS.concat(NEGATIVE_KINDS).forEach((kind) => {
    const neg = NEGATIVE_KINDS.includes(kind);
    const b = el('button', 'chip' + (neg ? ' neg' : ''), (neg ? '− ' : '+ ') + kind);
    b.addEventListener('click', async () => {
      try {
        const r = await api('/agents/' + agentId + '/attestations', {
          method: 'POST',
          body: JSON.stringify({ kind }),
        });
        toast(kind + ' recorded → score ' + r.agent.score + ' (' + r.agent.label + ')', neg ? 'err' : 'ok');
        await refreshAll();
        selectAgent(agentId);
      } catch (e) { toast(e.message, 'err'); }
    });
    box.appendChild(b);
  });
}

function renderPermList(perms, agentId) {
  const box = $('#permList');
  box.innerHTML = '';
  if (!perms.length) { box.appendChild(el('div', 'empty', 'no permissions granted')); return; }
  perms.forEach((p) => {
    const item = el('div', 'perm-item');
    const row = el('div', 'perm-row');
    let inner = '<div class="perm-cat">' + p.category + '</div>';
    inner += '<div class="perm-meta">$' + p.ceiling + '/' + p.period + '</div>';
    if (p.status === 'active') {
      inner += '<button class="mini-revoke" data-id="' + p.id + '">revoke</button>';
    } else {
      inner += '<span class="perm-status revoked">revoked</span>';
    }
    row.innerHTML = inner;
    const rb = row.querySelector('.mini-revoke');
    if (rb) rb.addEventListener('click', async () => {
      try {
        await api('/permissions/' + p.id + '/revoke', { method: 'POST' });
        toast('permission revoked', 'ok');
        selectAgent(agentId);
        loadStats();
      } catch (e) { toast(e.message, 'err'); }
    });
    item.appendChild(row);

    // Active permissions show a live budget bar + a quick spend control.
    if (p.status === 'active') {
      const budget = el('div', 'perm-budget');
      budget.innerHTML =
        '<div class="budget-bar"><i style="width:0%"></i></div>' +
        '<div class="budget-line"><span class="budget-txt">loading budget…</span>' +
        '<form class="spend-form"><input type="number" min="0.01" step="0.01" ' +
        'placeholder="amount" class="spend-amt" /><button type="submit" class="mini-spend">spend</button></form></div>' +
        '<div class="spend-log" hidden></div>';
      item.appendChild(budget);
      loadPermBudget(p.id, budget);
      loadSpendLog(p.id, budget);
      wireSpendForm(p.id, agentId, budget);
    }
    box.appendChild(item);
  });
}

// Fetch a permission's budget and paint the usage bar + text.
async function loadPermBudget(permId, container) {
  try {
    const { budget } = await api('/permissions/' + permId + '/budget');
    paintBudget(container, budget);
  } catch (e) {
    const txt = container.querySelector('.budget-txt');
    if (txt) txt.textContent = 'budget unavailable';
  }
}

function paintBudget(container, b) {
  const pct = b.ceiling > 0 ? Math.min(100, (b.used / b.ceiling) * 100) : 0;
  const bar = container.querySelector('.budget-bar i');
  if (bar) {
    bar.style.width = pct.toFixed(1) + '%';
    bar.className = pct >= 100 ? 'full' : pct >= 80 ? 'warn' : '';
  }
  const txt = container.querySelector('.budget-txt');
  if (txt) {
    txt.textContent =
      '$' + round2(b.used) + ' / $' + round2(b.ceiling) + ' used · $' +
      round2(b.remaining) + ' left this ' + b.period;
  }
}

function round2(n) { return Math.round(Number(n) * 100) / 100; }

// Fetch and render the recent spend history for a permission.
async function loadSpendLog(permId, container) {
  try {
    const { spends } = await api('/permissions/' + permId + '/spends?limit=8');
    renderSpendLog(container, spends);
  } catch (_) { /* history is optional */ }
}

function renderSpendLog(container, spends) {
  const box = container.querySelector('.spend-log');
  if (!box) return;
  if (!spends || !spends.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = spends
    .map((s) =>
      '<div class="spend-row"><span class="spend-amount">−$' + round2(s.amount) + '</span>' +
      '<span class="spend-note">' + (s.note ? escapeText(s.note) : 'spend') + '</span>' +
      '<span class="spend-time">' + timeAgo(s.created_at) + '</span></div>'
    )
    .join('');
}

function escapeText(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function wireSpendForm(permId, agentId, container) {
  const form = container.querySelector('.spend-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = form.querySelector('.spend-amt');
    const btn = form.querySelector('.mini-spend');
    const amount = Number(input.value);
    if (!amount || amount <= 0) { toast('enter a positive amount', 'err'); return; }
    btn.disabled = true;
    try {
      const r = await api('/permissions/' + permId + '/spends', {
        method: 'POST',
        body: JSON.stringify({ amount, note: 'console' }),
      });
      paintBudget(container, r.budget);
      input.value = '';
      loadStats();
      loadSpendLog(permId, container);
      toast('spent $' + round2(amount) + ' · $' + round2(r.budget.remaining) + ' left', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });
}

function renderHist(atts) {
  const box = $('#histList');
  box.innerHTML = '';
  if (!atts.length) { box.appendChild(el('div', 'empty', 'no activity yet')); return; }
  atts.forEach((a) => {
    const neg = a.weight < 0;
    const row = el('div', 'hist-row');
    row.innerHTML =
      '<div class="hist-kind">' + a.kind + '</div>' +
      '<div class="hist-w ' + (neg ? 'neg' : 'pos') + '">' + (neg ? '' : '+') + a.weight + '</div>' +
      '<div class="hist-time">' + timeAgo(a.created_at) + '</div>';
    box.appendChild(row);
  });
}

function wireGrantForm(agent) {
  const form = $('#grantForm');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#grantSubmit');
    const fd = new FormData(form);
    const category = String(fd.get('category') || '').trim();
    const ceiling = Number(fd.get('ceiling'));
    if (!category) { toast('category required', 'err'); return; }
    if (!ceiling || ceiling < 1) { toast('ceiling must be at least $1', 'err'); return; }
    btn.disabled = true;
    btn.textContent = 'granting…';
    try {
      const r = await api('/agents/' + agent.id + '/permissions', {
        method: 'POST',
        body: JSON.stringify({ category, ceiling, period: 'day', granted_by: 'console' }),
      });
      const p = r.permission;
      toast(p.capped ? ('capped to $' + p.ceiling + ' by tier') : ('granted $' + p.ceiling + '/day'), 'ok');
      selectAgent(agent.id);
      loadStats();
    } catch (err) { toast(err.message, 'err'); }
    finally {
      btn.disabled = false;
      btn.textContent = '+ grant';
    }
  });
}
// ---- create agent modal ----
function openModal() { $('#createModal').hidden = false; $('#createErr').hidden = true; }
function closeModal() { $('#createModal').hidden = true; $('#createForm').reset(); }

function genIdentity() {
  const rnd = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  return '0x' + rnd(20);
}

function wireModal() {
  $('#openCreate').addEventListener('click', openModal);
  $('#closeCreate').addEventListener('click', closeModal);
  $('#cancelCreate').addEventListener('click', closeModal);
  const genBtn = $('#genWallet');
  if (genBtn) genBtn.addEventListener('click', () => {
    const w = $('#createForm').elements.wallet;
    w.value = genIdentity();
  });
  $('#createModal').addEventListener('click', (e) => {
    if (e.target === $('#createModal')) closeModal();
  });
  $('#createForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = e.target.querySelector('button[type="submit"]');
    const fd = new FormData(e.target);
    const walletInput = (fd.get('wallet') || '').trim();
    const payload = {
      handle: fd.get('handle').trim(),
      wallet: walletInput || genIdentity(),
      operator: (fd.get('operator') || '').trim() || undefined,
    };
    submitBtn.disabled = true;
    submitBtn.textContent = 'registering…';
    $('#createErr').hidden = true;
    try {
      const r = await api('/agents', { method: 'POST', body: JSON.stringify(payload) });
      closeModal();
      toast('agent ' + r.agent.handle + ' registered', 'ok');
      await refreshAll();
      selectAgent(r.agent.id);
    } catch (err) {
      const box = $('#createErr');
      box.textContent = err.message;
      box.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Register';
    }
  });
}

// ---- demo loop: register → attest → grant (one click) ----
async function runDemoLoop(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'running…'; }
  const suffix = Date.now().toString(36).slice(-5);
  const handle = 'try-' + suffix;
  const wallet = '0xdemo' + suffix + Math.random().toString(16).slice(2, 10);
  try {
    const created = await api('/agents', {
      method: 'POST',
      body: JSON.stringify({ handle, wallet, operator: 'demo-loop' }),
    });
    const id = created.agent.id;
    for (let i = 0; i < 5; i++) {
      await api('/agents/' + id + '/attestations', {
        method: 'POST',
        body: JSON.stringify({ kind: i % 2 ? 'clean_payment' : 'task_completed' }),
      });
    }
    await api('/agents/' + id + '/attestations', {
      method: 'POST',
      body: JSON.stringify({ kind: 'peer_vouch' }),
    });
    await api('/agents/' + id + '/permissions', {
      method: 'POST',
      body: JSON.stringify({ category: 'compute', ceiling: 100, period: 'day', granted_by: 'demo-loop' }),
    });
    await refreshAll();
    await selectAgent(id);
    history.replaceState(null, '', '/app/?agent=' + encodeURIComponent(handle));
    toast(handle + ' demo complete — score updated', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = btn.id === 'runDemo' ? '▶ Demo loop' : '▶ Run demo loop'; }
  }
}

function wireApiStrip() {
  const btn = $('#copyCurl');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const text = ($('#apiPre') && $('#apiPre').textContent) || '';
    try {
      await navigator.clipboard.writeText(text.trim());
      toast('curl copied', 'ok');
    } catch (_) {
      toast('copy failed', 'err');
    }
  });
}

async function openDeepLink() {
  const params = new URLSearchParams(location.search);
  const handle = params.get('agent');
  const id = params.get('id');
  if (id) {
    await selectAgent(id);
    return;
  }
  if (handle) {
    const match = state.agents.find((a) => a.handle.toLowerCase() === handle.toLowerCase());
    if (match) {
      await selectAgent(match.id);
      return;
    }
    try {
      const data = await api('/agents/' + encodeURIComponent(handle));
      if (data.agent) await selectAgent(data.agent.id);
    } catch (_) { /* ignore */ }
  }
}

function wireHolderStrip() {
  const input = $('#holderWallet');
  const badge = $('#holderBadge');
  const note = $('#holderNote');
  if (!input) return;
  try {
    const saved = localStorage.getItem('kairune_holder_wallet') || '';
    if (saved) {
      input.value = saved;
      state.holderWallet = saved;
    }
  } catch (_) {}

  async function refreshToken() {
    try {
      const t = await api('/token');
      if (note) {
        note.textContent = t.is_holder
          ? ('Holder rate limit: ' + t.write_rate_limit + ' writes / min')
          : (t.note || note.textContent);
      }
      if (badge) {
        badge.textContent = t.is_holder ? 'holder' : 'guest';
        badge.className = 'holder-badge' + (t.is_holder ? ' on' : '');
      }
    } catch (_) {}
  }

  input.addEventListener('change', () => {
    state.holderWallet = input.value.trim();
    try { localStorage.setItem('kairune_holder_wallet', state.holderWallet); } catch (_) {}
    refreshToken();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    }
  });
  refreshToken();
}

// ---- refresh orchestration ----
async function refreshAll() {
  try {
    await Promise.all([loadStats(), loadAgents()]);
    setConn(true);
  } catch (e) {
    setConn(false);
    toast('API error: ' + e.message, 'err');
  }
}

// ---- boot ----
async function boot() {
  wireModal();
  wireApiStrip();
  wireHolderStrip();
  $('#refreshBtn').addEventListener('click', refreshAll);
  const search = $('#agentSearch');
  if (search) search.addEventListener('input', renderAgentList);
  const qs = $('#qsRegister');
  if (qs) qs.addEventListener('click', openModal);
  const runDemo = $('#runDemo');
  if (runDemo) runDemo.addEventListener('click', () => runDemoLoop(runDemo));
  const qsDemo = $('#qsDemo');
  if (qsDemo) qsDemo.addEventListener('click', () => runDemoLoop(qsDemo));
  $('.logo').addEventListener('click', () => { location.href = '/'; });
  try {
    state.meta = await api('/meta');
    setConn(true);
  } catch (e) { setConn(false); }
  await refreshAll();
  await openDeepLink();

  const params = new URLSearchParams(location.search);
  if (params.get('demo') === '1') {
    history.replaceState(null, '', '/app/');
    const btn = runDemo || qsDemo;
    await runDemoLoop(btn);
  }

  setInterval(loadStats, 15000);
}

document.addEventListener('DOMContentLoaded', boot);
