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
  // So it is the account's community, not this browser's
  void writeList().catch(error => console.warn('[Concord] Could not sync the community list:', error));
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
  void writeList().catch(error => console.warn('[Concord] Could not sync the community list:', error));
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

// ---------------------------------------------------------------------------
// The Community List (CORD-02 §8): membership that follows the account
//
// Keys kept only in a browser are keys one cleared cache away from gone, and
// invisible to the same person on their phone. So the list of what this
// account is in — with the material to be in it — is published as a kind
// 33302 addressable event, NIP-44 encrypted to self. Nobody but the holder
// can read it, and any client serving that npub finds the same rooms.
//
// What is written here is the spec's shape, minus what this client has no
// use for yet: one fragment rather than many (a fragment holds roughly eighty
// memberships), and no `seed` snapshot, which is meaningful only once keys
// rotate — and rekeys (CORD-06) are not written yet. Both are additive: a
// later client reading this list finds every field it expects.
// ---------------------------------------------------------------------------

const LIST_KIND = 33302;

/** Unpadded base64url, which is how every 32-byte value in the List is spelled */
const toB64 = (hex: string): string =>
  btoa(String.fromCharCode(...(hex.match(/.{1,2}/g) || []).map(b => parseInt(b, 16))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromB64 = (value: string): string => {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Array.from(binary, ch => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('');
};

interface ListEntry {
  community_id: string;
  current: Record<string, unknown>;
  added_at: number;
  [unknown: string]: unknown;
}

interface CommunityList {
  frags: number;
  entries: ListEntry[];
  tombstones: { community_id: string; removed_at: number; [unknown: string]: unknown }[];
  [unknown: string]: unknown;
}

const asEntry = (community: Community, addedAt: number): ListEntry => ({
  community_id: toB64(community.id),
  // The membership subset of an invite bundle, plus the control key where
  // this account holds one — the List is the one place a staffer's own
  // devices can pick that up
  current: {
    owner: toB64(community.ownerPubkey),
    owner_salt: toB64(community.ownerSalt),
    community_root: toB64(community.communityRoot),
    root_epoch: community.epoch,
    control_pk: toB64(community.controlPk),
    ...(community.controlRoot ? { control_root: toB64(community.controlRoot) } : {}),
    channels: community.channels.map(channel => ({
      id: toB64(channel.id),
      name: channel.name,
      ...(channel.key ? { key: toB64(channel.key), epoch: channel.epoch ?? 0 } : {})
    })),
    relays: community.relays,
    name: community.name
  },
  added_at: addedAt
});

const fromEntry = (entry: ListEntry): Community | null => {
  try {
    const held = entry.current as any;
    return {
      id: fromB64(entry.community_id),
      ownerPubkey: fromB64(held.owner),
      ownerSalt: fromB64(held.owner_salt),
      communityRoot: fromB64(held.community_root),
      controlRoot: held.control_root ? fromB64(held.control_root) : undefined,
      controlPk: fromB64(held.control_pk),
      epoch: Number(held.root_epoch) || 0,
      relays: Array.isArray(held.relays) ? held.relays : [],
      name: String(held.name || ''),
      description: '',
      channels: (Array.isArray(held.channels) ? held.channels : []).map((channel: any) => ({
        id: fromB64(channel.id),
        name: String(channel.name || ''),
        private: Boolean(channel.key),
        key: channel.key ? fromB64(channel.key) : undefined,
        epoch: channel.epoch
      }))
    };
  } catch {
    // An entry this client cannot read is not an entry it drops: it is
    // round-tripped untouched by the writer below
    return null;
  }
};

/**
 * Encrypting to oneself, whichever way this account signs. A key kept here
 * does it directly; an extension does it through the same NIP-44 calls the
 * private messages use, so a list is not a thing only stored-key accounts
 * get to have.
 */
const sealToSelf = async (plaintext: string): Promise<string> => {
  const owner = me();
  const privkey = CredentialManager.getPrivateKey();
  const { NostrCrypto, ExtensionManager } = await import('./crypto');
  if (privkey) return NostrCrypto.encryptNip44(plaintext, privkey, owner);
  return ExtensionManager.encryptNip44(owner, plaintext);
};

const openFromSelf = async (ciphertext: string): Promise<string> => {
  const owner = me();
  const privkey = CredentialManager.getPrivateKey();
  const { NostrCrypto, ExtensionManager } = await import('./crypto');
  if (privkey) return NostrCrypto.decryptNip44(ciphertext, privkey, owner);
  return ExtensionManager.decryptNip44(owner, ciphertext);
};

const readList = async (): Promise<{ list: CommunityList; at: number } | null> => {
  const owner = me();
  const events = await getRelayPool().fetchEvents([
    { kinds: [LIST_KIND], authors: [owner], '#d': ['0'], limit: 5 } as any
  ]);
  const newest = events.sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0];
  if (!newest) return null;

  try {
    return {
      list: JSON.parse(await openFromSelf(newest.content)) as CommunityList,
      at: newest.created_at || 0
    };
  } catch {
    return null;
  }
};

/**
 * Write the list back: read, merge, publish. Never from local state alone —
 * a join racing another device's write survives only because whichever lands
 * second carried the first one's content.
 */
async function writeList(gone?: string): Promise<void> {
  const remote = await readList();
  const now = Date.now();

  const entries = new Map<string, ListEntry>();
  const tombstones = new Map<string, { community_id: string; removed_at: number }>();

  for (const entry of remote?.list.entries || []) entries.set(entry.community_id, entry);
  for (const stone of remote?.list.tombstones || []) tombstones.set(stone.community_id, stone);

  for (const community of heldCommunities()) {
    const id = toB64(community.id);
    const held = entries.get(id);
    // Unknown fields ride through untouched: this list is the member's vault,
    // and a field dropped here is key material destroyed on every device
    entries.set(id, { ...(held || {}), ...asEntry(community, held?.added_at || now) } as ListEntry);
  }

  if (gone) {
    const id = toB64(gone);
    entries.delete(id);
    tombstones.set(id, { ...(tombstones.get(id) || {}), community_id: id, removed_at: now });
  }

  // A membership is live only while its entry outranks its removal
  const live = Array.from(entries.values()).filter(entry => {
    const stone = tombstones.get(entry.community_id);
    return !stone || entry.added_at > stone.removed_at;
  });

  const list: CommunityList = {
    ...(remote?.list || {}),
    frags: 1,
    entries: live,
    tombstones: Array.from(tombstones.values())
  };

  const content = await sealToSelf(JSON.stringify(list));
  const signed = await sign({
    kind: LIST_KIND,
    content,
    tags: [['d', '0']],
    // Replaced in place, so it must be strictly newer than what is there
    created_at: Math.max(Math.floor(now / 1000), (remote?.at || 0) + 1)
  });
  await publish(signed);
}

/**
 * What this account is in, according to itself. Read on the way in, so a
 * community made in one browser turns up in another — and so does one made
 * on a phone.
 */
export async function syncCommunityList(): Promise<Community[]> {
  const remote = await readList();
  if (!remote) {
    // Nothing published yet: whatever this device holds is the list
    const held = heldCommunities();
    if (held.length) await writeList().catch(() => {});
    return held;
  }

  const gone = new Map((remote.list.tombstones || []).map(stone => [stone.community_id, stone.removed_at]));
  const held = new Map(heldCommunities().map(community => [community.id, community]));

  for (const entry of remote.list.entries || []) {
    const removed = gone.get(entry.community_id) || 0;
    if (entry.added_at <= removed) continue;
    const community = fromEntry(entry);
    // What a device already holds wins on the things it knows better —
    // channel names it has folded, the description — while the list carries
    // the keys
    if (community && !held.has(community.id)) held.set(community.id, community);
  }

  for (const [id, removed] of gone) {
    const local = Array.from(held.values()).find(community => toB64(community.id) === id);
    if (!local) continue;
    const entry = (remote.list.entries || []).find(e => e.community_id === id);
    if (!entry || entry.added_at <= removed) held.delete(local.id);
  }

  const merged = Array.from(held.values());
  localStorage.setItem(listKey(me()), JSON.stringify(merged));

  // A community made before this device ever wrote a list — or made while
  // offline — is only in this browser. Carrying it up is what makes it a
  // community of the account rather than of the machine it was made on.
  const published = new Set((remote.list.entries || []).map(entry => entry.community_id));
  if (merged.some(community => !published.has(toB64(community.id)))) {
    await writeList().catch(() => {});
  }

  return merged;
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
  void writeList().catch(error => console.warn('[Concord] Could not sync the community list:', error));
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
  // A tombstone, so a device that was offline cannot bring it back
  await writeList(community.id).catch(error => console.warn('[Concord] Could not sync the community list:', error));
}

export { inviteFor };
