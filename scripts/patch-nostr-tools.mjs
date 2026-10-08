/**
 * nostr-tools 1.x hands every incoming relay message to a queue and drains it
 * with `setInterval(handleNext, 0)` — one message per timer tick. Browsers
 * slow timers down in a tab that is not in front: to one tick a second, and
 * after five minutes to one a minute. Messages keep arriving from every relay
 * at network speed, the queue is never drained, and it grows until the tab is
 * closed. Measured in a user's own session: the page heap flat for twenty-five
 * minutes, then climbing 72MB a minute, every other figure the app records
 * standing still — 7.8GB after two hours, and 11GB once.
 *
 * This drains the queue through a MessageChannel instead. A posted message is
 * an ordinary task, not a timer, and is not slowed down in the background.
 * Each turn works through the queue for up to 8ms and then yields, so a burst
 * cannot freeze the page, and posts itself another turn if anything is left.
 *
 * Applied after every install (see "postinstall" in package.json), to every
 * build of the library that ships in the package. Idempotent: a file that
 * already carries the marker is left alone, and a file whose code no longer
 * matches — a different nostr-tools version — is reported, not guessed at.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'nostr-tools', 'lib');
const MARKER = 'razr: drained through a MessageChannel';

const FILES = ['esm/index.js', 'esm/relay.js', 'esm/pool.js', 'cjs/index.js', 'cjs/relay.js', 'cjs/pool.js'];

// The original: one message per timer tick
const ORIGINAL = /ws\.onmessage = \(e\) => \{\s*incomingMessageQueue\.enqueue\(e\.data\);\s*if \(!handleNextInterval\) \{\s*handleNextInterval = setInterval\(handleNext, 0\);\s*\}\s*\};/;

const REPLACEMENT = `/* ${MARKER} — see scripts/patch-nostr-tools.mjs */
      const razrNow = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
      const razrChannel = new MessageChannel();
      let razrScheduled = false;
      const razrSchedule = () => {
        if (razrScheduled) return;
        razrScheduled = true;
        razrChannel.port2.postMessage(0);
      };
      razrChannel.port1.onmessage = () => {
        razrScheduled = false;
        const until = razrNow() + 8;
        while (incomingMessageQueue.size > 0 && razrNow() < until) handleNext();
        if (incomingMessageQueue.size > 0) razrSchedule();
      };
      ws.onmessage = (e) => {
        incomingMessageQueue.enqueue(e.data);
        razrSchedule();
      };
      ws.addEventListener?.("close", () => {
        try { razrChannel.port1.close(); } catch {}
      });`;

let patched = 0;
let already = 0;
const missing = [];

for (const file of FILES) {
  const path = join(root, file);
  if (!existsSync(path)) continue;
  const source = readFileSync(path, 'utf8');
  if (source.includes(MARKER)) { already++; continue; }
  if (!ORIGINAL.test(source)) { missing.push(file); continue; }
  writeFileSync(path, source.replace(new RegExp(ORIGINAL.source, 'g'), REPLACEMENT));
  patched++;
}

console.log(`[patch-nostr-tools] patched ${patched}, already patched ${already}` +
  (missing.length ? `, NOT MATCHED: ${missing.join(', ')}` : ''));
if (missing.length && patched + already === 0) process.exitCode = 1;
