// Measure every draft in a yap markdown file the way X counts characters:
// any URL counts as 23 chars, everything else is one weighted char.
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node brand/measure-tweets.mjs <file.md>');
  process.exit(1);
}
const src = readFileSync(file, 'utf8');

// Pull every fenced block plus the nearest preceding heading as its label.
const blocks = [];
let label = '(unlabelled)';
let inBlock = false;
let buf = [];
for (const line of src.split('\n')) {
  if (line.startsWith('#')) {
    if (!inBlock) label = line.replace(/^#+\s*/, '').trim();
    continue;
  }
  if (line.trim().startsWith('```')) {
    if (inBlock) {
      blocks.push({ label, text: buf.join('\n').trim() });
      buf = [];
    }
    inBlock = !inBlock;
    continue;
  }
  if (inBlock) buf.push(line);
}

const LIMIT = 280;
// X shortens every link to a fixed 23 chars, https:// or not.
const URL_RE = /\b(?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s]*)?/gi;

function weigh(text) {
  const urls = text.match(URL_RE) || [];
  let n = 0;
  const stripped = text.replace(URL_RE, '');
  for (const ch of stripped) n += 1; // no CJK in these drafts, so 1 each
  return n + urls.length * 23;
}

let over = 0;
for (const b of blocks) {
  const n = weigh(b.text);
  const ok = n <= LIMIT;
  if (!ok) over++;
  console.log(`${ok ? 'ok  ' : 'OVER'} ${String(n).padStart(3)}/${LIMIT}  ${b.label}`);
}
console.log(`\n${blocks.length} draft(s), ${over} over the limit.`);
if (over > 0) process.exit(1);
