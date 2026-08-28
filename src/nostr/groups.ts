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

/** Where to look before anyone has added a relay of their own */
export const DEFAULT_GROUP_RELAYS = [
  'wss://groups.0xchat.com',
  'wss://groups.hzrd149.com',
  'wss://relay.damus.io'
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
};

class GroupRelay {
  private socket: WebSocket | null = null;
  private opening: Promise<void> | null = null;
  private subs = new Map<string, Waiting>();
  private publishes = new Map<string, (accepted: boolean, reason: string) => void>();
  private nextId = 0;

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
      this.subs.get(first)?.onEose?.();
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
    if (!CredentialManager.canSign()) return;
    try {
      const proof = await NostrCore.signAnyMode({
        kind: EVENT_KINDS.CLIENT_AUTH,
        content: '',
        tags: [['relay', this.url], ['challenge', challenge]]
      } as NostrEvent);
      this.send(['AUTH', proof]);
    } catch (error) {
      console.warn(`[Groups] Could not prove who we are to ${this.url}:`, error);
    }
  }

  private send(message: unknown[]): void {
    this.socket?.send(JSON.stringify(message));
  }

  /** Everything the relay holds for these filters, and then no more */
  async read(filters: NostrFilter[], waitMs = 5000): Promise<NostrEventSigned[]> {
    try {
      await this.open();
    } catch (error) {
      console.warn(`[Groups] ${this.url}:`, error);
      return [];
    }

    return new Promise<NostrEventSigned[]>(resolve => {
      const id = `r${this.nextId++}`;
      const found: NostrEventSigned[] = [];
      let done = false;

      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.subs.delete(id);
        this.send(['CLOSE', id]);
        resolve(found);
      };

      // A relay that wants to know who is asking can hold back its "that is
      // all" while sending the events themselves quite happily, so what has
      // arrived by the end of the wait is the answer
      const timer = setTimeout(finish, waitMs);
      this.subs.set(id, { onEvent: event => found.push(event), onEose: finish });
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

export function getGroupRelays(): string[] {
  try {
    const stored = localStorage.getItem(GROUP_RELAYS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as string[];
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    // Unreadable — fall back to the built-in set
  }
  return [...DEFAULT_GROUP_RELAYS];
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

/** Who is in it */
export async function fetchGroupMembers(address: GroupAddress): Promise<string[]> {
  const lists = await read(address.relay, [
    { kinds: [EVENT_KINDS.GROUP_MEMBERS], '#d': [address.id], limit: 1 }
  ]);
  return lists[0]?.tags.filter(t => t[0] === 'p' && t[1]).map(t => t[1]) || [];
}

/** Who runs it */
export async function fetchGroupAdmins(address: GroupAddress): Promise<string[]> {
  const lists = await read(address.relay, [
    { kinds: [EVENT_KINDS.GROUP_ADMINS], '#d': [address.id], limit: 1 }
  ]);
  return lists[0]?.tags.filter(t => t[0] === 'p' && t[1]).map(t => t[1]) || [];
}

/** What has been said in it, oldest first, as a chat reads */
export async function fetchGroupChat(address: GroupAddress, limit = 100): Promise<NostrEventSigned[]> {
  const messages = await read(address.relay, [
    {
      kinds: [EVENT_KINDS.GROUP_CHAT, EVENT_KINDS.GROUP_THREAD],
      '#h': [address.id],
      limit
    }
  ]);
  return messages.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
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

/** Say something in a group */
export function sendGroupMessage(address: GroupAddress, content: string): Promise<NostrEventSigned> {
  return publishToGroup(address, {
    kind: EVENT_KINDS.GROUP_CHAT,
    content,
    tags: [['h', address.id]]
  });
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
