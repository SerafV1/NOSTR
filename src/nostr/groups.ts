import { nip19 } from 'nostr-tools';
import { NostrEvent, NostrEventSigned, NostrFilter, EVENT_KINDS } from '../types';
import { NostrCore } from './core';
import { getRelayPool } from './relay';
import { CredentialManager } from './crypto';

/**
 * NIP-29 groups: the relay is the server.
 *
 * A group lives on one relay, which holds it, decides who is in it and hands
 * out its history. Every event in a group carries an 'h' tag naming which
 * group it belongs to — that is the whole addressing scheme.
 *
 * These relays are kept apart from the ones the rest of the app reads. A
 * group relay carries a group's traffic and nothing else worth putting in a
 * feed, and the feed's relays know nothing about groups.
 */

/**
 * Not shown as servers — nobody wants a list of places they have never been.
 * These are only asked whether this account is a member of anything of
 * theirs; whatever answers yes becomes a server of one's own.
 */
const WELL_KNOWN = [
  'wss://groups.0xchat.com',
  'wss://groups.hzrd149.com',
  'wss://relay.zap.stream',
  'wss://relay.damus.io'
];

/**
 * Relays worth asking "is this account in anything of yours?", even when
 * nobody has added them. A group joined in another client is often the only
 * record there is — that client need not have written it to the shared list,
 * and Armada, for one, does not — so the relay's own member list is where
 * such a group is found. Only asked about membership; browsing still starts
 * from the relays above.
 */
export const KNOWN_GROUP_RELAYS = [
  ...WELL_KNOWN,
  'wss://chat.wisp.talk',
  'wss://groups.libernet.app',
  'wss://groups.fiatjaf.com',
  'wss://pyramid.fiatjaf.com',
  'wss://basspistol.org',
  'wss://spatia-arcana.com',
  'wss://group.einundzwanzig.space',
  'wss://communities.nos.social'
];

const GROUP_RELAYS_KEY = 'nostr_group_relays';

export interface GroupInfo {
  /** The relay holding it — half of the group's address */
  relay: string;
  /** The 'd' of its metadata event — the other half */
  id: string;
  name: string;
  about: string;
  picture: string;
  /** Anyone may read it */
  isPublic: boolean;
  /** Anyone may join without being asked in */
  isOpen: boolean;
  /** From the relay's own member list, where it publishes one */
  members?: number;
  /** When the group last said anything about itself */
  updatedAt: number;
}

export interface GroupAddress {
  relay: string;
  id: string;
}

export const groupKey = (address: GroupAddress): string => `${address.relay}'${address.id}`;

export function parseGroupKey(key: string): GroupAddress | null {
  const cut = key.lastIndexOf("'");
  if (cut < 0) return null;
  return { relay: key.slice(0, cut), id: key.slice(cut + 1) };
}

// ---------------------------------------------------------------------------
// Talking to a group relay
//
// A socket of its own rather than the pool the rest of the app reads through:
// a group relay carries one community's traffic and nothing a feed wants, and
// the questions asked of it — a subscription per group, NIP-42 to prove who is
// asking — are its own shape.
// ---------------------------------------------------------------------------

type Waiting = {
  onEvent: (event: NostrEventSigned) => void;
  onEose?: () => void;
  /** The relay turning the question down, in its own words */
  onClosed?: (reason: string) => void;
};

class GroupRelay {
  private socket: WebSocket | null = null;
  private opening: Promise<void> | null = null;
  private subs = new Map<string, Waiting>();
  private publishes = new Map<string, (accepted: boolean, reason: string) => void>();
  private nextId = 0;
  /** Resolves once the relay has accepted who we say we are */
  private known: Promise<boolean> | null = null;
  private admitKnown: ((accepted: boolean) => void) | null = null;

  constructor(private readonly url: string) {}

  private async open(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return;
    if (this.opening) return this.opening;

    this.opening = new Promise<void>((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(this.url);
      } catch (error) {
        this.opening = null;
        reject(error);
        return;
      }

      const timer = setTimeout(() => {
        this.opening = null;
        try { socket.close(); } catch { /* already gone */ }
        reject(new Error(`${this.url} did not answer`));
      }, 8000);

      socket.onopen = () => {
        clearTimeout(timer);
        this.socket = socket;
        this.opening = null;
        resolve();
      };

      socket.onerror = () => {
        clearTimeout(timer);
        this.opening = null;
        reject(new Error(`${this.url} refused the connection`));
      };

      socket.onclose = () => {
        if (this.socket === socket) this.socket = null;
        // Whoever was waiting is not going to hear anything more
        for (const waiting of this.subs.values()) waiting.onEose?.();
        this.subs.clear();
      };

      socket.onmessage = (message) => this.receive(String(message.data));
    });

    return this.opening;
  }

  private receive(raw: string): void {
    let message: unknown[];
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    const [verb, first, second, third] = message as [string, string, unknown, unknown];

    if (verb === 'EVENT') {
      this.subs.get(first)?.onEvent(second as NostrEventSigned);
      return;
    }
    if (verb === 'EOSE') {
      this.subs.get(first)?.onEose?.();
      return;
    }
    if (verb === 'CLOSED') {
      const waiting = this.subs.get(first);
      waiting?.onClosed?.(String(second || ''));
      waiting?.onEose?.();
      this.subs.delete(first);
      return;
    }
    if (verb === 'OK') {
      this.publishes.get(first)?.(second as boolean, String(third || ''));
      this.publishes.delete(first);
      return;
    }
    if (verb === 'AUTH') {
      void this.proveWhoWeAre(first);
    }
  }

  /** NIP-42, which is how a group relay decides what it will show and take */
  private async proveWhoWeAre(challenge: string): Promise<void> {
    if (!CredentialManager.canSign()) {
      this.admitKnown?.(false);
      return;
    }
    try {
      const proof = await NostrCore.signAnyMode({
        kind: EVENT_KINDS.CLIENT_AUTH,
        content: '',
        tags: [['relay', this.url], ['challenge', challenge]]
      } as NostrEvent);

      // The relay answers an auth event with an OK, like any other
      this.publishes.set(proof.id, accepted => this.admitKnown?.(accepted));
      this.send(['AUTH', proof]);
    } catch (error) {
      console.warn(`[Groups] Could not prove who we are to ${this.url}:`, error);
      this.admitKnown?.(false);
    }
  }

  /**
   * Whether the relay knows who is asking. A private group is not shown to a
   * stranger, and the challenge often arrives after the first question has
   * already gone out — so a refused question is worth asking again once this
   * has settled.
   */
  private whenKnown(waitMs = 4000): Promise<boolean> {
    if (!this.known) {
      this.known = new Promise<boolean>(resolve => {
        this.admitKnown = resolve;
        setTimeout(() => resolve(false), waitMs);
      });
    }
    return this.known;
  }

  private send(message: unknown[]): void {
    this.socket?.send(JSON.stringify(message));
  }

  /** Everything the relay holds for these filters, and then no more */
  async read(filters: NostrFilter[], waitMs = 5000): Promise<NostrEventSigned[]> {
    const { events } = await this.readWithReason(filters, waitMs);
    return events;
  }

  /** The same, with whatever the relay said if it would not answer */
  async readWithReason(
    filters: NostrFilter[],
    waitMs = 5000
  ): Promise<{ events: NostrEventSigned[]; refusal: string | null }> {
    const first = await this.askOnce(filters, waitMs);
    const worthRetrying = first.refusal && /auth|restricted|private|not a member/i.test(first.refusal);
    if (!worthRetrying || !CredentialManager.canSign()) return first;

    // Turned away for not being known: wait for the introduction to land and
    // ask again, which is the difference between a private group one is a
    // member of showing and not showing at all
    const admitted = await this.whenKnown();
    if (!admitted) return first;
    return this.askOnce(filters, waitMs);
  }

  private async askOnce(
    filters: NostrFilter[],
    waitMs: number
  ): Promise<{ events: NostrEventSigned[]; refusal: string | null }> {
    try {
      await this.open();
    } catch (error) {
      console.warn(`[Groups] ${this.url}:`, error);
      return { events: [], refusal: `${this.url} could not be reached` };
    }

    return new Promise<{ events: NostrEventSigned[]; refusal: string | null }>(resolve => {
      const id = `r${this.nextId++}`;
      const found: NostrEventSigned[] = [];
      let refusal: string | null = null;
      let done = false;

      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.subs.delete(id);
        this.send(['CLOSE', id]);
        resolve({ events: found, refusal: found.length === 0 ? refusal : null });
      };

      // A relay that wants to know who is asking can hold back its "that is
      // all" while sending the events themselves quite happily, so what has
      // arrived by the end of the wait is the answer
      const timer = setTimeout(finish, waitMs);
      this.subs.set(id, {
        onEvent: event => found.push(event),
        onEose: finish,
        onClosed: reason => { refusal = reason; }
      });
      this.send(['REQ', id, ...filters]);
    });
  }

  /** And everything that happens from now on */
  async watch(filters: NostrFilter[], onEvent: (event: NostrEventSigned) => void): Promise<() => void> {
    try {
      await this.open();
    } catch {
      return () => {};
    }

    const id = `w${this.nextId++}`;
    this.subs.set(id, { onEvent });
    this.send(['REQ', id, ...filters]);

    return () => {
      this.subs.delete(id);
      this.send(['CLOSE', id]);
    };
  }

  async publish(event: NostrEventSigned): Promise<void> {
    await this.open();

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.publishes.delete(event.id);
        reject(new Error('The relay did not answer'));
      }, 8000);

      this.publishes.set(event.id, (accepted, reason) => {
        clearTimeout(timer);
        if (accepted) resolve();
        else reject(new Error(reason || 'The relay would not take it'));
      });

      this.send(['EVENT', event]);
    });
  }
}

const relays = new Map<string, GroupRelay>();

function relayAt(url: string): GroupRelay {
  const held = relays.get(url);
  if (held) return held;
  const relay = new GroupRelay(url);
  relays.set(url, relay);
  return relay;
}

function read(url: string, filters: NostrFilter[], waitMs = 5000): Promise<NostrEventSigned[]> {
  return relayAt(url).read(filters, waitMs);
}

// ---------------------------------------------------------------------------
// Which relays to look at
// ---------------------------------------------------------------------------

/**
 * What somebody pasted in, whatever form it came in. A community is handed
 * about in several: the relay's own address, a link from this app, or the
 * `naddr` other clients hand out — which carries the group and the relay
 * holding it inside itself.
 */
export function readCommunityAddress(text: string): GroupAddress | null {
  const given = text.trim();
  if (!given) return null;

  // An naddr, on its own or as a nostr: link
  const bech = given.match(/(?:nostr:)?(naddr1[023456789acdefghjklmnpqrstuvwxyz]+)/i)?.[1];
  if (bech) {
    try {
      const decoded = nip19.decode(bech.toLowerCase());
      if (decoded.type === 'naddr') {
        const { kind, identifier, relays } = decoded.data as {
          kind: number; identifier: string; relays?: string[];
        };
        const relay = relays?.[0];
        if (kind === EVENT_KINDS.GROUP_METADATA && relay) {
          return { relay: relay.replace(/\/$/, ''), id: identifier };
        }
      }
    } catch {
      // Not an address after all
    }
  }

  // A link from this app: /s/<server>/<group>, on any origin
  const asLink = given.match(/\/s\/([^/\s?#]+)(?:\/([^/\s?#]+))?/i);
  if (asLink) {
    return {
      relay: `wss://${decodeURIComponent(asLink[1])}`,
      id: asLink[2] ? decodeURIComponent(asLink[2]) : ''
    };
  }

  // The relay itself, written however people write it
  const host = given
    .replace(/^https?:\/\//i, '')
    .replace(/^wss?:\/\//i, '')
    .replace(/\/$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}(:\d+)?$/i.test(host)) return null;
  return { relay: `wss://${host}`, id: '' };
}

/**
 * The servers this account actually has: the ones it was found to be a member
 * of, and the ones it was told about by hand. Empty to begin with, which is
 * the truth — a stranger's relay is not one of your servers.
 */
export function getGroupRelays(): string[] {
  try {
    const stored = localStorage.getItem(GROUP_RELAYS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as string[];
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    // Unreadable — start from nothing rather than from someone else's list
  }
  return [];
}

/**
 * Which relays anyone's groups are on, learned from the network rather than
 * written down here: the shared group lists people publish name the relay
 * holding each group. Whatever is in use out there is worth asking whether it
 * holds anything of this account's — which is how a group joined in another
 * app, on a relay nobody here has heard of, is found at all.
 */
export async function discoverGroupRelays(limit = 200): Promise<string[]> {
  try {
    const lists = await getRelayPool().fetchEvents([
      { kinds: [EVENT_KINDS.GROUP_LIST], limit }
    ]);

    const seen = new Map<string, number>();
    for (const list of lists) {
      for (const t of list.tags) {
        if (t[0] !== 'group' || !t[2]) continue;
        const url = t[2].replace(/\/$/, '');
        if (!/^wss?:\/\//i.test(url)) continue;
        seen.set(url, (seen.get(url) || 0) + 1);
      }
    }

    // The busiest first, and not too many of them: each one costs a
    // connection to ask
    return Array.from(seen.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([url]) => url);
  } catch (error) {
    console.warn('[Groups] Could not look around for group relays:', error);
    return [];
  }
}

export function setGroupRelays(urls: string[]): void {
  const cleaned = Array.from(new Set(urls.map(u => u.trim()).filter(Boolean)));
  localStorage.setItem(GROUP_RELAYS_KEY, JSON.stringify(cleaned));
}

// ---------------------------------------------------------------------------
// Reading a relay's groups
// ---------------------------------------------------------------------------

const tag = (event: NostrEventSigned, name: string): string | undefined =>
  event.tags.find(t => t[0] === name)?.[1];

const hasTag = (event: NostrEventSigned, name: string): boolean =>
  event.tags.some(t => t[0] === name);

function parseGroup(relay: string, event: NostrEventSigned, members?: number): GroupInfo | null {
  const id = tag(event, 'd');
  if (!id) return null;
  return {
    relay,
    id,
    name: tag(event, 'name') || id,
    about: tag(event, 'about') || '',
    picture: tag(event, 'picture') || '',
    // A group says which it is; saying neither means public and open, which
    // is what the relays that carry the big open groups do
    isPublic: hasTag(event, 'public') || !hasTag(event, 'private'),
    isOpen: hasTag(event, 'open') || !hasTag(event, 'closed'),
    members,
    updatedAt: event.created_at || 0
  };
}

/** Every group this relay is willing to talk about */
export async function fetchGroups(relay: string, limit = 200): Promise<GroupInfo[]> {
  const [metadata, memberLists] = await Promise.all([
    read(relay, [{ kinds: [EVENT_KINDS.GROUP_METADATA], limit }]),
    read(relay, [{ kinds: [EVENT_KINDS.GROUP_MEMBERS], limit }])
  ]);

  const counts = new Map<string, number>();
  for (const list of memberLists) {
    const id = tag(list, 'd');
    if (id) counts.set(id, list.tags.filter(t => t[0] === 'p').length);
  }

  const groups: GroupInfo[] = [];
  for (const event of metadata) {
    const group = parseGroup(relay, event, counts.get(tag(event, 'd') || ''));
    if (group) groups.push(group);
  }
  return groups.sort((a, b) => (b.members || 0) - (a.members || 0));
}

/** One group, for a relay that holds thousands and should not send them all */
export async function fetchGroup(address: GroupAddress): Promise<GroupInfo | null> {
  const [metadata, members] = await Promise.all([
    read(address.relay, [{ kinds: [EVENT_KINDS.GROUP_METADATA], '#d': [address.id], limit: 1 }]),
    read(address.relay, [{ kinds: [EVENT_KINDS.GROUP_MEMBERS], '#d': [address.id], limit: 1 }])
  ]);
  if (metadata.length === 0) return null;
  const count = members[0]?.tags.filter(t => t[0] === 'p').length;
  return parseGroup(address.relay, metadata[0], count);
}

/**
 * The groups on this relay whose member list names you — which is what the
 * relay itself considers you a member of, whatever any client wrote down. A
 * group joined through another app, or one an admin added you to, is only
 * knowable this way.
 */
export async function fetchMyGroupsOn(relay: string, pubkey: string): Promise<string[]> {
  const lists = await read(relay, [
    { kinds: [EVENT_KINDS.GROUP_MEMBERS], '#p': [pubkey], limit: 100 }
  ]);
  const ids = new Set<string>();
  for (const list of lists) {
    const id = tag(list, 'd');
    if (id) ids.add(id);
  }
  return Array.from(ids);
}

/** Who is in it */
export async function fetchGroupMembers(address: GroupAddress): Promise<string[]> {
  const lists = await read(address.relay, [
    { kinds: [EVENT_KINDS.GROUP_MEMBERS], '#d': [address.id], limit: 1 }
  ]);
  return lists[0]?.tags.filter(t => t[0] === 'p' && t[1]).map(t => t[1]) || [];
}

export interface GroupRole {
  pubkey: string;
  /** What the group calls them: admin, moderator, king, whatever it uses */
  role: string;
}

/**
 * Who runs it, and under what title. A relay writes each one as
 * ['p', pubkey, role], and the group's own list of roles (kind 39003) says
 * what each title means — worth having, since a group may call its admins
 * anything it likes.
 */
export async function fetchGroupAdmins(
  address: GroupAddress
): Promise<{ people: GroupRole[]; meanings: Record<string, string> }> {
  const [lists, roleLists] = await Promise.all([
    read(address.relay, [{ kinds: [EVENT_KINDS.GROUP_ADMINS], '#d': [address.id], limit: 1 }]),
    read(address.relay, [{ kinds: [EVENT_KINDS.GROUP_ROLES], '#d': [address.id], limit: 1 }])
  ]);

  const people: GroupRole[] = (lists[0]?.tags || [])
    .filter(t => t[0] === 'p' && t[1])
    .map(t => ({ pubkey: t[1], role: t[2] || 'admin' }));

  const meanings: Record<string, string> = {};
  for (const t of roleLists[0]?.tags || []) {
    if (t[0] === 'role' && t[1]) meanings[t[1]] = t[2] || '';
  }

  return { people, meanings };
}

/**
 * What has been said in it, oldest first, as a chat reads — and, where the
 * relay would not say, the reason it gave. A private group answers "you're
 * trying to access a private group" rather than with an empty room, and the
 * difference is worth passing on.
 */
export async function fetchGroupChat(
  address: GroupAddress,
  limit = 100
): Promise<{ messages: NostrEventSigned[]; refusal: string | null }> {
  const { events, refusal } = await relayAt(address.relay).readWithReason([
    {
      kinds: [EVENT_KINDS.GROUP_CHAT, EVENT_KINDS.GROUP_THREAD],
      '#h': [address.id],
      limit
    }
  ]);
  return {
    messages: events.sort((a, b) => (a.created_at || 0) - (b.created_at || 0)),
    refusal
  };
}

/** Whatever is said from now on */
export function subscribeGroupChat(
  address: GroupAddress,
  onMessage: (event: NostrEventSigned) => void
): Promise<() => void> {
  return relayAt(address.relay).watch(
    [
      {
        kinds: [EVENT_KINDS.GROUP_CHAT, EVENT_KINDS.GROUP_THREAD],
        '#h': [address.id],
        since: Math.floor(Date.now() / 1000) - 60
      }
    ],
    onMessage
  );
}

// ---------------------------------------------------------------------------
// Taking part
// ---------------------------------------------------------------------------

async function publishToGroup(address: GroupAddress, event: NostrEvent): Promise<NostrEventSigned> {
  const signed = await NostrCore.signAnyMode(event);
  await relayAt(address.relay).publish(signed);
  return signed;
}

/**
 * Say something in a group. Anyone named in it is tagged as well, which is
 * how they are told they were spoken to.
 */
export function sendGroupMessage(address: GroupAddress, content: string): Promise<NostrEventSigned> {
  const tags: string[][] = [['h', address.id]];

  for (const mention of content.match(/nostr:(?:npub1|nprofile1)[023456789acdefghjklmnpqrstuvwxyz]+/gi) || []) {
    try {
      const decoded = nip19.decode(mention.replace(/^nostr:/i, ''));
      const pubkey = decoded.type === 'npub'
        ? (decoded.data as string)
        : decoded.type === 'nprofile'
          ? (decoded.data as { pubkey: string }).pubkey
          : null;
      if (pubkey && !tags.some(t => t[0] === 'p' && t[1] === pubkey)) tags.push(['p', pubkey]);
    } catch {
      // Not a name after all
    }
  }

  return publishToGroup(address, { kind: EVENT_KINDS.GROUP_CHAT, content, tags });
}

/**
 * Reacting to something said in a group. NIP-25 as everywhere else, with the
 * group's own tag on it so the relay knows where it belongs.
 */
export function reactToGroupMessage(
  address: GroupAddress,
  message: NostrEventSigned,
  emoji: string,
  emojiUrl?: string
): Promise<NostrEventSigned> {
  const tags: string[][] = [
    ['h', address.id],
    ['e', message.id],
    ['p', message.pubkey],
    ['k', String(message.kind)]
  ];
  // A custom emoji is sent as its shortcode plus where the picture lives
  if (emojiUrl) tags.push(['emoji', emoji.replace(/:/g, ''), emojiUrl]);

  return publishToGroup(address, { kind: EVENT_KINDS.REACTION, content: emoji, tags });
}

/** Everything said about these messages: reactions, and zaps paid for them */
export async function fetchGroupMessageResponses(
  address: GroupAddress,
  messageIds: string[]
): Promise<NostrEventSigned[]> {
  if (messageIds.length === 0) return [];
  return read(address.relay, [
    {
      kinds: [EVENT_KINDS.REACTION, EVENT_KINDS.ZAP_RECEIPT],
      '#e': messageIds.slice(0, 200),
      limit: 500
    }
  ]);
}

/** Answering one message rather than the room */
export function replyInGroup(
  address: GroupAddress,
  to: NostrEventSigned,
  content: string
): Promise<NostrEventSigned> {
  const tags: string[][] = [
    ['h', address.id],
    // Marked the way a thread is marked everywhere else, so a client that
    // does not know groups can still see what answers what
    ['e', to.id, '', 'reply'],
    ['p', to.pubkey]
  ];
  return publishToGroup(address, { kind: EVENT_KINDS.GROUP_CHAT, content, tags });
}

/**
 * A thread is any message answered in one: the group's own long-form (a kind
 * 11 with a subject) or a line of chat somebody took aside. Either way the
 * answers are NIP-22 comments naming it as their root.
 */
export async function fetchThreadReplies(
  address: GroupAddress,
  threadId: string
): Promise<NostrEventSigned[]> {
  const found = await read(address.relay, [
    { kinds: [EVENT_KINDS.COMMENT, EVENT_KINDS.GROUP_CHAT], '#e': [threadId], limit: 200 }
  ]);
  return found.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
}

export function replyInThread(
  address: GroupAddress,
  thread: NostrEventSigned,
  content: string
): Promise<NostrEventSigned> {
  return publishToGroup(address, {
    kind: EVENT_KINDS.COMMENT,
    content,
    tags: [
      ['h', address.id],
      ['E', thread.id], ['K', String(thread.kind)], ['P', thread.pubkey],
      ['e', thread.id], ['k', String(thread.kind)], ['p', thread.pubkey]
    ]
  });
}

/**
 * Making a group. The relay is asked to create it and then told what it is
 * called; a relay that does not let strangers make groups says so, and that
 * is worth passing on rather than leaving a half-made room behind.
 */
export async function createGroup(
  relay: string,
  id: string,
  about: { name: string; about?: string; picture?: string; open?: boolean; publicGroup?: boolean }
): Promise<GroupAddress> {
  const address: GroupAddress = { relay, id };

  await publishToGroup(address, {
    kind: EVENT_KINDS.GROUP_CREATE,
    content: '',
    tags: [['h', id]]
  });

  const tags: string[][] = [['h', id], ['name', about.name]];
  if (about.about) tags.push(['about', about.about]);
  if (about.picture) tags.push(['picture', about.picture]);
  tags.push([about.publicGroup === false ? 'private' : 'public']);
  tags.push([about.open === false ? 'closed' : 'open']);

  await publishToGroup(address, { kind: EVENT_KINDS.GROUP_EDIT_METADATA, content: '', tags });
  return address;
}

/** Ask to be let in. An open group lets you in at once; a closed one asks its admins. */
export function requestToJoin(address: GroupAddress, code?: string): Promise<NostrEventSigned> {
  const tags: string[][] = [['h', address.id]];
  if (code) tags.push(['code', code]);
  return publishToGroup(address, { kind: EVENT_KINDS.GROUP_JOIN_REQUEST, content: '', tags });
}

export function requestToLeave(address: GroupAddress): Promise<NostrEventSigned> {
  return publishToGroup(address, {
    kind: EVENT_KINDS.GROUP_LEAVE_REQUEST,
    content: '',
    tags: [['h', address.id]]
  });
}

// ---------------------------------------------------------------------------
// The groups this account is in
//
// NIP-51 keeps that list as one replaceable event on the account's own
// relays, not on the group relays — so the same groups are there in Armada,
// Chachi or 0xchat, and here.
// ---------------------------------------------------------------------------

const JOINED_CACHE_KEY = 'nostr_groups_joined';

function readJoinedCache(): GroupAddress[] {
  try {
    const stored = localStorage.getItem(JOINED_CACHE_KEY);
    const parsed = stored ? (JSON.parse(stored) as GroupAddress[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeJoinedCache(groups: GroupAddress[]): void {
  localStorage.setItem(JOINED_CACHE_KEY, JSON.stringify(groups));
}

/** What this browser last knew, drawn while the relays are asked */
export function joinedGroupsFromCache(): GroupAddress[] {
  return readJoinedCache();
}

export async function fetchJoinedGroups(): Promise<GroupAddress[]> {
  const own = CredentialManager.getPublicKey();
  if (!own) return [];

  try {
    const events = await getRelayPool().fetchEvents([
      { kinds: [EVENT_KINDS.GROUP_LIST], authors: [own], limit: 5 }
    ], true);
    if (events.length === 0) return readJoinedCache();

    const newest = events.reduce((latest, event) =>
      (event.created_at || 0) > (latest.created_at || 0) ? event : latest
    );

    // NIP-51 writes each one as ['group', <id>, <relay>]
    const groups: GroupAddress[] = [];
    for (const t of newest.tags) {
      if (t[0] !== 'group' || !t[1]) continue;
      const relay = t[2] || '';
      if (!relay) continue;
      groups.push({ id: t[1], relay });
    }
    writeJoinedCache(groups);
    return groups;
  } catch (error) {
    console.warn('[Groups] Could not read the list of groups:', error);
    return readJoinedCache();
  }
}

async function publishJoinedGroups(groups: GroupAddress[]): Promise<void> {
  writeJoinedCache(groups);
  if (!CredentialManager.canSign()) return;

  const signed = await NostrCore.signAnyMode({
    kind: EVENT_KINDS.GROUP_LIST,
    content: '',
    tags: groups.map(group => ['group', group.id, group.relay])
  } as NostrEvent);
  await getRelayPool().publishEvent(signed);
}

/**
 * Join: ask the relay to let you in, and remember the group. An open group
 * takes you at once; a closed one leaves the request with its admins, and the
 * group is remembered either way so the answer can be seen when it comes.
 */
export async function joinGroup(address: GroupAddress, code?: string): Promise<void> {
  await requestToJoin(address, code);
  const joined = readJoinedCache().filter(g => groupKey(g) !== groupKey(address));
  await publishJoinedGroups([...joined, address]);
}

export async function leaveGroup(address: GroupAddress): Promise<void> {
  try {
    await requestToLeave(address);
  } catch (error) {
    // The relay may not care to hear it; the list is still ours to change
    console.warn('[Groups] The relay would not take the leave request:', error);
  }
  await publishJoinedGroups(readJoinedCache().filter(g => groupKey(g) !== groupKey(address)));
}
