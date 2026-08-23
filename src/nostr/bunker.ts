import * as nostrTools from 'nostr-tools';
// NIP-44 only. The nostr-tools this app is built on predates the final v2
// derivation, so its ciphertexts and a modern signer's don't interoperate —
// proven by cross-decrypting: same version byte, "invalid MAC". Rather than
// migrate the whole app's relay and signing API mid-flight, the modern
// implementation is brought in for this one job.
import { nip44 as modernNip44 } from 'nostr-tools-v2';
import { NostrEvent, NostrEventSigned } from '../types';
import { NostrCrypto } from './crypto';

/**
 * NIP-46: signing by talking to a remote signer over a relay.
 *
 * Unlike NIP-55 there is no hand-off to another app — a request goes out as
 * an encrypted event and the answer comes back the same way, so the page is
 * never left and nothing the browser does to external-app launches can
 * interfere. The signer (Amber in "nsec bunker" mode) holds the key and asks
 * its own user to approve.
 */

const SESSION_KEY = 'nostr_bunker_session';
// Which signer this browser knows, and the key it talks to it with. Kept
// across logout on purpose: generating a fresh key each time made the signer
// see a brand-new application and ask to replace the old one, when the
// pairing it already had was perfectly good.
const PAIRING_KEY = 'nostr_bunker_pairing';
const RPC_KIND = 24133;

// The signer prompts a person, who has to notice and approve — but a minute
// is long enough to conclude it isn't coming.
const REQUEST_TIMEOUT_MS = 60_000;

interface BunkerSession {
  /** Ephemeral key this browser talks to the signer with — never the user's */
  clientSecret: string;
  clientPubkey: string;
  /** The signer's own pubkey, from the bunker:// URI */
  remotePubkey: string;
  relays: string[];
  secret?: string;
  /** When the invitation was made, so a reopened subscription asks from there */
  since?: number;
  /** The account being signed for, learned from the signer */
  userPubkey?: string;
}

interface PendingCall {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * A written trail of the pairing.
 *
 * Everything here happens across an app switch: the browser goes to the
 * background, the signer answers, and whatever the console said in between is
 * gone by the time anyone can look. Kept in storage instead, so what happened
 * can be read after the fact — the only way to tell "no reply came" apart
 * from "a reply came and could not be used". Nothing in the app shows it:
 * it is here for the next pairing that goes nowhere, read from the browser's
 * own storage under this key.
 */
const TRAIL_KEY = 'nostr_signer_trail';

export const trail = (line: string): void => {
  try {
    const at = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const kept = JSON.parse(localStorage.getItem(TRAIL_KEY) || '[]') as string[];
    kept.push(`${at} ${line}`);
    localStorage.setItem(TRAIL_KEY, JSON.stringify(kept.slice(-40)));
  } catch {
    // Storage being unavailable must not break a login
  }
};

export const clearTrail = (): void => {
  try {
    localStorage.removeItem(TRAIL_KEY);
  } catch {
    // nothing to clear
  }
};

// Every reachable relay, not just the first: one being down was enough to
// leave an invitation with nowhere to be answered
let connections: any[] = [];
let subscriptions: any[] = [];
const pending = new Map<string, PendingCall>();

/**
 * How many signing requests are waiting on the signer. Without this a like
 * looks like it did nothing at all until the request times out a minute
 * later — the app is waiting, but says so nowhere.
 */
let waitingCount = 0;
const waitingListeners = new Set<(count: number) => void>();

export const onSigningWait = (listener: (count: number) => void): (() => void) => {
  waitingListeners.add(listener);
  listener(waitingCount);
  return () => waitingListeners.delete(listener);
};

const setWaiting = (delta: number): void => {
  waitingCount = Math.max(0, waitingCount + delta);
  waitingListeners.forEach(listener => listener(waitingCount));
};

export const readSession = (): BunkerSession | null => {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as BunkerSession) : null;
  } catch {
    return null;
  }
};

const writeSession = (session: BunkerSession): void => {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  writePairing(session);
};

interface BunkerPairing {
  clientSecret: string;
  clientPubkey: string;
  remotePubkey: string;
  relays: string[];
}

export const readPairing = (): BunkerPairing | null => {
  try {
    const raw = localStorage.getItem(PAIRING_KEY);
    return raw ? (JSON.parse(raw) as BunkerPairing) : null;
  } catch {
    return null;
  }
};

const writePairing = (session: BunkerSession): void => {
  if (!session.remotePubkey) return;
  localStorage.setItem(PAIRING_KEY, JSON.stringify({
    clientSecret: session.clientSecret,
    clientPubkey: session.clientPubkey,
    remotePubkey: session.remotePubkey,
    relays: session.relays
  }));
};

/** Forget the signer entirely — the next login pairs from scratch. */
export const forgetPairing = (): void => {
  localStorage.removeItem(PAIRING_KEY);
  clearSession();
};

/**
 * Log back in through a signer this browser is already paired with. No new
 * invitation, so nothing for the signer to replace: it recognises the same
 * application and only has to approve the request.
 */
export const reconnectBunker = async (): Promise<string> => {
  const pairing = readPairing();
  if (!pairing) throw new Error('This browser is not paired with a signer');

  const session: BunkerSession = { ...pairing };
  const userPubkey = await call(session, 'get_public_key', []);
  if (!/^[0-9a-f]{64}$/i.test(userPubkey)) {
    throw new Error('The signer answered without a usable public key');
  }
  session.userPubkey = userPubkey.toLowerCase();
  writeSession(session);
  return session.userPubkey;
};

export const clearSession = (): void => {
  localStorage.removeItem(SESSION_KEY);
  try {
    subscriptions.forEach(sub => sub.unsub());
    connections.forEach(conn => conn.close());
  } catch {
    // already gone
  }
  connections = [];
  subscriptions = [];
};

/**
 * bunker://<signer-pubkey>?relay=wss://…&relay=wss://…&secret=…
 */
export const parseBunkerUri = (uri: string): { remotePubkey: string; relays: string[]; secret?: string } | null => {
  const trimmed = uri.trim();
  if (!/^bunker:\/\//i.test(trimmed)) return null;

  try {
    // The pubkey sits where a host would, which URL() parses for us
    const url = new URL(trimmed.replace(/^bunker:\/\//i, 'https://'));
    const remotePubkey = url.hostname.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(remotePubkey)) return null;

    const relays = url.searchParams.getAll('relay').filter(Boolean);
    if (relays.length === 0) return null;

    const secret = url.searchParams.get('secret') || undefined;
    return { remotePubkey, relays, secret };
  } catch {
    return null;
  }
};

/**
 * NIP-46 moved from NIP-04 to NIP-44 encryption and signers are split across
 * both, so a reply must be tried each way: reading it with the wrong scheme
 * throws, and the reply then looks like noise and gets dropped — which is
 * indistinguishable from the signer never answering.
 */
const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/.{1,2}/g) || []).map(byte => parseInt(byte, 16)));

const modernKey = (session: BunkerSession, counterparty: string): Uint8Array =>
  modernNip44.v2.utils.getConversationKey(hexToBytes(session.clientSecret), counterparty);

const decrypt = async (session: BunkerSession, content: string, from: string): Promise<string> => {
  try {
    return modernNip44.v2.decrypt(content, modernKey(session, from));
  } catch {
    // fall through
  }
  try {
    // The older derivation, for a signer built against the same vintage
    return NostrCrypto.decryptNip44(content, session.clientSecret, from);
  } catch {
    // fall through
  }
  try {
    // Awaited on purpose: nip04.decrypt is async, and returning its promise
    // from inside the try means a rejection escapes this catch entirely —
    // which skipped everything below and reported the reply as unreadable
    return await (nostrTools as any).nip04.decrypt(session.clientSecret, from, content);
  } catch {
    // fall through
  }
  // Not every reply is encrypted — an auth_url, for one, may arrive as plain
  // JSON. Reading it as-is beats discarding it as unreadable.
  if (content.trimStart().startsWith('{')) return content;
  throw new Error(shapeOf(content));
};

/**
 * Describe an unreadable payload without printing it: the leading bytes say
 * which scheme it was meant to be, which is the one thing worth reporting.
 */
const shapeOf = (content: string): string => {
  if (content.includes('?iv=')) return 'looks like NIP-04 but would not decrypt';
  if (/^A[A-Za-z0-9+/]/.test(content)) return `looks like NIP-44 (starts "${content.slice(0, 6)}") but would not decrypt`;
  return `unrecognised format (starts "${content.slice(0, 10)}", ${content.length} chars)`;
};

const encrypt = async (session: BunkerSession, content: string, scheme: 'nip44' | 'nip04'): Promise<string> => {
  if (scheme === 'nip44') {
    return modernNip44.v2.encrypt(content, modernKey(session, session.remotePubkey));
  }
  return (nostrTools as any).nip04.encrypt(session.clientSecret, session.remotePubkey, content);
};

const handleResponse = async (session: BunkerSession, event: NostrEventSigned): Promise<void> => {
  try {
    const plaintext = await decrypt(session, event.content, event.pubkey);
    const message = JSON.parse(plaintext) as { id: string; result?: string; error?: string };
    const call = pending.get(message.id);
    if (!call) return; // not ours, or already timed out

    pending.delete(message.id);
    clearTimeout(call.timer);

    if (message.error) {
      call.reject(new Error(message.error));
      return;
    }
    // "auth_url" means the signer wants the user to visit a page first; it
    // isn't a result, so keep waiting for the real one
    if (message.result === 'auth_url') {
      pending.set(message.id, call);
      return;
    }
    call.resolve(message.result || '');
  } catch (error) {
    console.error('Could not read a reply from the signer:', error);
  }
};

/** Open (or reuse) every relay the signer might answer on. */
const ensureConnected = async (
  session: BunkerSession,
  onEvent?: (event: NostrEventSigned) => void,
  /** Drop what is open and dial again — for coming back from the signer app */
  reopen = false
): Promise<any[]> => {
  if (reopen) closeConnections();
  if (connections.length > 0) return connections;

  const filter = {
    kinds: [RPC_KIND],
    // No authors filter in the client-initiated flow: the signer's key isn't
    // known until it answers, and the secret is what proves who it is
    ...(session.remotePubkey ? { authors: [session.remotePubkey] } : {}),
    '#p': [session.clientPubkey],
    // From when the invitation was made, not from now: reopening after the
    // browser was in the background must not skip past the answer
    since: (session.since ?? Math.floor(Date.now() / 1000)) - 10
  };

  const attempts = await Promise.allSettled(
    session.relays.map(async url => {
      const candidate = (nostrTools as any).relayInit(url);
      await candidate.connect();
      const sub = candidate.sub([filter]);
      sub.on('event', (event: NostrEventSigned) => {
        handleResponse(session, event);
        onEvent?.(event);
      });
      subscriptions.push(sub);
      return candidate;
    })
  );

  connections = attempts
    .filter((a): a is PromiseFulfilledResult<any> => a.status === 'fulfilled')
    .map(a => a.value);

  const failed = attempts.filter(a => a.status === 'rejected').length;
  trail(`relays: ${connections.length} open, ${failed} refused`);

  if (connections.length === 0) {
    throw new Error(`Could not reach any of the signer's relays (${session.relays.join(', ')})`);
  }
  return connections;
};

/** Close every socket and subscription, so the next dial starts clean */
const closeConnections = (): void => {
  for (const sub of subscriptions) {
    try { sub.unsub(); } catch { /* already gone */ }
  }
  for (const relay of connections) {
    try { relay.close(); } catch { /* already gone */ }
  }
  subscriptions = [];
  connections = [];
};

const call = async (session: BunkerSession, method: string, params: string[]): Promise<string> => {
  const relays = await ensureConnected(session);
  const id = Math.random().toString(36).slice(2);
  const payload = JSON.stringify({ id, method, params });

  const sendWith = async (scheme: 'nip44' | 'nip04') => {
    const event = (nostrTools as any).finishEvent(
      {
        kind: RPC_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', session.remotePubkey]],
        content: await encrypt(session, payload, scheme)
      },
      session.clientSecret
    );
    // Sent on every reachable relay: which one the signer watches is unknown
    await Promise.allSettled(relays.map(relay => relay.publish(event)));
  };

  const answer = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(
        `Amber did not answer the ${method} request. Open Amber and check it is still connected to this app.`
      ));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
  });

  // Only signing is worth announcing: get_public_key answers in a moment and
  // has its own status line during pairing
  if (method === 'sign_event') {
    setWaiting(1);
    answer.finally(() => setWaiting(-1)).catch(() => {});
  }

  await sendWith('nip44');

  // A signer that only speaks the older scheme can't read what we just sent,
  // and silence looks the same as a slow user. Say it again the other way
  // rather than waiting out the whole timeout for nothing.
  const retry = setTimeout(() => {
    if (pending.has(id)) sendWith('nip04').catch(() => {});
  }, 12_000);
  answer.finally(() => clearTimeout(retry)).catch(() => {});

  return answer;
};

// Where the client listens for a signer coming to it. More than one, because
// a single unreachable relay leaves the invitation with nowhere to be
// answered — which is exactly what happened with damus.io refusing
// connections while it was the only one named here.
const CONNECT_RELAYS = ['wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.mom'];

/**
 * The other direction: this browser publishes an invitation and the signer
 * comes to it. Amber offers this as connecting an app, which is easier to
 * find than the bunker screen — and the signer's own key stays unknown to us
 * until it answers, so the secret is what proves the answer is genuine.
 */
/**
 * What the invitation asks to be allowed to sign — the signer presents this
 * and its user decides. Deliberately not "sign_event" on its own: that is
 * every kind there is, including replacing a contact list, and a signer
 * offered that has nothing meaningful to ask about.
 */
// What the invitation asks for. Kind-qualified entries ("sign_event:1") are
// what the spec suggests, but Amber answered the plain form and went quiet
// on the qualified one — and a permission request the signer won't show is
// worse for the user than a broad one it will.
export const EVERYDAY_PERMISSIONS = 'sign_event';

export const startNostrConnect = (
  onProgress?: (status: string) => void,
  perms?: string
): { uri: string; connected: Promise<string> } => {
  // A new key every time. Reusing one the signer already knows made it see an
  // application it was already connected to — nothing to confirm, so no
  // connect reply, and the page waited forever. Coming back to a signer you
  // are already paired with is reconnectBunker's job, not this one's.
  const clientSecret = (nostrTools as any).generatePrivateKey();
  const secret = Math.random().toString(36).slice(2, 12);
  const session: BunkerSession = {
    clientSecret,
    clientPubkey: (nostrTools as any).getPublicKey(clientSecret),
    remotePubkey: '', // learned from whoever answers
    relays: CONNECT_RELAYS,
    secret,
    since: Math.floor(Date.now() / 1000)
  };
  clearTrail();
  trail('invitation made');

  // relay is repeatable in the URI, so the signer can pick whichever it can
  // reach — the same reason we listen on all of them
  const params = new URLSearchParams({ secret, name: 'RAZR' });
  // Named so the signer can show what's being asked for; leaving it out gave
  // it nothing to present and the pairing simply sat there
  if (perms) params.append('perms', perms);
  for (const url of CONNECT_RELAYS) params.append('relay', url);
  const uri = `nostrconnect://${session.clientPubkey}?${params.toString()}`;

  // Set once the listener below exists; called from every path that ends the
  // wait, so a finished pairing does not leave a listener behind
  let stopWatchingForReturn = () => {};

  const connected = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        stopWatchingForReturn();
        trail('gave up waiting');
        reject(new Error('No signer connected. Paste the link into Amber and approve it there.'));
      },
      5 * 60 * 1000
    );

    const onSignerReply = async (event: NostrEventSigned) => {
      trail(`reply arrived from ${event.pubkey.slice(0, 8)}`);
      if (session.remotePubkey) return; // already paired
      onProgress?.('A signer answered — reading its reply…');
      let plaintext: string;
      try {
        plaintext = await decrypt(session, event.content, event.pubkey);
      } catch (error) {
        const why = error instanceof Error ? error.message : 'unknown';
        trail(`reply unreadable: ${why}`);
        onProgress?.(`A reply arrived but could not be read: ${why}`);
        return;
      }

      try {
        const message = JSON.parse(plaintext) as { result?: string; error?: string; auth_url?: string };

        // Some signers ask the user to approve on a web page first and send
        // the address to open; it isn't a refusal and isn't the answer either
        const authUrl = message.auth_url || (message.result === 'auth_url' ? message.error : undefined);
        if (authUrl) {
          onProgress?.('The signer wants approval in a browser page — opening it.');
          window.open(authUrl, '_blank', 'noopener');
          return;
        }

        if (message.error) {
          onProgress?.(`The signer refused: ${message.error}`);
          return;
        }

        // Being able to decrypt this at all means the sender did ECDH with
        // the ephemeral key that exists nowhere but in the invitation — so
        // whatever it answers, it is the signer the invitation went to.
        // Insisting on a particular `result` string only turned working
        // signers away, since implementations differ on what they send.
        if (message.result && message.result !== secret && message.result !== 'ack') {
          onProgress?.(`Signer answered "${message.result.slice(0, 24)}" — continuing.`);
        }

        clearTimeout(timer);
        stopWatchingForReturn();
        session.remotePubkey = event.pubkey;
        writeSession(session);
        trail('paired, asking which account');
        onProgress?.('Paired. Asking which account it signs for…');

        const userPubkey = await call(session, 'get_public_key', []);
        if (!/^[0-9a-f]{64}$/i.test(userPubkey)) {
          reject(new Error('The signer connected but did not return a usable public key'));
          return;
        }
        session.userPubkey = userPubkey.toLowerCase();
        writeSession(session);
        resolve(session.userPubkey);
      } catch (error) {
        onProgress?.(
          `Could not use the reply: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    };

    // Going to the signer means leaving the browser, and Android is free to
    // suspend a background tab — sockets included. Coming back to a dead
    // socket is what "still waiting" looks like when the signer answered
    // long ago, so the connection is remade the moment the page is in front
    // again, and the subscription asks from the invitation's own moment.
    const onReturn = () => {
      if (document.visibilityState !== 'visible' || session.remotePubkey) return;
      trail('back in the browser — reopening the connection');
      onProgress?.('Back in the browser — listening again…');
      ensureConnected(session, onSignerReply, true)
        .then(relays => onProgress?.(`Listening on ${relays.length} relay(s) for Amber…`))
        .catch(error => trail(`reopen failed: ${error instanceof Error ? error.message : 'unknown'}`));
    };
    document.addEventListener('visibilitychange', onReturn);
    stopWatchingForReturn = () => document.removeEventListener('visibilitychange', onReturn);

    ensureConnected(session, onSignerReply)
      .then(relays => {
        trail(`listening on ${relays.length} relay(s)`);
        onProgress?.(`Listening on ${relays.length} relay(s) for Amber…`);
      })
      .catch(error => {
      clearTimeout(timer);
      stopWatchingForReturn();
      trail(`could not listen: ${error instanceof Error ? error.message : 'unknown'}`);
      reject(error);
    });
  });

  return { uri, connected };
};

/**
 * Pair with a signer from the bunker:// URI it shows, and learn which
 * account it signs for.
 */
export const connectBunker = async (uri: string): Promise<string> => {
  const parsed = parseBunkerUri(uri);
  if (!parsed) {
    throw new Error('That is not a bunker:// link. Copy the one Amber shows under "nsec bunker".');
  }

  const clientSecret = (nostrTools as any).generatePrivateKey();
  const session: BunkerSession = {
    clientSecret,
    clientPubkey: (nostrTools as any).getPublicKey(clientSecret),
    remotePubkey: parsed.remotePubkey,
    relays: parsed.relays,
    secret: parsed.secret
  };

  await call(session, 'connect', [parsed.remotePubkey, parsed.secret || '']);
  const userPubkey = await call(session, 'get_public_key', []);
  if (!/^[0-9a-f]{64}$/i.test(userPubkey)) {
    throw new Error('The signer connected but did not return a usable public key');
  }

  session.userPubkey = userPubkey.toLowerCase();
  writeSession(session);
  return session.userPubkey;
};

/** Ask the signer to sign an event. Returns once its user has approved. */
export const bunkerSignEvent = async (template: NostrEvent & { pubkey?: string }): Promise<NostrEventSigned> => {
  const session = readSession();
  if (!session) throw new Error('No signer is paired with this browser');

  const unsigned = {
    kind: template.kind,
    created_at: Math.floor(Date.now() / 1000),
    tags: template.tags || [],
    content: template.content,
    pubkey: session.userPubkey
  };

  const result = await call(session, 'sign_event', [JSON.stringify(unsigned)]);

  try {
    const signed = JSON.parse(result) as NostrEventSigned;
    if (!signed.sig || !signed.id) throw new Error('incomplete');
    return signed;
  } catch {
    throw new Error('The signer replied with something that is not a signed event');
  }
};
