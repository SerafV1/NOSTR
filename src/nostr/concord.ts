import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { secp256k1, schnorr } from '@noble/curves/secp256k1';
import { nip44 as modernNip44 } from 'nostr-tools-v2';
import * as nostrTools from 'nostr-tools';
import { NostrEventSigned } from '../types';

/**
 * Concord: end-to-end encrypted communities, the protocol Armada runs and
 * Amethyst reads (CORD-01…08, concordprotocol.org).
 *
 * The idea in one line: a community is a **shared key** — holding it is
 * membership — plus a **signed roster** every client checks for itself. No
 * server decides who is in or who is in charge, and relays only ever carry
 * kind-1059 wraps addressed to a key nobody outside can even derive.
 *
 * This file is the floor everything else stands on: the frozen derivations
 * (CORD-02 Appendix A) and the private stream (CORD-01). Change a byte of a
 * label here and every address moves — which is why the spec calls them
 * frozen and why they are written out rather than guessed.
 */

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

export const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');

export const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/.{1,2}/g) || []).map(b => parseInt(b, 16)));

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const join = (...parts: Uint8Array[]): Uint8Array => {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) { all.set(part, at); at += part.length; }
  return all;
};

/** A u64, big-endian, as the info field wants it */
const epochBytes = (epoch: number): Uint8Array => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(epoch), false);
  return out;
};

const ZERO_ID = new Uint8Array(32);

// ---------------------------------------------------------------------------
// A.1–A.4: the frozen derivations
// ---------------------------------------------------------------------------

/**
 * A.4 — a community's identity is a commitment to whoever founded it, so
 * anybody holding an invite can recompute it and see the founder is who the
 * invite says. Forging a different owner onto one is a second preimage.
 */
export function communityId(ownerPubkey: string, salt: Uint8Array): Uint8Array {
  return sha256(join(utf8('concord/community'), fromHex(ownerPubkey), salt));
}

/**
 * A.1 — HKDF-SHA256 with an empty salt. The info field is laid out by hand
 * because its bytes are part of every address this produces:
 * `label || 0x00 || id[32] || epoch_be[8]`, and the epoch is the only field a
 * label may leave off.
 */
function derive(secret: Uint8Array, label: string, id: Uint8Array, epoch?: number, counter?: number): Uint8Array {
  const info = join(
    utf8(label),
    new Uint8Array([0]),
    id,
    epoch === undefined ? new Uint8Array(0) : epochBytes(epoch),
    counter === undefined ? new Uint8Array(0) : new Uint8Array([counter])
  );
  return hkdf(sha256, secret, new Uint8Array(0), info, 32);
}

export interface GroupKey {
  /** The stream's address: what an `authors` filter asks for */
  pubkey: string;
  /** Signs the wraps published there */
  privkey: Uint8Array;
  /** NIP-44 self-ECDH, which encrypts the wrap's content */
  convKey: Uint8Array;
}

/**
 * A.2 / A.3 — a labelled secret becomes a keypair, and that keypair is a
 * stream address. A seed that is not a valid scalar (about one in 2¹²⁸) is
 * retried with a counter byte appended, so two clients land on the same key
 * rather than diverging.
 */
export function groupKey(
  label: string,
  secret: Uint8Array,
  id: Uint8Array = ZERO_ID,
  epoch?: number
): GroupKey {
  let counter: number | undefined;
  for (let tries = 0; tries < 256; tries += 1) {
    const seed = derive(secret, label, id, epoch, counter);
    if (secp256k1.utils.isValidPrivateKey(seed)) {
      const pubkey = toHex(schnorr.getPublicKey(seed));
      return {
        pubkey,
        privkey: seed,
        convKey: modernNip44.v2.utils.getConversationKey(seed, pubkey)
      };
    }
    counter = counter === undefined ? 0 : counter + 1;
  }
  throw new Error('Could not derive a key for ' + label);
}

/** The labels this client uses, spelled once (CORD-02 A.6) */
export const LABEL = {
  channel: 'concord/channel',
  controlRead: 'concord/control',
  controlSigner: 'concord/control-signer',
  guestbook: 'concord/guestbook',
  grant: 'concord/grant',
  banlist: 'concord/banlist',
  dissolved: 'concord/dissolved'
} as const;

// ---------------------------------------------------------------------------
// CORD-01: the private stream
// ---------------------------------------------------------------------------

/** What a stream carries: the inner event somebody actually wrote */
export interface Rumor {
  id: string;
  pubkey: string;
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
  sig?: string;
}

export const KIND = {
  wrap: 1059,
  ephemeralWrap: 21059,
  sealEncrypted: 20013,
  sealPlaintext: 20014,
  message: 9,
  joinLeave: 3306,
  kick: 3309,
  controlEdition: 3308
} as const;

/**
 * Sub-second order. Nostr counts in whole seconds, and a room where three
 * people speak at once needs a stable order, so the remainder rides a tag and
 * every comparison in the protocol uses `created_at * 1000 + ms`.
 */
export const msTag = (at: number): string[] => ['ms', String(at % 1000)];

export const orderedAt = (rumor: Rumor): number => {
  const ms = Number(rumor.tags.find(t => t[0] === 'ms')?.[1] ?? 0);
  const withinRange = Number.isInteger(ms) && ms >= 0 && ms <= 999;
  return (rumor.created_at || 0) * 1000 + (withinRange ? ms : 0);
};

const signWith = (privkey: Uint8Array, event: { kind: number; content: string; tags: string[][]; created_at: number }): NostrEventSigned => {
  const pubkey = toHex(schnorr.getPublicKey(privkey));
  const unsigned = { ...event, pubkey };
  const id = (nostrTools as any).getEventHash(unsigned);
  const sig = toHex(schnorr.sign(fromHex(id), privkey));
  return { ...unsigned, id, sig } as NostrEventSigned;
};

/**
 * Wrap a rumor for a stream.
 *
 * NIP-59 hides the sender behind an ephemeral author and names the recipient
 * in a `p` tag; a stream turns that around — the author is the stream's own
 * key (which is the address), and the `p` tag is the throwaway. So it reads
 * as ordinary giftwrap traffic while everyone holding the key can find it.
 *
 * The seal is 20013 or 20014, never 13, so a relay cannot store the inside as
 * an event of its own. Which of the two is used is fixed per plane, never per
 * message: the Control Plane is plaintext-sealed because its editions get
 * re-wrapped into later epochs and a signature cannot survive re-encryption;
 * every other plane seals encrypted, so nothing said inside can be lifted out
 * and shown as a public event.
 *
 * `signAsAuthor` is the app's own signing path, so a key in an extension or a
 * signer app works here exactly as it does anywhere else.
 */
export async function wrapForStream(
  stream: GroupKey,
  rumor: Rumor,
  signAsAuthor: (event: { kind: number; content: string; tags: string[][]; created_at?: number }) => Promise<NostrEventSigned>,
  options: { plaintextSeal?: boolean; ephemeral?: boolean } = {}
): Promise<NostrEventSigned> {
  const sealContent = options.plaintextSeal
    ? JSON.stringify(rumor)
    : modernNip44.v2.encrypt(JSON.stringify(rumor), stream.convKey);

  // Signed by whoever wrote the rumor: that signature is the only thing in
  // here that says who spoke, and every reader checks it
  const seal = await signAsAuthor({
    kind: options.plaintextSeal ? KIND.sealPlaintext : KIND.sealEncrypted,
    content: sealContent,
    tags: [],
    created_at: rumor.created_at
  });

  return signWith(stream.privkey, {
    kind: options.ephemeral ? KIND.ephemeralWrap : KIND.wrap,
    content: modernNip44.v2.encrypt(JSON.stringify(seal), stream.convKey),
    tags: [ephemeralTag()],
    created_at: rumor.created_at
  });
}

/**
 * What a wrap carries, or nothing.
 *
 * Nothing is the ordinary case, not an error: a relay hands back whatever
 * sits at an address, and a wrap from another epoch, another plane, or plain
 * giftwrap traffic simply will not open with this key.
 */
export function readStreamEvent(event: NostrEventSigned, stream: GroupKey): Rumor | null {
  try {
    // The address is the point: a wrap signed by anything else is not this
    // stream's, whoever it claims to be from
    if (event.pubkey !== stream.pubkey) return null;

    const seal = JSON.parse(modernNip44.v2.decrypt(event.content, stream.convKey)) as NostrEventSigned;
    if (seal.kind !== KIND.sealEncrypted && seal.kind !== KIND.sealPlaintext) return null;

    // Anyone holding the stream key can mint a wrap, so the seal's signature
    // is what proves authorship — and it is checked before anything inside is
    // believed
    const verify = (nostrTools as any).verifySignature || (nostrTools as any).verifyEvent;
    if (typeof verify === 'function' && !verify(seal)) return null;

    const rumor = JSON.parse(
      seal.kind === KIND.sealPlaintext
        ? seal.content
        : modernNip44.v2.decrypt(seal.content, stream.convKey)
    ) as Rumor;

    // The rumor is unsigned; it is trusted only because the seal around it,
    // which is signed, claims the same author
    if (rumor.pubkey !== seal.pubkey) return null;
    return rumor;
  } catch {
    return null;
  }
}

/** A rumor as it goes into a seal: an event with an id and no signature */
export function buildRumor(
  pubkey: string,
  kind: number,
  content: string,
  tags: string[][] = []
): Rumor {
  const now = Date.now();
  const rumor: any = {
    kind,
    pubkey,
    content,
    tags: [...tags, msTag(now)],
    created_at: Math.floor(now / 1000)
  };
  rumor.id = (nostrTools as any).getEventHash(rumor);
  return rumor as Rumor;
}

/** The throwaway named in a wrap's `p` tag — it points at nobody */
export function ephemeralTag(): string[] {
  return ['p', toHex(schnorr.getPublicKey(secp256k1.utils.randomPrivateKey()))];
}

export { signWith };
