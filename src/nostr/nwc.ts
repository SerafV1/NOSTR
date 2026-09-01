import { finalizeEvent } from 'nostr-tools-v2';
import { NostrCrypto } from './crypto';
import { NostrEventSigned } from '../types';
import { invoiceAmountMsats } from '../utils/bolt11';

/**
 * Nostr Wallet Connect (NIP-47): paying from the client with a wallet that
 * lives somewhere else.
 *
 * The user's wallet hands out a connection string holding a relay, the
 * wallet service's pubkey, and a **secret key made for this app**. Requests
 * are kind 23194 events signed with that secret and encrypted to the
 * service; answers come back as kind 23195. The secret is a spending
 * credential, so everything here is arranged around a few rules:
 *
 * - it never leaves this browser, and is never published anywhere except as
 *   the signature on a request sent to the wallet's own relay;
 * - the wallet's relay is spoken to on a socket of its own. It is never
 *   added to the app's relay pool, so no other traffic reaches it and none
 *   of this traffic reaches anybody else's relay;
 * - nothing is ever paid that this app did not itself just fetch for a
 *   payment the user asked for, and the invoice's own amount is checked
 *   against what they chose before it is handed over;
 * - a payment is capped here as well as at the wallet. A budget set in the
 *   wallet is the real defence; these limits are the second one, for the
 *   case where this page is the thing that has gone wrong.
 */

const STORE = 'razr_wallet';
const LEDGER = 'razr_wallet_spent';

export interface WalletConnection {
  /** The wallet service's pubkey — the only author whose answers are read */
  walletPubkey: string;
  /** Where to talk to it. Nothing else is ever sent to these. */
  relays: string[];
  /** The key this app signs requests with. Spending money is what it is for. */
  secret: string;
  /** The wallet's own lightning address, if the string carried one */
  lud16?: string;
  addedAt: number;
  /** Refuse a single payment larger than this, whatever the wallet allows */
  perPayment: number;
  /** Refuse once this much has been paid from this browser today */
  perDay: number;
}

export interface WalletInfo {
  alias?: string;
  methods: string[];
  /** Which encryption the service understands (NIP-47 negotiation) */
  encryptions: string[];
}

const KIND = { info: 13194, request: 23194, response: 23195 } as const;

/** Defaults chosen to be small enough that a mistake is survivable */
export const DEFAULT_LIMITS = { perPayment: 10_000, perDay: 50_000 };

/** How long to wait for an answer. A payment can take a while to settle. */
const ANSWER_WITHIN_MS = 60_000;

// ---------------------------------------------------------------------------
// The connection string
// ---------------------------------------------------------------------------

const isHex64 = (value: string): boolean => /^[0-9a-f]{64}$/i.test(value);

/**
 * A relay this app is willing to open. `wss://` only — a `ws://` hop would
 * put a spending request on the wire in the clear — with an exception for a
 * wallet running on the same machine, where there is no wire.
 */
const usableRelay = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'wss:') return true;
    return parsed.protocol === 'ws:' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname.endsWith('.local'));
  } catch {
    return false;
  }
};

/**
 * Read a `nostr+walletconnect://` string, or say why it cannot be used.
 *
 * Nothing here is trusted for being in the string: the pubkey and the secret
 * have to be keys, and the relays have to be addresses this app would open.
 */
export function parseConnection(uri: string): Omit<WalletConnection, 'addedAt' | 'perPayment' | 'perDay'> {
  const trimmed = uri.trim();
  const scheme = /^nostr\+walletconnect:\/\/|^nostrwalletconnect:\/\//i;
  if (!scheme.test(trimmed)) {
    throw new Error('That is not a wallet connection string — it should start with nostr+walletconnect://');
  }

  // The pubkey sits where a hostname would, which URL parsing lowercases for
  // us; everything else is ordinary query parameters
  const asUrl = new URL(trimmed.replace(scheme, 'https://'));
  const walletPubkey = asUrl.hostname;
  if (!isHex64(walletPubkey)) throw new Error('The wallet key in that string is not a valid pubkey');

  const secret = asUrl.searchParams.get('secret') || '';
  if (!isHex64(secret)) throw new Error('The secret in that string is not a valid key');

  const relays = asUrl.searchParams.getAll('relay').filter(usableRelay);
  if (relays.length === 0) {
    throw new Error('That string names no relay this app can open — a wallet relay has to be wss://');
  }

  const lud16 = asUrl.searchParams.get('lud16') || undefined;
  // Keys are compared and hashed as written, so they are written one way
  return { walletPubkey: walletPubkey.toLowerCase(), relays, secret: secret.toLowerCase(), lud16 };
}

// ---------------------------------------------------------------------------
// What this browser holds
// ---------------------------------------------------------------------------

export function heldWallet(): WalletConnection | null {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return null;
    const held = JSON.parse(raw) as WalletConnection;
    if (!isHex64(held.walletPubkey) || !isHex64(held.secret)) return null;
    return {
      ...held,
      relays: (held.relays || []).filter(usableRelay),
      perPayment: held.perPayment || DEFAULT_LIMITS.perPayment,
      perDay: held.perDay || DEFAULT_LIMITS.perDay
    };
  } catch {
    return null;
  }
}

export function forgetWallet(): void {
  localStorage.removeItem(STORE);
  // The day's spending stays. Disconnecting and connecting again is not a
  // way to be given a fresh daily allowance.
}

export function setLimits(limits: { perPayment: number; perDay: number }): void {
  const held = heldWallet();
  if (!held) return;
  localStorage.setItem(STORE, JSON.stringify({
    ...held,
    perPayment: Math.max(1, Math.floor(limits.perPayment)),
    perDay: Math.max(1, Math.floor(limits.perDay))
  }));
}

/** What has been paid from this browser today, in sats */
export function spentToday(): number {
  try {
    const ledger = JSON.parse(localStorage.getItem(LEDGER) || '{}') as { day?: string; sats?: number };
    return ledger.day === today() ? Number(ledger.sats) || 0 : 0;
  } catch {
    return 0;
  }
}

const today = (): string => new Date().toISOString().slice(0, 10);

const recordSpend = (sats: number): void => {
  localStorage.setItem(LEDGER, JSON.stringify({ day: today(), sats: spentToday() + sats }));
};

// ---------------------------------------------------------------------------
// Talking to the wallet
// ---------------------------------------------------------------------------

interface Answer {
  result_type?: string;
  result?: any;
  error?: { code?: string; message?: string };
}

/**
 * One request, one socket, one answer.
 *
 * The subscription goes up before the request does, or a wallet that answers
 * quickly would answer into nothing. Only an event of the right kind, signed
 * by the wallet service, naming this request in its `e` tag is read — a relay
 * can hand back anything it likes, and everything else it hands back here is
 * somebody else's business or an attempt at ours.
 */
async function ask(
  held: WalletConnection,
  method: string,
  params: Record<string, unknown>,
  encryption: 'nip44_v2' | 'nip04'
): Promise<Answer> {
  const body = JSON.stringify({ method, params });
  const content = encryption === 'nip44_v2'
    ? NostrCrypto.encryptNip44(body, held.secret, held.walletPubkey)
    : await NostrCrypto.encryptMessage(body, held.walletPubkey, held.secret);
  if (!content) throw new Error('Could not encrypt the request to the wallet');

  const request = finalizeEvent({
    kind: KIND.request,
    created_at: Math.floor(Date.now() / 1000),
    content,
    tags: [
      ['p', held.walletPubkey],
      ...(encryption === 'nip44_v2' ? [['encryption', 'nip44_v2']] : [])
    ]
  }, hexToBytes(held.secret));

  const event = await firstAnswer(held, request);

  const plaintext = encryption === 'nip44_v2'
    ? NostrCrypto.decryptNip44(event.content, held.secret, held.walletPubkey)
    : await NostrCrypto.decryptMessage(event.content, held.walletPubkey, held.secret);
  if (!plaintext) throw new Error('The wallet answered with something this app could not read');

  return JSON.parse(plaintext) as Answer;
}

/**
 * The wallet's relays, tried in turn on a socket of their own — never the
 * app's pool, which would put a spending request in front of every relay the
 * user happens to have.
 */
function firstAnswer(held: WalletConnection, request: NostrEventSigned): Promise<NostrEventSigned> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const sockets: WebSocket[] = [];

    const done = (event?: NostrEventSigned, error?: Error) => {
      if (settled) return;
      settled = true;
      sockets.forEach(socket => { try { socket.close(); } catch { /* already gone */ } });
      if (event) resolve(event); else reject(error || new Error('The wallet did not answer'));
    };

    const timer = setTimeout(
      () => done(undefined, new Error('The wallet did not answer in a minute. Check the wallet before paying again — the payment may still have gone through.')),
      ANSWER_WITHIN_MS
    );

    held.relays.forEach(url => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch {
        return;
      }
      sockets.push(socket);
      const subId = `nwc-${request.id.slice(0, 8)}`;

      socket.onopen = () => {
        socket.send(JSON.stringify(['REQ', subId, {
          kinds: [KIND.response],
          authors: [held.walletPubkey],
          '#e': [request.id]
        }]));
        socket.send(JSON.stringify(['EVENT', request]));
      };

      socket.onmessage = message => {
        let parsed: any[];
        try {
          parsed = JSON.parse(String(message.data));
        } catch {
          return;
        }
        if (parsed[0] !== 'EVENT' || parsed[1] !== subId) return;
        const event = parsed[2] as NostrEventSigned;
        // The filter is the relay's promise; this is the check
        if (event.kind !== KIND.response) return;
        if (event.pubkey !== held.walletPubkey) return;
        if (!event.tags.some(tag => tag[0] === 'e' && tag[1] === request.id)) return;
        if (!NostrCrypto.verifyEvent(event)) return;
        clearTimeout(timer);
        done(event);
      };

      socket.onerror = () => { /* another relay may still answer */ };
    });

    if (sockets.length === 0) {
      clearTimeout(timer);
      done(undefined, new Error('Could not open any of the wallet\'s relays'));
    }
  });
}

const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/.{1,2}/g) || []).map(byte => parseInt(byte, 16)));

/**
 * What the wallet says it can do. Read from its own announcement (kind
 * 13194) where there is one — that is also where it says which encryption it
 * understands, and guessing wrong there means every request comes back
 * unreadable.
 */
export async function walletInfo(held: WalletConnection): Promise<WalletInfo> {
  const announced = await new Promise<NostrEventSigned | null>(resolve => {
    let settled = false;
    const sockets: WebSocket[] = [];
    const done = (event: NostrEventSigned | null) => {
      if (settled) return;
      settled = true;
      sockets.forEach(socket => { try { socket.close(); } catch { /* already gone */ } });
      resolve(event);
    };
    const timer = setTimeout(() => done(null), 8000);

    held.relays.forEach(url => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch {
        return;
      }
      sockets.push(socket);
      socket.onopen = () => socket.send(JSON.stringify(['REQ', 'nwc-info', {
        kinds: [KIND.info], authors: [held.walletPubkey], limit: 1
      }]));
      socket.onmessage = message => {
        let parsed: any[];
        try {
          parsed = JSON.parse(String(message.data));
        } catch {
          return;
        }
        if (parsed[0] === 'EVENT' && parsed[2]?.pubkey === held.walletPubkey) {
          clearTimeout(timer);
          done(parsed[2] as NostrEventSigned);
        }
      };
      socket.onerror = () => { /* another relay may still have it */ };
    });
    if (sockets.length === 0) { clearTimeout(timer); done(null); }
  });

  const methods = (announced?.content || '').split(/\s+/).filter(Boolean);
  const encryptions = (announced?.tags.find(tag => tag[0] === 'encryption')?.[1] || '')
    .split(/\s+/).filter(Boolean);

  return {
    alias: announced?.tags.find(tag => tag[0] === 'alias')?.[1],
    methods,
    encryptions
  };
}

/** NIP-44 where the wallet has said it understands it, NIP-04 otherwise */
const schemeFor = (info: WalletInfo): 'nip44_v2' | 'nip04' =>
  info.encryptions.includes('nip44_v2') ? 'nip44_v2' : 'nip04';

let knownInfo: { pubkey: string; info: WalletInfo } | null = null;

async function infoFor(held: WalletConnection): Promise<WalletInfo> {
  if (knownInfo?.pubkey === held.walletPubkey) return knownInfo.info;
  const info = await walletInfo(held);
  knownInfo = { pubkey: held.walletPubkey, info };
  return info;
}

// ---------------------------------------------------------------------------
// What the app asks of it
// ---------------------------------------------------------------------------

/**
 * Save a connection, after checking it answers. A string that parses but
 * belongs to a wallet that is not there is worth finding out about now
 * rather than at the moment somebody tries to zap.
 */
export async function connectWallet(uri: string): Promise<{ connection: WalletConnection; info: WalletInfo }> {
  const parsed = parseConnection(uri);
  const connection: WalletConnection = {
    ...parsed,
    addedAt: Date.now(),
    ...DEFAULT_LIMITS
  };

  const info = await infoFor(connection);
  // get_info over the connection itself: an answer of any kind proves the
  // secret reached a wallet that is listening and could read it, which a
  // string that merely parses does not. Only silence is fatal — a wallet
  // that has no get_info still says so, and that is an answer.
  const answer = await ask(connection, 'get_info', {}, schemeFor(info));

  const methods: string[] = Array.isArray(answer.result?.methods) ? answer.result.methods : info.methods;
  if (methods.length && !methods.includes('pay_invoice')) {
    throw new Error('This connection is not allowed to pay invoices');
  }
  if (answer.error && !methods.length) {
    throw new Error(answer.error.message || 'The wallet refused this connection');
  }

  localStorage.setItem(STORE, JSON.stringify(connection));
  knownInfo = { pubkey: connection.walletPubkey, info: { ...info, methods, alias: answer.result?.alias || info.alias } };
  return { connection, info: knownInfo.info };
}

export async function walletBalanceSats(): Promise<number | null> {
  const held = heldWallet();
  if (!held) return null;
  const answer = await ask(held, 'get_balance', {}, schemeFor(await infoFor(held)));
  if (answer.error || typeof answer.result?.balance !== 'number') return null;
  // NIP-47 counts in millisats
  return Math.floor(answer.result.balance / 1000);
}

export interface PaymentOutcome {
  preimage?: string;
  feesPaidSats?: number;
}

/**
 * Pay an invoice this app just fetched, for an amount the user just chose.
 *
 * `expectedSats` is not a formality. The invoice comes back from somebody
 * else's server, and the only thing tying it to what was agreed is its own
 * amount — so that is read out of the invoice and compared before the wallet
 * is asked for anything. An invoice for a different amount, or for no amount
 * at all (payable for whatever the payer likes), is refused here.
 */
export async function payInvoice(invoice: string, expectedSats: number): Promise<PaymentOutcome> {
  const held = heldWallet();
  if (!held) throw new Error('No wallet is connected');

  if (!Number.isFinite(expectedSats) || expectedSats <= 0) {
    throw new Error('That is not an amount to pay');
  }

  const asked = invoiceAmountMsats(invoice);
  if (asked === null) {
    throw new Error('This invoice does not say what it is for, so this app will not pay it');
  }
  if (asked !== Math.round(expectedSats * 1000)) {
    throw new Error(
      `The invoice is for ${Math.round(asked / 1000).toLocaleString()} sats, not the ${expectedSats.toLocaleString()} you chose. Nothing was paid.`
    );
  }

  if (expectedSats > held.perPayment) {
    throw new Error(
      `That is over the ${held.perPayment.toLocaleString()} sat limit set for this browser. Raise it in Settings if you meant it.`
    );
  }
  const already = spentToday();
  if (already + expectedSats > held.perDay) {
    throw new Error(
      `That would pass the ${held.perDay.toLocaleString()} sats a day set for this browser (${already.toLocaleString()} so far). Raise it in Settings if you meant it.`
    );
  }

  const answer = await ask(held, 'pay_invoice', { invoice }, schemeFor(await infoFor(held)));
  if (answer.error) {
    throw new Error(answer.error.message || 'The wallet refused the payment');
  }
  if (!answer.result?.preimage) {
    throw new Error('The wallet did not confirm the payment');
  }

  recordSpend(expectedSats);
  return {
    preimage: answer.result.preimage,
    feesPaidSats: typeof answer.result.fees_paid === 'number'
      ? Math.round(answer.result.fees_paid / 1000)
      : undefined
  };
}

/** Whether a zap can be paid from here without asking anyone for anything */
export const walletCanPay = (): boolean => Boolean(heldWallet());
