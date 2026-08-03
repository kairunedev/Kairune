/**
 * Log in to Virtuals from the terminal and cache a user token.
 *
 * Why this exists: PUT /agents/offerings on the ACP registry is a USER-scoped
 * route. An agent token from /auth/agent authenticates but is rejected there,
 * so a user session token is required — and the ACP SDK has no user-login route.
 * Rather than copy-pasting a JWT out of browser devtools, this reproduces the
 * same login the web app does, against Privy's public auth API.
 *
 * Flow (email OTP — Virtuals has email_auth enabled):
 *   1. POST auth.privy.io/api/v1/passwordless/init         -> emails you a code
 *   2. POST auth.privy.io/api/v1/passwordless/authenticate -> Privy JWT (~1h)
 *   3. POST api2.virtuals.io/wallet/auth/privy             -> Virtuals token (7d)
 *
 * Flow (wallet / SIWE) — use --wallet if you log in to Virtuals with a wallet:
 *   1. POST auth.privy.io/api/v1/siwe/init                 -> nonce
 *   2. you sign the printed message in your wallet
 *   3. POST auth.privy.io/api/v1/siwe/authenticate         -> Privy JWT
 *   4. exchange as above
 *
 * The resulting token is written to .virtuals-session.json (gitignored, 0600).
 * register-offering.mjs picks it up automatically — no env var needed.
 *
 * Usage:
 *   node login.mjs                  # email OTP (default)
 *   node login.mjs --wallet         # sign-in with Ethereum instead
 *   node login.mjs --status         # show cached token state, don't log in
 *   node login.mjs --logout         # delete the cached token
 */
import { createInterface } from 'readline/promises';
import { stdin, stdout } from 'process';
import { writeFileSync, readFileSync, existsSync, unlinkSync, chmodSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SESSION_FILE = join(HERE, '.virtuals-session.json');

const PRIVY = 'https://auth.privy.io/api/v1';
const APP_ID = process.env.VIRTUALS_PRIVY_APP_ID || 'cltsev9j90f67yhyw4sngtrpv';
const API2 = process.env.VIRTUALS_API2_BASE || 'https://api2.virtuals.io';

const privyHeaders = {
  'Content-Type': 'application/json',
  'privy-app-id': APP_ID,
  // The web app sends these; Privy uses them for client attribution.
  'privy-client': 'react-auth:1.92.0',
};

async function post(url, body, headers = privyHeaders) {
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok) {
    const msg = json?.error || json?.message || text.slice(0, 200);
    const err = new Error(`${res.status} ${res.statusText}: ${msg}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// ---------------------------------------------------------------------------
// Session cache
// ---------------------------------------------------------------------------

/** Decode a JWT payload without verifying — only to read `exp` for display. */
function jwtExp(token) {
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return p.exp ? p.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function readSession() {
  if (!existsSync(SESSION_FILE)) return null;
  try {
    return JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveSession(session) {
  writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
  chmodSync(SESSION_FILE, 0o600); // owner-only: this is a credential
}

/** Mask a token for logging. Never print the whole thing. */
export const mask = (t) => (t ? `${t.slice(0, 8)}…${t.slice(-6)} (${t.length} chars)` : '(none)');

function describe(session) {
  if (!session?.accessToken) return 'no cached session';
  const exp = jwtExp(session.accessToken);
  if (!exp) return `cached token ${mask(session.accessToken)} — no exp claim`;
  const mins = Math.round((exp - Date.now()) / 60000);
  const when = new Date(exp).toISOString().replace('T', ' ').slice(0, 16);
  return mins > 0
    ? `cached token ${mask(session.accessToken)} — valid ${mins} min (until ${when} UTC)`
    : `cached token EXPIRED ${Math.abs(mins)} min ago (at ${when} UTC)`;
}

export function sessionIsFresh(session, marginMs = 60_000) {
  const exp = session?.accessToken ? jwtExp(session.accessToken) : null;
  // No exp claim: assume usable and let the API be the judge.
  if (!exp) return Boolean(session?.accessToken);
  return exp - Date.now() > marginMs;
}

// ---------------------------------------------------------------------------
// Step 3: Privy JWT -> Virtuals token
// ---------------------------------------------------------------------------
export async function exchangePrivyToken(privyToken) {
  const json = await post(
    `${API2}/wallet/auth/privy`,
    { accessToken: privyToken },
    { 'Content-Type': 'application/json' },
  );
  const token = json?.data?.accessToken;
  if (!token) throw new Error('exchange returned no accessToken');
  return token;
}

// ---------------------------------------------------------------------------
// Login: email OTP
// ---------------------------------------------------------------------------
async function loginEmail(rl) {
  const email = (await rl.question('Email Virtuals lo: ')).trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error(`bukan email valid: ${email}`);

  process.stdout.write('\nngirim kode ke inbox lo… ');
  await post(`${PRIVY}/passwordless/init`, { email });
  console.log('terkirim.');
  console.log('(cek inbox — subject-nya dari Virtuals Protocol / Privy)\n');

  for (let attempt = 1; attempt <= 3; attempt++) {
    const code = (await rl.question('Kode 6 digit: ')).trim().replace(/\s+/g, '');
    try {
      const json = await post(`${PRIVY}/passwordless/authenticate`, { email, code });
      const privyToken = json?.token || json?.identity_token || json?.access_token;
      if (!privyToken) throw new Error('Privy ga balikin token');
      return { privyToken, identity: email };
    } catch (err) {
      if (err.status === 422 && attempt < 3) {
        console.log(`  kode salah / expired — coba lagi (${attempt}/3)\n`);
        continue;
      }
      throw err;
    }
  }
  throw new Error('kode salah 3x, berhenti');
}

// ---------------------------------------------------------------------------
// Login: wallet (SIWE)
// ---------------------------------------------------------------------------
async function loginWallet(rl) {
  const address = (await rl.question('Address wallet lo (0x…): ')).trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error(`bukan address valid: ${address}`);

  const chainId = process.env.VIRTUALS_SIWE_CHAIN_ID || '8453';
  const { nonce } = await post(`${PRIVY}/siwe/init`, { address });

  const issuedAt = new Date().toISOString();
  const message = [
    `app.virtuals.io wants you to sign in with your Ethereum account:`,
    address,
    ``,
    `By signing, you are proving you own this wallet and logging in. This does not initiate a transaction or cost any fees.`,
    ``,
    `URI: https://app.virtuals.io`,
    `Version: 1`,
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Resources:`,
    `- https://privy.io`,
  ].join('\n');

  console.log('\n--- tanda tangan pesan ini di wallet lo (persis, jangan diubah) ---');
  console.log(message);
  console.log('--- end ---\n');
  console.log('Cara: MetaMask > buka console dapp, atau pake tool signing apapun.');
  console.log('Di devtools browser yg ada wallet-nya:\n');
  console.log('  await window.ethereum.request({method:"personal_sign",params:[');
  console.log('    ' + JSON.stringify(message) + ',');
  console.log(`    "${address}"]})\n`);

  const signature = (await rl.question('Signature (0x…): ')).trim();
  if (!/^0x[a-fA-F0-9]+$/.test(signature)) throw new Error('signature harus hex 0x…');

  const json = await post(`${PRIVY}/siwe/authenticate`, {
    message,
    signature,
    chainId: `eip155:${chainId}`,
  });
  const privyToken = json?.token || json?.identity_token || json?.access_token;
  if (!privyToken) throw new Error('Privy ga balikin token');
  return { privyToken, identity: address };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--status')) {
    console.log(describe(readSession()));
    console.log(`file: ${SESSION_FILE}`);
    return;
  }

  if (argv.includes('--logout')) {
    if (existsSync(SESSION_FILE)) {
      unlinkSync(SESSION_FILE);
      console.log('session dihapus.');
    } else {
      console.log('ga ada session tersimpan.');
    }
    return;
  }

  const existing = readSession();
  if (existing && sessionIsFresh(existing) && !argv.includes('--force')) {
    console.log(describe(existing));
    console.log('\nmasih valid — ga perlu login lagi. Pake --force kalau mau ganti akun.');
    return;
  }

  console.log(`Login Virtuals (app ${APP_ID})`);
  console.log(existing ? `${describe(existing)}\n` : '');

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const { privyToken, identity } = argv.includes('--wallet')
      ? await loginWallet(rl)
      : await loginEmail(rl);

    console.log('\nPrivy OK   :', mask(privyToken));
    process.stdout.write('nuker ke token Virtuals… ');
    const accessToken = await exchangePrivyToken(privyToken);
    console.log('OK');
    console.log('Virtuals   :', mask(accessToken));

    saveSession({ accessToken, identity, createdAt: new Date().toISOString() });
    console.log(`\ndisimpan   : ${SESSION_FILE} (chmod 600, gitignored)`);
    console.log(describe(readSession()));
    console.log('\nlanjut:  node --env-file=.env register-offering.mjs --apply');
  } finally {
    rl.close();
  }
}

// Only run when invoked directly, so register-offering.mjs can import the helpers.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`\nlogin gagal: ${err.message}`);
    process.exit(1);
  });
}
