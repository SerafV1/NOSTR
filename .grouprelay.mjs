// A relay that lives for the length of one test, on this machine only.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { finishEvent, getPublicKey, nip19 } from 'nostr-tools';

const TWITCH_NADDR = 'naddr1qpqrve3nxd3nvdfjv33rzcejxa3k2efexq6kycehv3sngcejvdnxyd34vyukvv3sxyurqwr989nxyef589jrzv3sxv6kgvm9xcmngwp3x5qs6amnwvaz7tmwdaejumr0dspzqmencefdk8p8em5st0ra5npvldj6nuspsz8fl0jf6ysrt5lxwjq4qvzqqqrkvu4jaw8v';
const key = (n) => n.toString(16).padStart(2, '0').repeat(32);
const ME = key(1);                      // the reader
const AUTHOR = key(0xa1), REPOSTER = key(0xb2), QUOTER = key(0xc3);
const pk = (k) => getPublicKey(k);
const now = Math.floor(Date.now() / 1000);

const NJUMP = 'https://njump.to/nevent1qqsrlc5pgd7v6q9kgu7ntq9j6dnx2ntpqkhurmsfckc4y5e2gqjg8fqpzamhxue69uhhyetvv9ujuurjd9kkzmpwdejhgtczyqm4eyhh06cu0z0229j363kdwkq9gjy0llrqf3j25qcnrmpyu6qxqqcyqqqqqqgeuwrsw';
const STREAM_A = '30311:6f33c652db1c27cee905bc7da4c2cfb65a9f201808e9fbe49d12035d3e674815:6f33c652db1c27cee905bc7da4c2cfb65a9f201808e9fbe49d12035d3e674815';

const noteA = finishEvent({ kind: 1, created_at: now - 60, tags: [], content: `Twitch stream\n\nnostr:${TWITCH_NADDR}` }, AUTHOR);
const noteNjump = finishEvent({ kind: 1, created_at: now - 45, tags: [], content: `pogledaj ovo ${NJUMP}` }, AUTHOR);
const chatNjump = finishEvent({ kind: 1311, created_at: now - 40, tags: [['a', STREAM_A, '', 'root']], content: `evo ga ${NJUMP}` }, QUOTER);
const repost = finishEvent({ kind: 6, created_at: now - 30, tags: [['e', noteA.id], ['p', noteA.pubkey]], content: JSON.stringify(noteA) }, REPOSTER);
const quote = finishEvent({ kind: 1, created_at: now - 20, tags: [['q', noteA.id], ['p', noteA.pubkey]],
  content: `vredi pogledati\n\nnostr:${nip19.neventEncode({ id: noteA.id, author: noteA.pubkey })}` }, QUOTER);
const follows = finishEvent({ kind: 3, created_at: now - 3600, tags: [pk(AUTHOR), pk(REPOSTER), pk(QUOTER)].map(p => ['p', p]), content: '' }, ME);
const EMOJI_URL = 'https://cdn.nostrcheck.me/47187aea05279ed27482448680d3e6a4d5e1b1f27b0e4d0e4c1c9b7c0d5e9f01.png';
const profiles = [[AUTHOR, 'Author :flame: One'], [REPOSTER, 'Reposter'], [QUOTER, 'Quoter']].map(([k, name]) =>
  finishEvent({
    kind: 0,
    created_at: now - 3600,
    tags: k === AUTHOR ? [['emoji', 'flame', EMOJI_URL]] : [],
    content: JSON.stringify({ name, display_name: name, about: 'test' })
  }, k));

const replyToA = finishEvent({ kind: 1, created_at: now - 50, tags: [['e', noteA.id, '', 'root'], ['p', pk(AUTHOR)]], content: 'prvi odgovor' }, REPOSTER);
const GROUP_ID = 'razr-test';
const groupMeta = finishEvent({ kind: 39000, created_at: now - 7200,
  content: '',
  tags: [['d', GROUP_ID], ['name', 'RAZR test grupa'], ['about', 'samo za proveru'], ['public'], ['open']] }, AUTHOR);
const groupMembers = finishEvent({ kind: 39002, created_at: now - 7200,
  content: '',
  tags: [['d', GROUP_ID], ['p', pk(AUTHOR)], ['p', pk(REPOSTER)], ['p', pk(ME)]] }, AUTHOR);
const groupChat = [
  finishEvent({ kind: 9, created_at: now - 600, tags: [['h', GROUP_ID]], content: 'prva poruka u grupi' }, AUTHOR),
  finishEvent({ kind: 9, created_at: now - 300, tags: [['h', GROUP_ID]], content: 'druga poruka' }, REPOSTER),
];
let store = [groupMeta, groupMembers, ...groupChat, noteA, replyToA, noteNjump, chatNjump, repost, quote, follows, ...profiles];
const matches = (f, e) =>
  (!f.kinds || f.kinds.includes(e.kind)) &&
  (!f.authors || f.authors.includes(e.pubkey)) &&
  (!f.ids || f.ids.includes(e.id)) &&
  (!f['#e'] || e.tags.some(t => t[0] === 'e' && f['#e'].includes(t[1]))) &&
  (!f['#a'] || e.tags.some(t => t[0] === 'a' && f['#a'].includes(t[1]))) &&
  (!f['#p'] || e.tags.some(t => t[0] === 'p' && f['#p'].includes(t[1]))) &&
  (!f.since || e.created_at >= f.since) && (!f.until || e.created_at <= f.until);

// A websocket server small enough to not need a dependency: handshake, then
// text frames in and out
const send = (sock, text) => {
  const body = Buffer.from(text);
  const head = body.length < 126
    ? Buffer.from([0x81, body.length])
    : body.length < 65536
      ? Buffer.concat([Buffer.from([0x81, 126]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(body.length); return b; })()])
      : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(body.length)); return b; })()]);
  sock.write(Buffer.concat([head, body]));
};

const server = createServer();
server.on('upgrade', (req, sock) => {
  const accept = createHash('sha1')
    .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);

  let buf = Buffer.alloc(0);
  sock.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f, offset = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
      const masked = (buf[1] & 0x80) !== 0;
      const mask = masked ? buf.subarray(offset, offset + 4) : null;
      if (masked) offset += 4;
      if (buf.length < offset + len) return;
      const payload = Buffer.from(buf.subarray(offset, offset + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buf = buf.subarray(offset + len);
      if (opcode === 8) { sock.end(); return; }
      if (opcode !== 1) continue;

      let msg;
      try { msg = JSON.parse(payload.toString()); } catch { continue; }
      if (msg[0] === 'REQ') {
        const [, subId, ...filters] = msg;
        let hits = 0;
        for (const e of store) if (filters.some(f => matches(f, e))) { hits++; send(sock, JSON.stringify(['EVENT', subId, e])); }
        console.error('REQ', JSON.stringify(filters).slice(0, 220), '->', hits);
        send(sock, JSON.stringify(['EOSE', subId]));
      }
      if (msg[0] === 'EVENT') {
        const e = msg[1];
        console.error('PRIMLJENO kind', e.kind, 'tags', JSON.stringify(e.tags), JSON.stringify(String(e.content).slice(0, 40)));
        store.push(e);
        send(sock, JSON.stringify(['OK', e.id, true, '']));
      }
    }
  });
  sock.on('error', () => {});
});
server.listen(7447);
console.log(JSON.stringify({ me: pk(ME), noteA: noteA.id, replyToA: replyToA.id, noteNjump: noteNjump.id, repost: repost.id, quote: quote.id }));
