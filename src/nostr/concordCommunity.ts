import { sha256 } from '@noble/hashes/sha256';
import { NostrEventSigned } from '../types';
import {
  GroupKey,
  KIND,
  LABEL,
  Rumor,
  buildRumor,
  communityId,
  fromHex,
  groupKey,
  orderedAt,
  readStreamEvent,
  toHex,
  wrapForStream
} from './concord';

/**
 * A Concord community: what it is made of, how it is founded, and how its
 * three planes are read and written (CORD-02, CORD-03, CORD-05 §6).
 *
 * The shape of the thing, in the order it matters:
 *
 *  - **identity** is a commitment to the founder, `sha256("concord/community"
 *    || owner || salt)`, so anyone holding an invite can check the owner is
 *    who the invite says and nobody can graft a different owner onto it;
 *  - **membership** is holding `community_root`. There is no list to enforce
 *    — deriving a plane's address at all takes the secret;
 *  - **authority** is a signed roster, checked by every client, never granted
 *    by a server. This file carries the founder's own editions; ranks and
 *    grants (CORD-04) come next.
 */

/** Everything this browser needs to be in a community */
export interface CommunityKeys {
  id: string;
  ownerPubkey: string;
  ownerSalt: string;
  /** The base key: holding it is membership */
  communityRoot: string;
  /**
   * The Control Plane's write secret — owner and staff only. A member holds
   * only the derived `controlPk`, which is all reading takes.
   */
  controlRoot?: string;
  controlPk: string;
  epoch: number;
  relays: string[];
}

export interface Channel {
  id: string;
  name: string;
  private: boolean;
  deleted?: boolean;
  /** A private channel carries its own key and its own epoch (CORD-03) */
  key?: string;
  epoch?: number;
}

export interface Community extends CommunityKeys {
  name: string;
  description: string;
  channels: Channel[];
}

export interface ChannelMessage {
  id: string;
  channelId: string;
  author: string;
  content: string;
  at: number;
}

type Signer = (event: { kind: number; content: string; tags: string[][]; created_at?: number }) => Promise<NostrEventSigned>;

const randomBytes = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

// ---------------------------------------------------------------------------
// The three planes (CORD-02 §5)
// ---------------------------------------------------------------------------

/** Written by staff, read by everyone: the address and the reading key differ */
export const controlSigner = (keys: CommunityKeys): GroupKey | null =>
  keys.controlRoot
    ? groupKey(LABEL.controlSigner, fromHex(keys.controlRoot), fromHex(keys.id), keys.epoch)
    : null;

export const controlReader = (keys: CommunityKeys): GroupKey =>
  groupKey(LABEL.controlRead, fromHex(keys.communityRoot), fromHex(keys.id), keys.epoch);

/** Members write here — a join and a leave are each member's own word */
export const guestbook = (keys: CommunityKeys): GroupKey =>
  groupKey(LABEL.guestbook, fromHex(keys.communityRoot), fromHex(keys.id), keys.epoch);

/**
 * A channel's own plane. A public one derives from the community's base key,
 * so every member has it and nothing is delivered; a private one carries an
 * independent key and its own epoch.
 */
export const channelStream = (keys: CommunityKeys, channel: Channel): GroupKey =>
  groupKey(
    LABEL.channel,
    fromHex(channel.private && channel.key ? channel.key : keys.communityRoot),
    fromHex(channel.id),
    channel.private ? (channel.epoch ?? 0) : keys.epoch
  );

// ---------------------------------------------------------------------------
// Control editions (kind 3308)
// ---------------------------------------------------------------------------

const VSK = { metadata: 0, role: 1, channel: 2, grant: 3, banlist: 4 } as const;

const editionRumor = (
  author: string,
  vsk: number,
  eid: string,
  version: number,
  payload: unknown,
  previousHash?: string
): Rumor => {
  const tags: string[][] = [['vsk', String(vsk)], ['eid', eid], ['ev', String(version)]];
  // The chain link, absent on a first edition — what makes an edit an edit
  // rather than a second opinion
  if (previousHash) tags.push(['ep', previousHash]);
  return buildRumor(author, KIND.controlEdition, JSON.stringify(payload), tags);
};

/**
 * Found a community.
 *
 * Genesis is exactly two owner-signed editions — what the community is, and
 * one public channel to speak in. No roles, no scaffolding: the rest is the
 * founder's to shape.
 */
export async function foundCommunity(
  ownerPubkey: string,
  name: string,
  description: string,
  relays: string[],
  sign: Signer,
  publish: (event: NostrEventSigned) => Promise<unknown>
): Promise<Community> {
  const salt = randomBytes();
  const id = communityId(ownerPubkey, salt);
  const communityRoot = randomBytes();
  const controlRoot = randomBytes();

  const keys: CommunityKeys = {
    id: toHex(id),
    ownerPubkey,
    ownerSalt: toHex(salt),
    communityRoot: toHex(communityRoot),
    controlRoot: toHex(controlRoot),
    controlPk: groupKey(LABEL.controlSigner, controlRoot, id, 0).pubkey,
    epoch: 0,
    relays: relays.slice(0, 5)
  };

  const general: Channel = { id: toHex(randomBytes()), name: 'general', private: false };
  const signerKey = controlSigner(keys)!;
  const readerKey = controlReader(keys);

  // The Control Plane's seals are plaintext: its editions get re-wrapped into
  // later epochs, and a signature over ciphertext could not survive that
  const editions = [
    editionRumor(ownerPubkey, VSK.metadata, keys.id, 1, {
      name,
      description: description || undefined,
      relays: keys.relays
    }),
    editionRumor(ownerPubkey, VSK.channel, general.id, 1, { name: general.name, private: false })
  ];

  // Genesis is two editions and they are independent, so they go out together
  // rather than one waiting on the other's relays
  const wraps = [];
  for (const rumor of editions) {
    wraps.push(await wrapForStream(
      { ...signerKey, convKey: readerKey.convKey },
      rumor,
      sign,
      { plaintextSeal: true }
    ));
  }
  await Promise.all(wraps.map(publish));

  return { ...keys, name, description, channels: [general] };
}

/**
 * Add a channel.
 *
 * A channel is *created* by minting a random 32-byte id and publishing its
 * first ChannelMetadata edition — nothing else. A public one needs no key at
 * all: its address derives from the community's base key, so every member can
 * already find it and nothing has to be delivered.
 */
export async function addChannel(
  community: Community,
  name: string,
  sign: Signer,
  publish: (event: NostrEventSigned) => Promise<unknown>
): Promise<Channel> {
  const signerKey = controlSigner(community);
  if (!signerKey) throw new Error('Only somebody holding this community\'s control key can add a channel');

  const channel: Channel = { id: toHex(randomBytes()), name, private: false };
  const rumor = editionRumor(community.ownerPubkey, VSK.channel, channel.id, 1, {
    name: channel.name,
    private: false
  });

  await publish(await wrapForStream(
    { ...signerKey, convKey: controlReader(community).convKey },
    rumor,
    sign,
    { plaintextSeal: true }
  ));
  return channel;
}

/**
 * Read the community's state out of its Control Plane.
 *
 * Editions are versioned per entity, so folding is "highest version wins" —
 * and nothing here is believed because a relay served it: every edition names
 * its author in a signature the stream already checked.
 */
export function foldControl(keys: CommunityKeys, events: NostrEventSigned[]): Community {
  const reader = controlReader(keys);
  const signer = controlSigner(keys);
  const address = signer?.pubkey || keys.controlPk;

  const latest = new Map<string, { version: number; rumor: Rumor; payload: any }>();

  for (const event of events) {
    const rumor = readStreamEvent(event, { ...reader, pubkey: address });
    if (!rumor || rumor.kind !== KIND.controlEdition) continue;
    const eid = rumor.tags.find(t => t[0] === 'eid')?.[1];
    const version = Number(rumor.tags.find(t => t[0] === 'ev')?.[1] || 0);
    if (!eid || !Number.isInteger(version)) continue;

    // Only the founder's own hand is honoured here for now: ranks and grants
    // (CORD-04) are what let anybody else edit, and they are not written yet
    if (rumor.pubkey !== keys.ownerPubkey) continue;

    const held = latest.get(eid);
    if (held && held.version >= version) continue;
    try {
      latest.set(eid, { version, rumor, payload: JSON.parse(rumor.content) });
    } catch {
      // An edition this client cannot read is not an edition it obeys
    }
  }

  let name = '';
  let description = '';
  let relays = keys.relays;
  const channels: Channel[] = [];

  for (const [eid, held] of latest) {
    const vsk = Number(held.rumor.tags.find(t => t[0] === 'vsk')?.[1]);
    if (vsk === VSK.metadata && eid === keys.id) {
      name = String(held.payload.name || '');
      description = String(held.payload.description || '');
      if (Array.isArray(held.payload.relays)) relays = held.payload.relays.slice(0, 5);
    } else if (vsk === VSK.channel) {
      channels.push({
        id: eid,
        name: String(held.payload.name || ''),
        private: held.payload.private === true,
        deleted: held.payload.deleted === true
      });
    }
  }

  return {
    ...keys,
    relays,
    name,
    description,
    channels: channels.filter(channel => !channel.deleted)
  };
}

// ---------------------------------------------------------------------------
// Saying something (CORD-03 §3)
// ---------------------------------------------------------------------------

/**
 * A message commits the channel and epoch it was written for, inside the part
 * the author signed. Without that, any member could re-wrap somebody else's
 * message into another channel — the key that opens a wrap says nothing about
 * where it was meant to go.
 */
export async function sendToChannel(
  keys: CommunityKeys,
  channel: Channel,
  content: string,
  sign: Signer,
  publish: (event: NostrEventSigned) => Promise<unknown>,
  author: string
): Promise<ChannelMessage> {
  const stream = channelStream(keys, channel);
  const epoch = channel.private ? (channel.epoch ?? 0) : keys.epoch;
  const rumor = buildRumor(author, KIND.message, content, [
    ['channel', channel.id],
    ['epoch', String(epoch)]
  ]);

  await publish(await wrapForStream(stream, rumor, sign));
  return { id: rumor.id, channelId: channel.id, author, content, at: orderedAt(rumor) };
}

/** What a wrap at a channel's address says, if it says anything for us */
export function readChannelEvent(
  keys: CommunityKeys,
  channel: Channel,
  event: NostrEventSigned
): ChannelMessage | null {
  const stream = channelStream(keys, channel);
  const rumor = readStreamEvent(event, stream);
  if (!rumor || rumor.kind !== KIND.message) return null;

  // Strict equality, both of them: a mismatch is a message from somewhere
  // else wearing this channel's wrap
  const epoch = String(channel.private ? (channel.epoch ?? 0) : keys.epoch);
  if (rumor.tags.find(t => t[0] === 'channel')?.[1] !== channel.id) return null;
  if (rumor.tags.find(t => t[0] === 'epoch')?.[1] !== epoch) return null;

  return {
    id: rumor.id,
    channelId: channel.id,
    author: rumor.pubkey,
    content: rumor.content,
    at: orderedAt(rumor)
  };
}

// ---------------------------------------------------------------------------
// Coming and going (CORD-02 §5, Guestbook)
// ---------------------------------------------------------------------------

export async function announce(
  keys: CommunityKeys,
  verb: 'join' | 'leave',
  sign: Signer,
  publish: (event: NostrEventSigned) => Promise<unknown>,
  author: string
): Promise<void> {
  const rumor = buildRumor(author, KIND.joinLeave, verb, []);
  await publish(await wrapForStream(guestbook(keys), rumor, sign));
}

/**
 * Who is in it, as far as this client can tell: the guestbook coalesced to
 * one state per person — their latest word wins — merged with whoever has
 * been seen speaking, since an author publishing is present whether or not
 * their join ever arrived.
 */
export function foldMembers(
  keys: CommunityKeys,
  guestbookEvents: NostrEventSigned[],
  seenSpeaking: { author: string; at: number }[] = []
): string[] {
  const stream = guestbook(keys);
  const state = new Map<string, { verb: string; at: number; id: string }>();

  const anHourAhead = Date.now() + 60 * 60 * 1000;

  for (const event of guestbookEvents) {
    const rumor = readStreamEvent(event, stream);
    if (!rumor || rumor.kind !== KIND.joinLeave) continue;
    const at = orderedAt(rumor);
    // Dated far ahead is squatting "latest", not clock skew
    if (at > anHourAhead) continue;
    const verb = rumor.content === 'leave' ? 'leave' : 'join';

    const held = state.get(rumor.pubkey);
    // Ties break by the lower rumor id, which only ever grinds against the
    // author's own entries
    if (held && (held.at > at || (held.at === at && held.id < rumor.id))) continue;
    state.set(rumor.pubkey, { verb, at, id: rumor.id });
  }

  for (const seen of seenSpeaking) {
    const held = state.get(seen.author);
    // Observation counts forward only: an old message can never resurrect
    // somebody who has since left
    if (!held || (held.verb === 'leave' && seen.at > held.at) || held.verb === 'join') {
      if (!held || seen.at > held.at || held.verb === 'join') {
        state.set(seen.author, { verb: 'join', at: Math.max(seen.at, held?.at ?? 0), id: '' });
      }
    }
  }

  return Array.from(state.entries())
    .filter(([, held]) => held.verb === 'join')
    .map(([pubkey]) => pubkey);
}

// ---------------------------------------------------------------------------
// Invitations (CORD-05 §1 and §6)
// ---------------------------------------------------------------------------

export interface CommunityInvite {
  community_id: string;
  owner: string;
  owner_salt: string;
  community_root: string;
  root_epoch: number;
  control_pk: string;
  channels: { id: string; key?: string; epoch?: number; name: string }[];
  relays: string[];
  name: string;
  creator_npub?: string;
}

export const inviteFor = (community: Community, from: string): CommunityInvite => ({
  community_id: community.id,
  owner: community.ownerPubkey,
  owner_salt: community.ownerSalt,
  community_root: community.communityRoot,
  root_epoch: community.epoch,
  control_pk: community.controlPk,
  channels: community.channels.map(channel => ({
    id: channel.id,
    key: channel.private ? channel.key : undefined,
    epoch: channel.private ? channel.epoch : undefined,
    name: channel.name
  })),
  relays: community.relays,
  name: community.name,
  creator_npub: from
});

/**
 * What an invite is worth is decided here, not by who sent it: the
 * `community_id` is a commitment to the owner, so a bundle naming a different
 * founder for a real community cannot be made to reproduce it.
 */
export function invitationHolds(invite: CommunityInvite): boolean {
  try {
    const computed = toHex(communityId(invite.owner, fromHex(invite.owner_salt)));
    return computed === invite.community_id.toLowerCase();
  } catch {
    return false;
  }
}

export const keysFromInvite = (invite: CommunityInvite): CommunityKeys => ({
  id: invite.community_id,
  ownerPubkey: invite.owner,
  ownerSalt: invite.owner_salt,
  communityRoot: invite.community_root,
  controlPk: invite.control_pk,
  epoch: invite.root_epoch,
  relays: invite.relays
});

/** The `k` tag that lets a recipient find their invitations without opening everything */
export const INVITE_TAG = ['k', '3313'];
export const INVITE_KIND = 3313;

/**
 * Hand the keys to one person.
 *
 * A link has to survive a hostile journey, so it hides its keys in a bundle
 * on a relay behind a token. Nostr already has an encrypted lane to one npub,
 * so this drops all of that and gift-wraps the bundle itself — ordinary
 * NIP-59, ephemeral author, recipient in the `p` tag — with one deliberate
 * exception to the silence: a `k` tag naming the kind, so an invitation is
 * findable without opening the recipient's whole inbox.
 *
 * It cannot be revoked. The moment it lands they hold the keys, and the
 * answer to regretting that is the same as for any member: rotate.
 */
export async function sendDirectInvite(
  community: Community,
  to: string,
  from: string,
  sealAndWrap: (rumor: NostrEventSigned, target: string, wrapTags: string[][]) => Promise<NostrEventSigned>,
  publish: (event: NostrEventSigned) => Promise<unknown>
): Promise<void> {
  const rumor = buildRumor(from, INVITE_KIND, JSON.stringify(inviteFor(community, from)), []);
  const wrap = await sealAndWrap(rumor as unknown as NostrEventSigned, to, [INVITE_TAG]);
  await publish(wrap);
}

/**
 * The invitation inside a gift wrap, if that is what it is and if it holds
 * up. Who sent it is the seal's business — this only decides whether the
 * bundle is honest about the community it names.
 */
export function readDirectInvite(rumor: { kind: number; content: string }): CommunityInvite | null {
  if (rumor.kind !== INVITE_KIND) return null;
  try {
    const invite = JSON.parse(rumor.content) as CommunityInvite;
    return invitationHolds(invite) ? invite : null;
  } catch {
    return null;
  }
}

/** The edition hash a later edition chains to (CORD-04) */
export const editionHash = (rumor: Rumor): string => toHex(sha256(new TextEncoder().encode(rumor.id)));
