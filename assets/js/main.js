const nav = document.getElementById('nav');
let scrollTicking = false;
window.addEventListener('scroll', () => {
  if (scrollTicking) return;
  scrollTicking = true;
  requestAnimationFrame(() => {
    nav.classList.toggle('scrolled', window.scrollY > 8);
    scrollTicking = false;
  });
}, { passive: true });

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// reveal on scroll: manual rect-check, robust across resizes/full-page renders
const revealEls = document.querySelectorAll('.reveal');
if (reduced) {
  revealEls.forEach(el => el.classList.add('in'));
} else {
  // Stagger: apply a gradual delay to sibling items in the same grid/list,
  // so the cards (bento/steps/ledger/quote) appear in a flow, not all at once.
  revealEls.forEach(el => {
    const parent = el.parentElement;
    if (!parent) return;
    const siblings = Array.from(parent.children).filter(c => c.classList.contains('reveal'));
    if (siblings.length > 1) {
      const idx = siblings.indexOf(el);
      el.style.setProperty('--reveal-delay', (idx * 80) + 'ms');
    }
  });

  const checkReveals = () => {
    const vh = window.innerHeight;
    revealEls.forEach(el => {
      if (el.classList.contains('in')) return;
      const r = el.getBoundingClientRect();
      if (r.top < vh * 0.92) el.classList.add('in');
    });
  };
  window.addEventListener('scroll', checkReveals, { passive:true });
  window.addEventListener('resize', checkReveals);
  window.addEventListener('load', checkReveals);
  checkReveals();
  setTimeout(checkReveals, 300);
  setTimeout(checkReveals, 1000);
  setTimeout(() => revealEls.forEach(el => el.classList.add('in')), 2500);

  // Spotlight cursor-follow on the bento cards (glow follows the mouse).
  document.querySelectorAll('.bento .cell').forEach(cell => {
    cell.addEventListener('pointermove', e => {
      const r = cell.getBoundingClientRect();
      cell.style.setProperty('--mx', (e.clientX - r.left) + 'px');
      cell.style.setProperty('--my', (e.clientY - r.top) + 'px');
    });
  });
}

// Trust-mark event types.
//
// This was a static list labelled "live activity" that named real handles with
// claims the registry does not support — "voyager-07 completed 128 tasks clean"
// described an agent with 1,041 tasks and 97 disputes and chargebacks. There is
// no public activity-feed endpoint to drive a real one, so it now shows the
// event kinds the registry actually records and is labelled as such. The numbers
// beside it in #liveStats are the live ones, read from /api/stats.
const tickerItems = [
  ['task_completed', '+6 · a job finished as agreed'],
  ['clean_payment', '+8 · settled without a dispute'],
  ['peer_vouch', '+14 · another agent staked its own record'],
  ['dispute', '−40 · the counterparty contested the work'],
  ['chargeback', '−70 · payment was clawed back'],
  ['anomaly_flag', '−90 · behaviour that broke the pattern'],
];
const track = document.getElementById('tickerTrack');
if (track) {
  const once = () => tickerItems.map(([id, msg]) => `<span><b>${id}</b> ${msg}</span>`).join('');
  track.innerHTML = once() + once();
  if (reduced) track.style.animation = 'none';
}

// live spend-decision feed (real data from /api/feed)
(function liveFeed() {
  const list = document.getElementById('feedList');
  const statusEl = document.getElementById('feedStatus');
  if (!list) return;

  const money = (n) => {
    const v = Number(n) || 0;
    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  const ago = (iso) => {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return Math.floor(s) + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  };
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const row = (e) => {
    const blocked = e.event === 'spend.blocked';
    const handle = esc(e.agent_handle || 'agent');
    const period = esc(e.period || 'day');
    const verb = blocked ? 'blocked' : 'approved';
    const detail = blocked
      ? `over ${money(e.ceiling)}/${period} ceiling`
      : `within ${money(e.ceiling)}/${period} ceiling`;
    return `<li class="feed-row ${blocked ? 'blk' : 'ok'}">
      <span class="fr-dot"></span>
      <span class="fr-agent">${handle}</span>
      <span class="fr-amt">${money(e.amount)}</span>
      <span class="fr-verb">${verb}</span>
      <span class="fr-detail">${detail}</span>
      <span class="fr-time">${ago(e.created_at)}</span>
    </li>`;
  };

  let lastKey = '';
  async function tick() {
    try {
      const r = await fetch('/api/feed?limit=12', { cache: 'no-store' });
      if (!r.ok) throw new Error('bad status');
      const { events = [] } = await r.json();
      if (statusEl) statusEl.classList.remove('down');
      if (!events.length) {
        list.innerHTML = '<li class="feed-empty">no spend activity yet — try the demo loop in the console.</li>';
        return;
      }
      const key = events.map((e) => (e.created_at || '') + e.amount).join('|');
      if (key === lastKey) return; // no change, skip re-render
      lastKey = key;
      list.innerHTML = events.map(row).join('');
      const first = list.querySelector('.feed-row');
      if (first && !reduced) {
        first.classList.add('fr-new');
        setTimeout(() => first.classList.remove('fr-new'), 1200);
      }
    } catch (_) {
      if (statusEl) statusEl.classList.add('down');
    }
  }

  tick();
  setInterval(tick, 5000);
})();

// kinetic marquee band
const marquee = document.getElementById('marqueeTrack');
if (marquee) {
  const phrase = '$KAIRUNE IS LIVE ON <b>VIRTUALS</b> · <b>ROBINHOOD CHAIN</b> — <b>KAIRUNE</b> — THE TRUST LAYER FOR AGENTS THAT SPEND — ';
  marquee.innerHTML = `<span>${phrase.repeat(4)}</span><span>${phrase.repeat(4)}</span>`;
  if (reduced) marquee.style.animation = 'none';
}

// subtle parallax: the graph canvas drifts gently with scroll (feels alive),
// applied to the canvas so it doesn't clash with the hover-lift on .graph-panel.
const graphCanvas = document.getElementById('graph');
if (graphCanvas && !reduced) {
  let parallaxTicking = false;
  window.addEventListener('scroll', () => {
    if (parallaxTicking) return;
    parallaxTicking = true;
    requestAnimationFrame(() => {
      const y = Math.min(window.scrollY, 600);
      graphCanvas.style.transform = `translateY(${y * -0.03}px)`;
      parallaxTicking = false;
    });
  }, { passive: true });
}

// trust score demo: animate ring + bars once visible
const ring = document.getElementById('ringFg');
const ringNum = document.getElementById('ringNum');
const bar1 = document.getElementById('bar1');
const bar2 = document.getElementById('bar2');
const demoCard = document.querySelector('.demo-card');
const CIRC = 333.01;

// The card is labelled with a real handle and links to that agent's public page,
// so the numbers have to be that agent's. They were hardcoded (847, TIER_3,
// invented task counts) and drifted away from the live score, which meant the
// homepage advertised a better rating than the page it linked to. Fetched live
// now, with the last-known real values inlined in the HTML as the fallback.
const DEMO_HANDLE = 'voyager-07';
let SCORE = 668;
let animated = false;

function animateDemo() {
  if (animated) return;
  animated = true;
  const pct = SCORE / 1000;
  if (ring) ring.style.strokeDashoffset = String(CIRC * (1 - pct));
  if (bar1) bar1.style.width = Math.round(pct * 100) + '%';
  if (bar2) bar2.style.width = '46%';
  if (ringNum && !reduced) {
    let cur = 0;
    const step = () => {
      cur += Math.ceil((SCORE - cur) / 8) || 1;
      if (cur >= SCORE) { ringNum.textContent = SCORE; return; }
      ringNum.textContent = cur;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  } else if (ringNum) {
    ringNum.textContent = SCORE;
  }
}

// Pull the agent's real figures. Any failure leaves the inlined fallback in
// place rather than showing a zero or an error, since this is decorative.
function loadDemoAgent() {
  if (!demoCard || typeof fetch !== 'function') return;
  fetch('/api/agents/' + DEMO_HANDLE, { headers: { accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      const a = data && data.agent;
      if (!a || typeof a.score !== 'number') return;
      const kinds = (a.totals && a.totals.byKind) || {};
      const set = (id, value) => {
        const el = document.getElementById(id);
        if (el && value != null) el.textContent = value;
      };
      set('demoTier', 'TIER_' + a.tier + ' · ' + (a.label || ''));
      set('demoTasks', (kinds.task_completed || 0).toLocaleString());
      set('demoPayments', (kinds.clean_payment || 0).toLocaleString());
      set('demoVouches', (kinds.peer_vouch || 0).toLocaleString());
      set('demoCeiling', '$' + (a.suggested_daily_ceiling || 0) + '/day');
      set('demoDisputes', ((kinds.dispute || 0) + (kinds.chargeback || 0) + (kinds.anomaly_flag || 0)).toLocaleString());

      SCORE = a.score;
      // If the ring already animated to the fallback, move it to the real value.
      if (animated) {
        const pct = SCORE / 1000;
        if (ring) ring.style.strokeDashoffset = String(CIRC * (1 - pct));
        if (bar1) bar1.style.width = Math.round(pct * 100) + '%';
        if (ringNum) ringNum.textContent = SCORE;
      }
    })
    .catch(() => {});
}
loadDemoAgent();
if (demoCard) {
  const checkDemo = () => {
    const r = demoCard.getBoundingClientRect();
    if (r.top < window.innerHeight * 0.9) animateDemo();
  };
  window.addEventListener('scroll', checkDemo, { passive:true });
  window.addEventListener('load', checkDemo);
  checkDemo();
  setTimeout(checkDemo, 1000);
  setTimeout(animateDemo, 2600);
}

// trust graph canvas: nodes + edges + traveling attestation pulses
(function () {
  const canvas = document.getElementById('graph');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W, H, dpr;
  let nodes = [];
  let pulses = [];
  const NODE_COUNT = 16;
  const LINK_DIST = 130;
  const MOUSE_RADIUS = 110; // cursor influence radius

  // Tier color palette (some nodes get a "trust color").
  const TIER_COLORS = [
    { c: '243,243,240', p: 0.55 }, // neutral
    { c: '227,164,103', p: 0.85 }, // amber
    { c: '143,203,159', p: 0.9 },  // green
    { c: '215,255,63', p: 1 },     // signal
  ];

  const mouse = { x: -9999, y: -9999, active: false };

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    W = rect.width; H = rect.height;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function initNodes() {
    nodes = Array.from({ length: NODE_COUNT }, () => {
      // ~40% of nodes get a tier color, the rest stay neutral.
      const tier =
        Math.random() < 0.4
          ? 1 + Math.floor(Math.random() * (TIER_COLORS.length - 1))
          : 0;
      return {
        x: Math.random() * W, y: Math.random() * H,
        vx: (Math.random() - 0.5) * 0.18, vy: (Math.random() - 0.5) * 0.18,
        ox: 0, oy: 0,            // offset from the cursor push
        r: 2 + Math.random() * 1.6,
        baseR: 0,               // filled in below
        tier,
        flash: 0,               // 0..1 flash intensity when it's a pulse endpoint
      };
    });
    nodes.forEach(n => { n.baseR = n.r; });
  }

  function edges() {
    const list = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[i].x - nodes[j].x, dy = nodes[i].y - nodes[j].y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < LINK_DIST) list.push([i, j, d]);
      }
    }
    return list;
  }

  function maybeSpawnPulse(edgeList) {
    if (pulses.length > 8) return;
    if (Math.random() < 0.03 && edgeList.length) {
      const [i, j] = edgeList[Math.floor(Math.random() * edgeList.length)];
      pulses.push({ i, j, t: 0 });
      // the source node lights up immediately.
      if (nodes[i]) nodes[i].flash = 1;
    }
  }

  function drawPulse(x, y, t) {
    // Outer halo that shrinks along the way (energy effect).
    const halo = 5.5 + Math.sin(t * Math.PI) * 2.5;
    ctx.beginPath();
    ctx.fillStyle = 'rgba(215,255,63,0.16)';
    ctx.arc(x, y, halo, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.fillStyle = '#D7FF3F';
    ctx.arc(x, y, 2.6, 0, Math.PI * 2);
    ctx.fill();
  }

  // Set of edges (i-j) a pulse is traveling along → drawn lit.
  function activeEdgeSet() {
    const s = new Set();
    pulses.forEach(p => s.add(p.i < p.j ? p.i + '-' + p.j : p.j + '-' + p.i));
    return s;
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    const edgeList = edges();
    const active = activeEdgeSet();

    edgeList.forEach(([i, j, d]) => {
      const a = nodes[i], b = nodes[j];
      const key = i < j ? i + '-' + j : j + '-' + i;
      const lit = active.has(key);
      const alpha = (1 - d / LINK_DIST) * (lit ? 0.85 : 0.35);
      ctx.lineWidth = lit ? 1.6 : 1;
      ctx.strokeStyle = lit
        ? `rgba(215,255,63,${alpha})`
        : `rgba(243,243,240,${alpha})`;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    });

    nodes.forEach(n => {
      const col = TIER_COLORS[n.tier];
      const px = n.x + n.ox, py = n.y + n.oy;
      // Glow when the node is "flashing" (a pulse endpoint) or is high-tier.
      if (n.flash > 0.02 || n.tier >= 2) {
        const glow = Math.max(n.flash, n.tier >= 2 ? 0.35 : 0);
        ctx.beginPath();
        ctx.fillStyle = `rgba(${col.c},${0.14 * glow})`;
        ctx.arc(px, py, n.baseR + 6 + glow * 5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.fillStyle = `rgba(${col.c},${col.p})`;
      ctx.arc(px, py, n.baseR + n.flash * 1.6, 0, Math.PI * 2);
      ctx.fill();
    });

    pulses.forEach(p => {
      const a = nodes[p.i], b = nodes[p.j];
      if (!a || !b) return;
      const ax = a.x + a.ox, ay = a.y + a.oy;
      const bx = b.x + b.ox, by = b.y + b.oy;
      const x = ax + (bx - ax) * p.t;
      const y = ay + (by - ay) * p.t;
      drawPulse(x, y, p.t);
    });

    if (!reduced) {
      maybeSpawnPulse(edgeList);
      pulses.forEach(p => {
        p.t += 0.02;
        // When a pulse reaches its target, the target node lights up too.
        if (p.t >= 1 && nodes[p.j]) nodes[p.j].flash = 1;
      });
      pulses = pulses.filter(p => p.t < 1);

      nodes.forEach(n => {
        n.x += n.vx; n.y += n.vy;
        if (n.x < 0 || n.x > W) n.vx *= -1;
        if (n.y < 0 || n.y > H) n.vy *= -1;
        n.x = Math.max(0, Math.min(W, n.x));
        n.y = Math.max(0, Math.min(H, n.y));

        // Cursor push: nodes drift gently away from the mouse, then return.
        if (mouse.active) {
          const dx = n.x - mouse.x, dy = n.y - mouse.y;
          const dist = Math.hypot(dx, dy);
          if (dist < MOUSE_RADIUS && dist > 0.01) {
            const force = (1 - dist / MOUSE_RADIUS) * 8;
            n.ox += (dx / dist) * force;
            n.oy += (dy / dist) * force;
          }
        }
        // Offset decays back to the original position (spring damping).
        n.ox *= 0.88;
        n.oy *= 0.88;
        // Flash fades out slowly.
        n.flash *= 0.94;
      });
    }
  }

  let running = !reduced;
  let resizeTimer;

  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resize();
      initNodes();
      pulses = [];
    }, 120);
  }

  function loop() {
    if (!running) return;
    draw();
    requestAnimationFrame(loop);
  }

  document.addEventListener('visibilitychange', () => {
    if (reduced) return;
    running = document.visibilityState === 'visible';
    if (running) requestAnimationFrame(loop);
  });

  // Cursor interaction (only when motion is not reduced).
  if (!reduced) {
    canvas.addEventListener('pointermove', (e) => {
      const rect = canvas.getBoundingClientRect();
      mouse.x = e.clientX - rect.left;
      mouse.y = e.clientY - rect.top;
      mouse.active = true;
    });
    canvas.addEventListener('pointerleave', () => {
      mouse.active = false;
      mouse.x = mouse.y = -9999;
    });
  }

  resize();
  initNodes();
  window.addEventListener('resize', onResize);
  if (reduced) draw();
  else loop();
})();

// copy contract address — always copies the full address, swaps only the label
const caCopy = document.getElementById('caCopy');
const caValue = document.getElementById('caValue');
if (caCopy && caValue) {
  const caLabel = document.getElementById('caCopyLabel') || caCopy;
  const fullAddress = (caCopy.dataset.ca || caValue.textContent).trim();
  caCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(fullAddress);
      caLabel.textContent = 'copied';
      caCopy.classList.add('copied');
      setTimeout(() => {
        caLabel.textContent = 'copy';
        caCopy.classList.remove('copied');
      }, 2000);
    } catch {
      caLabel.textContent = 'failed';
      setTimeout(() => { caLabel.textContent = 'copy'; }, 2000);
    }
  });
}

// two-gate pipeline: walks a spend request through scope → trust → settle.
// Scope is deliberately shown first: an out-of-scope payee never reaches the trust gate.
(function gatePipeline() {
  const rig = document.getElementById('gateRig');
  if (!rig) return;

  const SCENARIOS = [
    {
      label: 'allowlisted vendor',
      amount: '$42.00',
      payee: '→ gpu-vendor',
      clock: 'pass',
      scope: 'pass',
      trust: 'pass',
      verdict: 'ok',
      text: '200 · settled — grant live for 41m, payee on allowlist, tier_3 ceiling has room',
    },
    {
      label: 'expired grant',
      amount: '$42.00',
      payee: '→ gpu-vendor',
      clock: 'fail',
      scope: 'skip',
      trust: 'skip',
      verdict: 'no',
      text: '409 · permission_expired — deadline passed 6m ago. Same payee, same budget, no longer authorized.',
    },
    {
      label: 'stranger payee',
      amount: '$8.00',
      payee: '→ 0x9f31…c40a',
      clock: 'pass',
      scope: 'fail',
      trust: 'skip',
      verdict: 'no',
      text: '409 · counterparty_not_allowed — not on this grant\u2019s allowlist, refused before any trust lookup',
    },
    {
      label: 'no payee named',
      amount: '$15.00',
      payee: '→ (omitted)',
      clock: 'pass',
      scope: 'fail',
      trust: 'skip',
      verdict: 'no',
      text: '409 · counterparty_required — this grant will not pay an unnamed party',
    },
    {
      label: 'allowlisted but declined',
      amount: '$90.00',
      payee: '→ flaky-vendor',
      clock: 'pass',
      scope: 'pass',
      trust: 'fail',
      verdict: 'no',
      text: '409 · counterparty_declined — on the list, but its own record says no. Scope is not a free pass.',
    },
  ];

  const els = {
    amount: document.getElementById('gateAmount'),
    payee: document.getElementById('gatePayee'),
    verdict: document.getElementById('gateVerdict'),
    verdictText: document.getElementById('gateVerdictText'),
    chips: document.getElementById('gateScenarios'),
  };
  const clock = rig.querySelector('[data-gate="clock"]');
  const scope = rig.querySelector('[data-gate="scope"]');
  const trust = rig.querySelector('[data-gate="trust"]');
  const settle = rig.querySelector('[data-gate="settle"]');
  const wires = [1, 2, 3, 4].map(n => rig.querySelector(`[data-leg="${n}"]`));
  if (!els.amount || !clock || !scope || !trust || !settle || wires.some(w => !w)) return;

  let timers = [];
  let index = 0;
  let auto = true;

  const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };
  const after = (ms, fn) => { timers.push(setTimeout(fn, ms)); };

  function resetVisuals() {
    [clock, scope, trust, settle].forEach(n => n.classList.remove('pass', 'fail', 'idle'));
    wires.forEach(w => w.classList.remove('flow', 'live', 'dead'));
    els.verdict.classList.remove('ok', 'no');
  }

  function paintChips() {
    Array.from(els.chips.children).forEach((c, i) => c.classList.toggle('on', i === index));
  }

  function run(s) {
    clearTimers();
    resetVisuals();
    // force the packet animations to restart from zero
    void rig.offsetWidth;

    els.amount.textContent = s.amount;
    els.payee.textContent = s.payee;
    els.verdictText.textContent = 'evaluating…';
    paintChips();

    const step = reduced ? 0 : 620;

    wires[0].classList.add('flow', 'live');
    after(step, () => {
      clock.classList.add(s.clock);
      if (s.clock === 'fail') {
        wires[1].classList.add('dead');
        wires[2].classList.add('dead');
        wires[3].classList.add('dead');
        scope.classList.add('idle');
        trust.classList.add('idle');
        settle.classList.add('idle');
        els.verdict.classList.add(s.verdict);
        els.verdictText.textContent = s.text;
        return;
      }
      wires[1].classList.add('flow', 'live');
      after(step, () => {
        scope.classList.add(s.scope);
        if (s.scope === 'fail') {
          wires[2].classList.add('dead');
          wires[3].classList.add('dead');
          trust.classList.add('idle');
          settle.classList.add('idle');
          els.verdict.classList.add(s.verdict);
          els.verdictText.textContent = s.text;
          return;
        }
        wires[2].classList.add('flow', 'live');
        after(step, () => {
          trust.classList.add(s.trust);
          if (s.trust === 'fail') {
            wires[3].classList.add('dead');
            settle.classList.add('idle');
            els.verdict.classList.add(s.verdict);
            els.verdictText.textContent = s.text;
            return;
          }
          wires[3].classList.add('flow', 'live');
          after(step, () => {
            settle.classList.add('pass');
            els.verdict.classList.add(s.verdict);
            els.verdictText.textContent = s.text;
          });
        });
      });
    });
  }

  SCENARIOS.forEach((s, i) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'gate-chip';
    chip.textContent = s.label;
    chip.addEventListener('click', () => {
      auto = false;
      index = i;
      run(SCENARIOS[index]);
    });
    els.chips.appendChild(chip);
  });

  run(SCENARIOS[index]);

  // Advance on its own until the visitor takes over, and only while on screen.
  const CYCLE = 4200;
  let cycler = null;
  const tick = () => {
    if (!auto) return;
    index = (index + 1) % SCENARIOS.length;
    run(SCENARIOS[index]);
  };
  const start = () => { if (!cycler) cycler = setInterval(tick, CYCLE); };
  const stop = () => { clearInterval(cycler); cycler = null; };

  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      entries.forEach(e => (e.isIntersecting ? start() : stop()));
    }, { threshold: 0.25 }).observe(rig);
  } else {
    start();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop(); else start();
  });
  rig.addEventListener('pointerenter', () => { auto = false; });
})();

// live registry stats (social proof → console)
(async function loadLiveStats() {
  const els = {
    agents: document.getElementById('lsAgents'),
    att: document.getElementById('lsAtt'),
    perms: document.getElementById('lsPerms'),
    avg: document.getElementById('lsAvg'),
  };
  if (!els.agents) return;
  try {
    const r = await fetch('/api/stats');
    if (!r.ok) return;
    const s = await r.json();
    els.agents.textContent = s.total_agents;
    els.att.textContent = s.total_attestations;
    els.perms.textContent = s.active_permissions;
    els.avg.textContent = s.avg_score;
  } catch (_) {
    /* keep dashes */
  }
})();
