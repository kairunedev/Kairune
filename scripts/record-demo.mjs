#!/usr/bin/env node
/**
 * Record a polished, smooth Kairune console product demo.
 *
 * What makes it smooth & clean:
 *  - A visible, brand-styled cursor that eases between targets.
 *  - Character-by-character typing into form fields.
 *  - On-page caption bar (lower third) styled to match the site — no crude
 *    burned-in subtitles.
 *  - Intro + outro title cards.
 *  - Continuous motion so the captured frames stay smooth.
 *
 * Output: brand/kairune-demo-tweet.mp4 (1080p, 30fps, silent, X-ready).
 */
import { chromium } from 'playwright';
import { mkdir, readdir, unlink } from 'fs/promises';
import { join } from 'path';
import { execSync } from 'child_process';

const OUT_DIR = new URL('../brand/demo-video', import.meta.url).pathname;
const FINAL_MP4 = new URL('../brand/kairune-demo-tweet.mp4', import.meta.url).pathname;
const BASE = process.env.DEMO_URL || 'https://kairune.online';
const W = 1920;
const H = 1080;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Injected in-page controller: cursor, click ripple, caption bar, title cards.
function installController() {
  const css = `
    #dCur{position:fixed;z-index:2147483000;left:0;top:0;width:26px;height:26px;
      margin:-4px 0 0 -4px;pointer-events:none;will-change:transform;}
    #dCur svg{display:block;filter:drop-shadow(0 3px 7px rgba(0,0,0,.55));}
    #dCur.press{transform-origin:4px 4px;}
    #dRing{position:fixed;z-index:2147482999;width:52px;height:52px;margin:-26px 0 0 -26px;
      border-radius:50%;border:2px solid rgba(215,255,63,.75);pointer-events:none;opacity:0;}
    @keyframes dPing{0%{opacity:.85;transform:scale(.35)}100%{opacity:0;transform:scale(1.5)}}
    #dRing.ping{animation:dPing .55s cubic-bezier(.2,.7,.2,1)}
    #dCap{position:fixed;z-index:2147482998;left:50%;bottom:58px;
      transform:translateX(-50%) translateY(14px);opacity:0;
      transition:opacity .45s ease,transform .45s cubic-bezier(.2,.7,.2,1);
      display:flex;align-items:center;gap:15px;
      background:rgba(11,12,14,.82);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);
      border:1px solid rgba(215,255,63,.22);border-radius:16px;padding:15px 24px;
      box-shadow:0 24px 70px rgba(0,0,0,.55);}
    #dCap.on{opacity:1;transform:translateX(-50%) translateY(0)}
    #dCap .b{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;font-weight:700;
      color:#10130A;background:#D7FF3F;border-radius:7px;padding:5px 10px;white-space:nowrap;letter-spacing:.02em;}
    #dCap .t{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
      font-size:21px;font-weight:600;color:#F3F3F0;letter-spacing:-.01em;white-space:nowrap;}
    #dCard{position:fixed;inset:0;z-index:2147483600;background:#0B0C0E;
      display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;
      opacity:0;transition:opacity .6s ease;pointer-events:none;}
    #dCard.on{opacity:1}
    #dCard .logo{display:flex;align-items:center;gap:14px;}
    #dCard .logo span{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
      font-size:44px;font-weight:650;color:#F3F3F0;letter-spacing:-.02em;}
    #dCard .ttl{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
      font-size:40px;font-weight:700;letter-spacing:-.02em;color:#F3F3F0;margin:0;text-align:center;}
    #dCard .ttl b{color:#D7FF3F;}
    #dCard .sub{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:17px;color:rgba(243,243,240,.55);}
    #dCard .sub em{color:#D7FF3F;font-style:normal;}
  `;
  const st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  const cur = document.createElement('div');
  cur.id = 'dCur';
  cur.innerHTML =
    '<svg width="26" height="26" viewBox="0 0 24 24" fill="none">' +
    '<path d="M5 2.5l14.5 8.2-6.4 1.5-3.3 6.9L5 2.5z" fill="#F3F3F0" stroke="#0B0C0E" stroke-width="1.3" stroke-linejoin="round"/></svg>';
  document.body.appendChild(cur);

  const ring = document.createElement('div');
  ring.id = 'dRing';
  document.body.appendChild(ring);

  const cap = document.createElement('div');
  cap.id = 'dCap';
  cap.innerHTML = '<span class="b"></span><span class="t"></span>';
  document.body.appendChild(cap);

  const state = { x: W2(), y: H2() };
  function W2() { return window.innerWidth / 2; }
  function H2() { return window.innerHeight / 2; }
  function place() {
    cur.style.transform = 'translate(' + state.x + 'px,' + state.y + 'px)' + (cur.classList.contains('press') ? ' scale(.82)' : '');
    ring.style.left = state.x + 'px';
    ring.style.top = state.y + 'px';
  }
  place();

  window.__dMove = (tx, ty, dur) =>
    new Promise((res) => {
      const sx = state.x, sy = state.y, t0 = performance.now();
      const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
      function step(now) {
        const p = Math.min(1, (now - t0) / dur);
        const e = ease(p);
        state.x = sx + (tx - sx) * e;
        state.y = sy + (ty - sy) * e;
        place();
        if (p < 1) requestAnimationFrame(step);
        else res();
      }
      requestAnimationFrame(step);
    });

  window.__dClick = () =>
    new Promise((res) => {
      cur.classList.add('press');
      place();
      ring.classList.remove('ping');
      void ring.offsetWidth;
      ring.classList.add('ping');
      setTimeout(() => {
        cur.classList.remove('press');
        place();
        res();
      }, 300);
    });

  window.__dCap = (b, t) => {
    if (!b && !t) { cap.classList.remove('on'); return; }
    cap.querySelector('.b').textContent = b;
    cap.querySelector('.t').textContent = t;
    cap.classList.add('on');
  };

  window.__dCard = (html, sub, on) => {
    let c = document.getElementById('dCard');
    if (!c) {
      c = document.createElement('div');
      c.id = 'dCard';
      c.innerHTML = '<div class="in"></div>';
      document.body.appendChild(c);
    }
    c.querySelector('.in').innerHTML = html + (sub ? '<div class="sub">' + sub + '</div>' : '');
    c.classList.toggle('on', !!on);
  };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  for (const f of await readdir(OUT_DIR)) {
    if (f.endsWith('.webm')) await unlink(join(OUT_DIR, f)).catch(() => {});
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--force-device-scale-factor=1', '--hide-scrollbars'],
  });
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    recordVideo: { dir: OUT_DIR, size: { width: W, height: H } },
    colorScheme: 'dark',
    reducedMotion: 'no-preference',
  });

  const page = await context.newPage();
  const handle = `atlas-${Date.now().toString(36).slice(-4)}`;
  const wallet = `0x${Date.now().toString(16).padStart(40, '0').slice(0, 40)}`;

  // Smooth-move helpers driven from Node using the in-page controller.
  const box = async (sel) => {
    const b = await page.locator(sel).first().boundingBox();
    if (!b) throw new Error('no box for ' + sel);
    return b;
  };
  const moveTo = async (sel, dur = 850) => {
    const b = await box(sel);
    await page.evaluate(
      ([x, y, d]) => window.__dMove(x, y, d),
      [b.x + b.width / 2, b.y + b.height / 2, dur]
    );
  };
  const click = async (sel, dur = 850) => {
    await moveTo(sel, dur);
    await page.evaluate(() => window.__dClick());
    await page.click(sel);
  };
  const cap = (b, t) => page.evaluate(([x, y]) => window.__dCap(x, y), [b, t]);
  const card = (html, sub, on) =>
    page.evaluate(([h, s, o]) => window.__dCard(h, s, o), [html, sub, on]);
  const type = async (sel, text) => {
    await page.locator(sel).click();
    await page.locator(sel).pressSequentially(text, { delay: 80 });
  };
  const retype = async (sel, text) => {
    await page.locator(sel).click();
    await page.locator(sel).press('Control+a');
    await page.locator(sel).press('Backspace');
    await page.locator(sel).pressSequentially(text, { delay: 70 });
  };

  try {
    await page.goto(`${BASE}/app`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForSelector('#agentList .agent-row', { timeout: 30000 });
    await page.evaluate(installController);

    // ---- Intro card ----
    await card(
      '<div class="logo"><span>Kairune</span></div>' +
        '<h1 class="ttl">The trust layer for<br/><b>agents that spend</b></h1>',
      'live console walkthrough',
      true
    );
    await sleep(2600);
    await card('', '', false);
    await sleep(900);

    // ---- Step 1: the registry ----
    await cap('01', 'A live registry of agents, ranked by trust score');
    await sleep(2600);
    await moveTo('#agentList .agent-row:nth-child(1)', 700);
    await sleep(1400);

    // ---- Step 2: open register ----
    await cap('02', 'Register a new agent — no wallet needed');
    await sleep(1400);
    await click('#openCreate');
    await page.waitForSelector('#createModal', { state: 'visible', timeout: 5000 });
    await sleep(1200);

    // ---- Step 3: fill the form ----
    await cap('03', 'Give it a handle and an identity');
    await moveTo('input[name="handle"]', 650);
    await type('input[name="handle"]', handle);
    await sleep(500);
    await moveTo('input[name="wallet"]', 550);
    await type('input[name="wallet"]', wallet);
    await sleep(500);
    await moveTo('input[name="operator"]', 550);
    await type('input[name="operator"]', 'Helios Labs');
    await sleep(900);

    // ---- Step 4: submit ----
    await cap('04', 'Every new agent starts at a neutral baseline of 120');
    await sleep(700);
    await click('#createForm button[type="submit"]', 650);
    await page.waitForSelector('#createModal', { state: 'hidden', timeout: 15000 });
    await page
      .locator('#agentList .agent-row')
      .filter({ hasText: handle })
      .waitFor({ timeout: 15000 });
    await sleep(1600);

    // ---- Step 5: select the new agent ----
    await cap('05', 'Open the agent to inspect its trust profile');
    const row = '#agentList .agent-row:has-text("' + handle + '")';
    await click(row, 850);
    await page.waitForSelector('#detailBody:not([hidden])', { timeout: 10000 });
    await sleep(2200);

    // ---- Step 6: the score breakdown ----
    await cap('06', 'Score, tier and a transparent breakdown');
    await moveTo('#detailBody .score-ring', 800);
    await sleep(2400);

    // ---- Step 7: record attestations, score moves live ----
    await cap('07', 'Record real behavior — the score updates live');
    await sleep(800);
    for (let i = 0; i < 3; i++) {
      await click('#attActions .chip:has-text("clean_payment")', 600);
      await sleep(1200);
    }
    await moveTo('#detailBody .score-ring', 700);
    await sleep(2200);

    // ---- Step 8: an established agent ----
    await cap('08', 'Here is what an established, trusted agent looks like');
    await click('#agentList .agent-row:has-text("voyager-07")', 850);
    await page.waitForSelector('#detailBody:not([hidden])', { timeout: 10000 });
    await sleep(2400);

    // ---- Step 9: grant scoped permission, capped by tier ----
    await cap('09', 'Grant scoped spending — auto-capped by trust tier');
    await moveTo('#grantForm input[name="ceiling"]', 700);
    await retype('#grantForm input[name="ceiling"]', '99999');
    await sleep(700);
    await click('#grantForm button[type="submit"]', 600);
    await sleep(2600);
    await cap('', '');
    await sleep(500);

    // ---- Outro card ----
    await card(
      '<h1 class="ttl">Trust, made <b>verifiable</b>.</h1>',
      'try the live console at <em>kairune.online/app</em>',
      true
    );
    await sleep(3000);
  } catch (err) {
    console.error('[record] flow error:', err.message);
  }

  await context.close();
  await browser.close();

  const files = (await readdir(OUT_DIR)).filter((f) => f.endsWith('.webm'));
  if (!files.length) throw new Error('No video file recorded');
  const rawWebm = join(OUT_DIR, files[0]);

  // Single clean encode: constant 30fps, 1080p, high quality, faststart for web.
  execSync(
    `ffmpeg -y -i "${rawWebm}" -vf "scale=${W}:${H}:flags=lanczos,fps=30" ` +
      `-c:v libx264 -crf 19 -preset slow -pix_fmt yuv420p -movflags +faststart -an "${FINAL_MP4}"`,
    { stdio: 'inherit' }
  );
  await unlink(rawWebm).catch(() => {});

  const size = execSync(`du -h "${FINAL_MP4}"`).toString().trim().split('\t')[0];
  const dur = execSync(
    `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${FINAL_MP4}"`
  )
    .toString()
    .trim();
  console.log('[record] saved', FINAL_MP4, size, `duration=${dur}s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
