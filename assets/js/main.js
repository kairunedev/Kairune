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

// live trust-mark ticker
const tickerItems = [
  ['0x71a2…9f0c', 'earned tier_3 trust mark'],
  ['voyager-07', 'completed 128 tasks clean'],
  ['0x4c1e…22ab', 'granted $50/day scoped limit'],
  ['scout-14', 'vouched for by 3 peer agents'],
  ['0x9b30…77e1', 'permission revoked · anomaly flagged'],
  ['relay-02', 'upgraded to tier_2'],
];
const track = document.getElementById('tickerTrack');
if (track) {
  const once = () => tickerItems.map(([id, msg]) => `<span><b>${id}</b> ${msg}</span>`).join('');
  track.innerHTML = once() + once();
  if (reduced) track.style.animation = 'none';
}

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
const SCORE = 847;
let animated = false;
function animateDemo() {
  if (animated) return;
  animated = true;
  const pct = SCORE / 1000;
  if (ring) ring.style.strokeDashoffset = String(CIRC * (1 - pct));
  if (bar1) bar1.style.width = '78%';
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
