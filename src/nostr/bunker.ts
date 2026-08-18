import * as nostrTools from 'nostr-tools';
import { NostrEvent, NostrEventSigned } from '../types';

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
const RPC_KIND = 24133;

// The signer prompts a person on another device, so this has to allow for
// them picking up the phone — but not hang forever if they don't.
const REQUEST_TIMEOUT_MS = 90_000;

interface BunkerSession {
  /** Ephemeral key this browser talks to the signer with — never the user's */
  clientSecret: string;
  clientPubkey: string;
  /** The signer's own pubkey, from the bunker:// URI */
  remotePubkey: string;
  relays: string[];
  secret?: string;
  /** The account being signed for, learned from the signer */
  userPubkey?: string;
}

interface PendingCall {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let relay: any = null;
let subscription: any = null;
const pending = new Map<string, PendingCall>();

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
};

export const clearSession = (): void => {
  localStorage.removeItem(SESSION_KEY);
  try {
    subscription?.unsub();
    relay?.close();
  } catch {
    // already gone
  }
  relay = null;
  subscription = null;
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

const decrypt = async (session: BunkerSession, content: string): Promise<string> =>
  (nostrTools as any).nip04.decrypt(session.clientSecret, session.remotePubkey, content);

const encrypt = async (session: BunkerSession, content: string): Promise<string> =>
  (nostrTools as any).nip04.encrypt(session.clientSecret, session.remotePubkey, content);

const handleResponse = async (session: BunkerSession, event: NostrEventSigned): Promise<void> => {
  try {
    const plaintext = await decrypt(session, event.content);
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

/** Open (or reuse) the connection the signer listens on. */
const ensureConnected = async (session: BunkerSession): Promise<any> => {
  if (relay && relay.status === 1) return relay;

  let lastError: unknown = null;
  for (const url of session.relays) {
    try {
      const candidate = (nostrTools as any).relayInit(url);
      await candidate.connect();
      relay = candidate;
      subscription = candidate.sub([
        {
          kinds: [RPC_KIND],
          authors: [session.remotePubkey],
          '#p': [session.clientPubkey],
          // Only what comes after this point: older replies are answers to
          // requests that no longer exist
          since: Math.floor(Date.now() / 1000) - 10
        }
      ]);
      subscription.on('event', (event: NostrEventSigned) => handleResponse(session, event));
      return relay;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `Could not reach the signer's relay (${session.relays.join(', ')})${lastError ? '' : ''}`
  );
};

const call = async (session: BunkerSession, method: string, params: string[]): Promise<string> => {
  const connection = await ensureConnected(session);
  const id = Math.random().toString(36).slice(2);
  const payload = JSON.stringify({ id, method, params });

  const event = (nostrTools as any).finishEvent(
    {
      kind: RPC_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', session.remotePubkey]],
      content: await encrypt(session, payload)
    },
    session.clientSecret
  );

  const answer = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(
        `The signer did not answer the ${method} request. Open Amber and check it is still running as a bunker.`
      ));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
  });

  await connection.publish(event);
  return answer;
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
