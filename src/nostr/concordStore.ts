import { NostrEventSigned, EVENT_KINDS } from '../types';
import { CredentialManager } from './crypto';
import { NostrCore } from './core';
import { DirectMessageCore } from './dm';
import { getRelayPool } from './relay';
import {
  Channel,
  ChannelMessage,
  Community,
  CommunityInvite,
  INVITE_TAG,
  announce,
  channelStream,
  controlSigner,
  foldControl,
  foundCommunity,
  guestbook,
  inviteFor,
  keysFromInvite,
  readChannelEvent,
  readDirectInvite,
  sendDirectInvite,
  sendToChannel
} from './concordCommunity';
import { KIND } from './concord';

/**
 * The app's side of Concord: which communities this account is in, and the
 * plumbing between the protocol and the relays it already talks to.
 *
 * The keys are what membership *is*, so they are kept here — and because they
 * are keys rather than per-device state, the same account holding them
 * anywhere is in the same rooms. Syncing them between a person's own devices
 * is the Community List (CORD-02 §8), which comes next; until then a second
 * device is invited like anyone else.
 */

const listKey = (owner: string) => `nostr_concord_${owner}`;
const messagesKey = (owner: string, channelId: string) => `nostr_concord_said_${owner}_${channelId}`;

const me = (): string => {
  const pubkey = CredentialManager.getPublicKey();
  if (!pubkey) throw new Error('Not logged in');
  return pubkey;
};

export const heldCommunities = (): Community[] => {
  try {
    return JSON.parse(localStorage.getItem(listKey(me())) || '[]') as Community[];
  } catch {
    return [];
  }
};

const keepCommunity = (community: Community): void => {
  const held = heldCommunities().filter(c => c.id !== community.id);
  localStorage.setItem(listKey(me()), JSON.stringify([...held, community]));
};

export const forgetCommunity = (id: string): void => {
  localStorage.setItem(listKey(me()), JSON.stringify(heldCommunities().filter(c => c.id !== id)));
};

export const communityById = (id: string): Community | null =>
  heldCommunities().find(c => c.id === id) || null;

/**
 * Messages are kept as they are read. Not because they cannot be read again —
 * a Concord stream re-decrypts as often as you like, unlike a ratcheting one
 * — but because a room should be on screen before the relays answer.
 */
export const heldMessages = (channelId: string): ChannelMessage[] => {
  try {
    return JSON.parse(localStorage.getItem(messagesKey(me(), channelId)) || '[]') as ChannelMessage[];
  } catch {
    return [];
  }
};

const keepMessage = (message: ChannelMessage): void => {
  try {
    const held = heldMessages(message.channelId);
    if (held.some(m => m.id === message.id)) return;
    localStorage.setItem(
      messagesKey(me(), message.channelId),
      JSON.stringify([...held, message].sort((a, b) => a.at - b.at).slice(-500))
    );
  } catch {
    // Storage full: the room still works, it just starts empty next time
  }
};

const sign = (event: { kind: number; content: string; tags: string[][]; created_at?: number }) =>
  NostrCore.signAnyMode(event as any);

const publish = (event: NostrEventSigned) => getRelayPool().publishEvent(event);

/** Found one, and say so in its guestbook */
export async function makeCommunity(name: string, description: string): Promise<Community> {
  const owner = me();
  const relays = getRelayPool().getWriteRelayUrls().slice(0, 5);
  const community = await foundCommunity(owner, name, description, relays, sign, publish);
  keepCommunity(community);
  await announce(community, 'join', sign, publish, owner);
  return community;
}

/** Everything the control plane says about a community this account is in */
export async function refreshCommunity(community: Community): Promise<Community> {
  const address = controlSigner(community)?.pubkey || community.controlPk;
  const events = await getRelayPool().fetchEvents([
    { kinds: [KIND.wrap], authors: [address], limit: 200 }
  ]);
  const folded = foldControl(community, events);
  // The keys are ours and never come off a relay; only what the community
  // says about itself is folded in
  const merged: Community = {
    ...community,
    name: folded.name || community.name,
    description: folded.description || community.description,
    relays: folded.relays.length > 0 ? folded.relays : community.relays,
    channels: folded.channels.length > 0 ? folded.channels : community.channels
  };
  keepCommunity(merged);
  return merged;
}

/** Make a channel in a community this account holds the control key for */
export async function makeChannel(community: Community, name: string): Promise<Community> {
  const { addChannel } = await import('./concordCommunity');
  const channel = await addChannel(community, name, sign, publish);
  const updated: Community = { ...community, channels: [...community.channels, channel] };
  keepCommunity(updated);
  return updated;
}

export async function sayInChannel(
  community: Community,
  channel: Channel,
  content: string
): Promise<ChannelMessage> {
  const said = await sendToChannel(community, channel, content, sign, publish, me());
  keepMessage(said);
  return said;
}

/** What a wrap at a channel's address says, kept if it says anything */
export function takeChannelEvent(
  community: Community,
  channel: Channel,
  event: NostrEventSigned
): ChannelMessage | null {
  const message = readChannelEvent(community, channel, event);
  if (message) keepMessage(message);
  return message;
}

export const channelAddress = (community: Community, channel: Channel): string =>
  channelStream(community, channel).pubkey;

export async function fetchChannel(community: Community, channel: Channel): Promise<ChannelMessage[]> {
  const events = await getRelayPool().fetchEvents([
    { kinds: [KIND.wrap], authors: [channelAddress(community, channel)], limit: 200 }
  ]);
  return events
    .map(event => takeChannelEvent(community, channel, event))
    .filter((m): m is ChannelMessage => m !== null)
    .sort((a, b) => a.at - b.at);
}

/** Who is in it, by the guestbook and by whoever has been heard speaking */
export async function fetchMembers(community: Community): Promise<string[]> {
  const events = await getRelayPool().fetchEvents([
    { kinds: [KIND.wrap], authors: [guestbook(community).pubkey], limit: 300 }
  ]);
  const { foldMembers } = await import('./concordCommunity');
  const spoken = community.channels.flatMap(channel =>
    heldMessages(channel.id).map(m => ({ author: m.author, at: m.at }))
  );
  return foldMembers(community, events, spoken);
}

export async function invite(community: Community, to: string): Promise<void> {
  await sendDirectInvite(
    community,
    to,
    me(),
    (rumor, target, wrapTags) => DirectMessageCore.sealAndWrap(rumor, target, wrapTags),
    publish
  );
}

/**
 * Invitations waiting in the inbox. The `k` tag means only invitations are
 * fetched, so this costs one small query rather than opening everything ever
 * addressed to this account.
 */
export async function pendingInvites(): Promise<{ from: string; invite: CommunityInvite }[]> {
  const owner = me();
  const privkey = CredentialManager.getPrivateKey();
  if (!privkey) return [];

  const wraps = await getRelayPool().fetchEvents([
    { kinds: [EVENT_KINDS.GIFT_WRAP], '#p': [owner], [`#${INVITE_TAG[0]}`]: [INVITE_TAG[1]], limit: 100 } as any
  ]);

  const held = new Set(heldCommunities().map(c => c.id));
  const found: { from: string; invite: CommunityInvite }[] = [];

  for (const wrap of wraps) {
    try {
      const { NostrCrypto } = await import('./crypto');
      const seal = JSON.parse(NostrCrypto.decryptNip44(wrap.content, privkey, wrap.pubkey)) as NostrEventSigned;
      if (seal.kind !== EVENT_KINDS.SEAL) continue;
      const rumor = JSON.parse(NostrCrypto.decryptNip44(seal.content, privkey, seal.pubkey));
      // The rumor is unsigned; the seal around it is what names the inviter
      if (rumor.pubkey !== seal.pubkey) continue;
      const invite = readDirectInvite(rumor);
      if (invite && !held.has(invite.community_id)) found.push({ from: seal.pubkey, invite });
    } catch {
      // Not an invitation, or not ours to open
    }
  }
  return found;
}

/** Take one: keep the keys, then say so where members say it */
export async function acceptInvite(invite: CommunityInvite): Promise<Community> {
  const keys = keysFromInvite(invite);
  const community: Community = {
    ...keys,
    name: invite.name,
    description: '',
    channels: invite.channels.map(channel => ({
      id: channel.id,
      name: channel.name,
      private: Boolean(channel.key),
      key: channel.key,
      epoch: channel.epoch
    }))
  };
  keepCommunity(community);

  const refreshed = await refreshCommunity(community);
  await announce(refreshed, 'join', sign, publish, me());
  return refreshed;
}

/** Leave: say so, then drop the keys. Nothing on a relay can bring them back. */
export async function leaveCommunity(community: Community): Promise<void> {
  try {
    await announce(community, 'leave', sign, publish, me());
  } catch (error) {
    console.warn('[Concord] Could not announce leaving:', error);
  }
  for (const channel of community.channels) {
    localStorage.removeItem(messagesKey(me(), channel.id));
  }
  forgetCommunity(community.id);
}

export { inviteFor };
