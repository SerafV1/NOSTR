import { NostrEventSigned } from '../types';
import { NostrCore } from './core';
import { CredentialManager } from './crypto';
import { getRelayPool } from './relay';

/**
 * Saying "I am watching this" out loud (NIP-53 room presence).
 *
 * A live event carries a viewer count the broadcaster's own software
 * publishes, and measured on a stream with people in it that number was
 * nought while its chat was moving — it is whatever the broadcasting
 * software bothers to keep up, and nobody else can check it. The only count
 * a client can actually build is the one people publish about themselves:
 * kind 10312, replaceable, naming the room it is about.
 *
 * Measured before writing this: across five relays, not one presence event
 * existed for any live stream. So this starts by counting the people
 * watching through this client, and grows into a real number as other
 * clients publish theirs.
 */

export const PRESENCE_KIND = 10312;

/** How long a presence event stands for. The spec leaves the window to us. */
export const PRESENT_FOR_MS = 10 * 60 * 1000;

/** Say it again before it goes stale, with room to spare */
export const REFRESH_PRESENCE_MS = 4 * 60 * 1000;

/**
 * One presence event for one room. Replaceable, so this is the whole of it:
 * publishing it again in another room is what leaving looks like.
 *
 * Anyone signed in and watching is counted. This was behind a "Count me"
 * tickbox for a while, which was a question with one sensible answer: you
 * are in the room, so the room's number should say so.
 */
export async function announcePresence(address: string, relayHint = ''): Promise<NostrEventSigned | null> {
  if (!CredentialManager.canSign()) return null;

  try {
    const signed = await NostrCore.signAnyMode({
      kind: PRESENCE_KIND,
      content: '',
      tags: [['a', address, relayHint, 'root']]
    });
    if (!signed) return null;
    await getRelayPool().publishEvent(signed);
    return signed;
  } catch (error) {
    console.error('Failed to announce presence:', error);
    return null;
  }
}

/** Whoever has said they are in this room lately */
export async function fetchPresence(address: string): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  try {
    const since = Math.floor((Date.now() - PRESENT_FOR_MS) / 1000);
    const events = await getRelayPool().fetchEvents([
      { kinds: [PRESENCE_KIND], '#a': [address], since, limit: 500 }
    ]);
    for (const event of events) {
      const at = event.created_at || 0;
      if (at >= since && at > (found.get(event.pubkey) || 0)) found.set(event.pubkey, at);
    }
  } catch (error) {
    console.error('Failed to read presence:', error);
  }
  return found;
}
