import { SimplePool } from 'nostr-tools-v2';
import type { Event as RelayEvent, EventTemplate, VerifiedEvent } from 'nostr-tools-v2';
import { NostrEventSigned, EVENT_KINDS } from '../types';
import { getRelayPool } from './relay';
import { NostrCore, PersistentCache } from './core';
import { CredentialManager } from './crypto';

/** NIP-17: the relays somebody reads their private messages from */
const KIND_DM_RELAYS = 10050;

/** A list is asked for again after this long */
const LIST_LIFE_MS = 30 * 60 * 1000;
/** An inbox relay behind a login takes a round trip more than an open one */
const INBOX_WAIT_MS = 6000;
/** Nobody names many, and each is a socket and possibly a signature */
const MAX_INBOX_RELAYS = 5;

/**
 * The relays a private message is actually delivered to.
 *
 * NIP-17 does not send a message to "the relays": each person publishes a
 * short list (kind 10050) of where they read their private messages, and a
 * careful client delivers there and nowhere else. This client knew nothing
 * of that list. It sent to its own relays and read from its own relays, so
 * a reply written in a client that follows the rule went to the inbox relay
 * and was never seen here — while the same conversation, opened in that
 * other client, was whole.
 *
 * Those inbox relays are usually closed ones: they hand a gift wrap only to
 * the person it is addressed to, and ask for proof first (NIP-42). The
 * relay connections everything else here runs on cannot give that proof,
 * so these few go through their own pool, which can. It is kept open —
 * the proof is given once per connection, and with a signing extension
 * each one is a prompt.
 */
let pool = new SimplePool();
let poolOwner: string | null = null;

/**
 * The pool, for whoever is logged in now. A connection that has proved
 * itself to a relay stays proved as that person, so after a change of
 * account the old ones are dropped rather than asked on the new one's
 * behalf — the relay would answer for the wrong inbox, or not at all.
 */
const poolFor = (pubkey: string | null): SimplePool => {
  if (poolOwner !== pubkey) {
    try { pool.destroy(); } catch { /* nothing was open */ }
    pool = new SimplePool();
    poolOwner = pubkey;
  }
  return pool;
};

/** Signs the relay's challenge as whoever is logged in, however they sign */
const proveIdentity = async (template: EventTemplate): Promise<VerifiedEvent> => {
  const signed = await NostrCore.signAnyMode({
    kind: template.kind,
    content: template.content,
    tags: template.tags
  });
  return signed as unknown as VerifiedEvent;
};

const tidy = (url: string): string => (url || '').trim().replace(/\/+$/, '');

const held = new Map<string, { at: number; relays: string[] }>();
const listKey = (pubkey: string): string => `dm_relays_${pubkey}`;

/**
 * Where somebody reads their private messages, by their own account of it.
 * Empty when they have published no list — which is most people, and means
 * the ordinary relays are all there is to try.
 */
export const dmRelaysOf = async (pubkey: string): Promise<string[]> => {
  const known = held.get(pubkey);
  if (known && Date.now() - known.at < LIST_LIFE_MS) return known.relays;

  let relays: string[] | null = null;
  try {
    const found = await getRelayPool().fetchEvents([
      { kinds: [KIND_DM_RELAYS], authors: [pubkey], limit: 3 }
    ]);
    const latest = found.sort((a, b) => b.created_at - a.created_at)[0];
    if (latest) {
      relays = Array.from(new Set(
        latest.tags
          .filter(tag => tag[0] === 'relay' && tag[1])
          .map(tag => tidy(tag[1]))
          .filter(url => /^wss:\/\//i.test(url))
      )).slice(0, MAX_INBOX_RELAYS);
      PersistentCache.set(listKey(pubkey), relays);
    }
  } catch (error) {
    console.warn('[DM] Could not read the inbox relay list:', error);
  }

  // No answer is not "no list": what was known last time still stands
  if (relays === null) relays = PersistentCache.get<string[]>(listKey(pubkey)) || [];
  held.set(pubkey, { at: Date.now(), relays });
  return relays;
};

/**
 * The gift wraps waiting on our own inbox relays — the ones only we may
 * read, which is exactly why nothing else here ever saw them.
 */
export const fetchInboxWraps = async (ownPubkey: string, limit: number): Promise<NostrEventSigned[]> => {
  const relays = await dmRelaysOf(ownPubkey);
  if (relays.length === 0) return [];

  return new Promise(resolve => {
    const found = new Map<string, NostrEventSigned>();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(Array.from(found.values()));
    };
    try {
      poolFor(ownPubkey).subscribeManyEose(
        relays,
        { kinds: [EVENT_KINDS.GIFT_WRAP], '#p': [ownPubkey], limit },
        {
          maxWait: INBOX_WAIT_MS,
          onauth: proveIdentity,
          onevent: (event: RelayEvent) => { found.set(event.id, event as unknown as NostrEventSigned); },
          onclose: finish
        }
      );
    } catch (error) {
      console.warn('[DM] Inbox relays could not be asked:', error);
      finish();
    }
    // A relay that neither answers nor closes must not hold the inbox up
    setTimeout(finish, INBOX_WAIT_MS * 2 + 1000);
  });
};

/**
 * Hand a gift wrap to the inbox relays of the person it is for. True when
 * at least one of them took it; false when they name none, or none would.
 */
export const deliverToInbox = async (wrap: NostrEventSigned, targetPubkey: string): Promise<boolean> => {
  const relays = await dmRelaysOf(targetPubkey);
  if (relays.length === 0) return false;
  try {
    const answers = await Promise.allSettled(
      poolFor(CredentialManager.getPublicKey()).publish(relays, wrap as unknown as RelayEvent, { onauth: proveIdentity, maxWait: INBOX_WAIT_MS })
    );
    return answers.some(answer => answer.status === 'fulfilled');
  } catch (error) {
    console.warn('[DM] Inbox delivery failed:', error);
    return false;
  }
};
