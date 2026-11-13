import { NostrEventSigned, NostrFilter, EVENT_KINDS } from '../types';
import { getRelayPool } from './relay';
import { PersistentCache, NostrCore } from './core';
import { nip19 } from 'nostr-tools';
import { directParentId, isReplyEvent, targetOfResponse } from '../utils/threads';

export type NotificationType =
  | 'reply' | 'mention' | 'reaction' | 'repost' | 'zap' | 'livechat'
  | 'follow' | 'unfollow';

export interface NostrNotification {
  id: string;
  type: NotificationType;
  event: NostrEventSigned;
}

// Enough history to scroll back through without letting the list grow forever
const NOTIFICATION_CACHE_LIMIT = 200;

/**
 * Relays asked for mentions on top of this account's own.
 *
 * A reply lives on the relays its author publishes to, which need not be any
 * of the ones being read here — a comment answered on this very account was
 * on premium.primal.net and nostr.wine and on none of its ten relays, so it
 * existed everywhere except where anyone here could see it. These two carry
 * a wide slice of the network and answer reads without an account, which
 * turns a mention that would have been invisible into one that arrives.
 *
 * Read-only, and only for notifications: nothing is published to them, and
 * they are not added to anyone's relay list.
 */
const WIDER_RELAYS = ['wss://nostr.wine', 'wss://premium.primal.net'];

/**
 * How far back a browser's first look still counts as news for follows.
 * Long enough that opening the app on a new phone does not lose the people
 * who followed you yesterday, short enough that it is not a history dump.
 */
const FIRST_LOOK_WINDOW_S = 2 * 24 * 60 * 60;

/**
 * Who is known to follow you, so a contact list that arrives can be told
 * apart: a name that was not there before is a new follower, and one that
 * disappears from a list that used to carry you is someone leaving. Nostr
 * announces neither — a follow is just a replaceable list being rewritten,
 * so the only way to notice is to remember what it said last time.
 */
const knownFollowersKey = (pubkey: string): string => `known_followers_${pubkey}`;
/** When this browser started watching — anything older than it is history */
const followersSinceKey = (pubkey: string): string => `known_followers_since_${pubkey}`;

/** null when this browser has never looked — which is not the same as none */
function readKnownFollowers(pubkey: string): string[] | null {
  return PersistentCache.get<string[]>(knownFollowersKey(pubkey));
}

function writeKnownFollowers(pubkey: string, followers: string[]): void {
  PersistentCache.set(knownFollowersKey(pubkey), Array.from(new Set(followers)));
}

function watchingSince(pubkey: string): number {
  return PersistentCache.get<number>(followersSinceKey(pubkey)) || 0;
}

/**
 * Whether a reply was written to you, or merely near you.
 *
 * A reply carries a `p` tag for everyone in the thread above it — that is
 * how NIP-10 says to write one — so asking a relay for notes that tag you
 * returns every reply in every conversation you have ever taken part in.
 * Two other people answering each other under your post, or further down a
 * thread you left a line in, each arrived as "replied to you".
 *
 * A reply is yours when the note it directly answers is yours, or when it
 * names you in its text. Anything else is the thread carrying on. A parent
 * that cannot be found is given the benefit of the doubt: a notification
 * shown that need not have been costs a glance, one hidden that should
 * have been shown costs an answer somebody is waiting on.
 */
const addressedKey = (pubkey: string): string => `notifications_addressed_${pubkey}`;
const ADDRESSED_LIMIT = 1500;

/** id → whether it was for you. Judged once; the answer does not change. */
function readAddressed(pubkey: string): Record<string, 0 | 1> {
  return PersistentCache.get<Record<string, 0 | 1>>(addressedKey(pubkey)) || {};
}

/** Named in the words themselves, not only in the tags */
function namesInText(event: NostrEventSigned, pubkey: string): boolean {
  const content = event.content || '';
  for (const match of content.matchAll(/(?:nostr:)?(npub1[a-z0-9]{20,}|nprofile1[a-z0-9]{20,})/g)) {
    try {
      const decoded = nip19.decode(match[1]);
      if (decoded.type === 'npub' && decoded.data === pubkey) return true;
      if (decoded.type === 'nprofile' && (decoded.data as { pubkey: string }).pubkey === pubkey) return true;
    } catch {
      // Not a real address; it names nobody
    }
  }
  // The older way of naming somebody: "#[2]" pointing at a tag
  for (const match of content.matchAll(/#\[(\d+)\]/g)) {
    const tag = event.tags[Number(match[1])];
    if (tag?.[0] === 'p' && tag[1] === pubkey) return true;
  }
  return false;
}

/**
 * A like or a repost of somebody else's note that happens to tag you.
 *
 * A reaction is meant to carry the tags of the note it reacts to, and a
 * reply's tags name everyone in the thread above it — so a like on another
 * person's reply, under your post or beside your own reply, tags you too,
 * and arrived as "reacted to your note" about a note that was not yours.
 */
function isResponse(notification: NostrNotification): boolean {
  return notification.event.kind === EVENT_KINDS.REACTION
    || notification.event.kind === EVENT_KINDS.REPOST;
}

/** Only these can be the thread carrying on; everything else stands */
function couldBeChatter(notification: NostrNotification): boolean {
  if (isResponse(notification)) return true;
  return notification.event.kind === EVENT_KINDS.TEXT_NOTE && isReplyEvent(notification.event);
}

/**
 * Whether the thread carrying on is wanted after all. Off unless asked for:
 * some people do want to follow a conversation they joined, and for them
 * these arrive — labelled as what they are, not as replies to them.
 */
const THREAD_REPLIES = 'nostr_notifications_thread_replies';

export const notificationsIncludeThreads = (): boolean => {
  try {
    return localStorage.getItem(THREAD_REPLIES) === '1';
  } catch {
    return false;
  }
};

export const setNotificationsIncludeThreads = (include: boolean): void => {
  try {
    localStorage.setItem(THREAD_REPLIES, include ? '1' : '0');
  } catch {
    // A browser that will not store it simply asks again next time
  }
};

/** A reply found to be somebody answering somebody else in your thread */
export function isThreadChatter(pubkey: string, notificationId: string): boolean {
  return readAddressed(pubkey)[notificationId] === 0;
}

/** Leaves out the replies already found to be other people talking */
export function dropThreadChatter(pubkey: string, notifications: NostrNotification[]): NostrNotification[] {
  if (notificationsIncludeThreads()) return notifications;
  const addressed = readAddressed(pubkey);
  return notifications.filter(n => addressed[n.id] !== 0);
}

/**
 * Judge the replies not judged yet, and remember the answers. The parents
 * are looked up together, and most are already in memory: a thread you are
 * in is one you have usually read.
 */
async function judgeReplies(pubkey: string, notifications: NostrNotification[]): Promise<void> {
  const addressed = readAddressed(pubkey);
  const pending = notifications.filter(n => couldBeChatter(n) && !(n.id in addressed));
  if (pending.length === 0) return;

  const parentOf = new Map<string, string>();
  const authorOf = new Map<string, string>();
  /** What to say when the note a like points at cannot be found */
  const fallback = new Map<string, 0 | 1>();
  for (const notification of pending) {
    const { event } = notification;
    if (isResponse(notification)) {
      const target = targetOfResponse(event);
      if (!target) {
        addressed[event.id] = 1;
        continue;
      }
      parentOf.set(event.id, target);
      // NIP-25: the last `p` tag is the author of the note reacted to. Used
      // only when the note itself cannot be found, and only when there is
      // more than one to choose between — a lone tag naming you is plain.
      const people = event.tags.filter(t => t[0] === 'p' && t[1]).map(t => t[1]);
      fallback.set(event.id, people.length > 1 && people[people.length - 1] !== pubkey ? 0 : 1);
      continue;
    }
    if (namesInText(event, pubkey)) {
      addressed[event.id] = 1;
      continue;
    }
    const parent = directParentId(event);
    if (!parent) {
      addressed[event.id] = 1;
      continue;
    }
    parentOf.set(event.id, parent);
    // NIP-10 lets the tag itself say who wrote the note it points at
    const hinted = event.tags.find(t => t[0] === 'e' && t[1] === parent)?.[4];
    if (hinted && /^[0-9a-f]{64}$/.test(hinted)) authorOf.set(parent, hinted);
  }

  const unknown = Array.from(new Set(parentOf.values())).filter(id => !authorOf.has(id));
  if (unknown.length > 0) {
    try {
      const found = await NostrCore.fetchEventsByIds(unknown);
      for (const [id, event] of found) authorOf.set(id, event.pubkey);
    } catch {
      // Unfound parents fall through as "for you" below
    }
  }

  for (const [id, parent] of parentOf) {
    const author = authorOf.get(parent);
    addressed[id] = author ? (author === pubkey ? 1 : 0) : (fallback.get(id) ?? 1);
  }

  const entries = Object.entries(addressed);
  PersistentCache.set(
    addressedKey(pubkey),
    entries.length > ADDRESSED_LIMIT ? Object.fromEntries(entries.slice(-ADDRESSED_LIMIT)) : addressed
  );
}

const notificationsCacheKey = (pubkey: string): string => `notifications_${pubkey}`;

export function readCachedNotifications(pubkey: string): NostrNotification[] {
  return dropThreadChatter(
    pubkey,
    PersistentCache.get<NostrNotification[]>(notificationsCacheKey(pubkey)) || []
  );
}

/**
 * Whose notification this is.
 *
 * A zap receipt is signed by the wallet that paid it, not by the person who
 * chose to pay, so the one to name is inside the zap request it carries.
 */
export function notificationActor(event: NostrEventSigned): string {
  return event.kind === EVENT_KINDS.ZAP_RECEIPT
    ? NostrCore.zapSenderPubkey(event) || event.pubkey
    : event.pubkey;
}

/**
 * Someone muted should not be able to reach you by liking, zapping or
 * replying: the mute list applied everywhere else, and notifications were
 * the one door left open.
 */
export function dropMuted(notifications: NostrNotification[]): NostrNotification[] {
  const muted = NostrCore.getBlockedPubkeys();
  if (muted.size === 0) return notifications;
  return notifications.filter(n => !muted.has(notificationActor(n.event)));
}

/** Whether this account only wants to hear from the people it follows */
const FOLLOWS_ONLY = 'razr_notifications_follows_only';

export const notificationsFromFollowsOnly = (): boolean => {
  try {
    return localStorage.getItem(FOLLOWS_ONLY) === '1';
  } catch {
    return false;
  }
};

export const setNotificationsFromFollowsOnly = (only: boolean): void => {
  try {
    localStorage.setItem(FOLLOWS_ONLY, only ? '1' : '0');
  } catch {
    // A browser that will not store it simply asks again next time
  }
};

/**
 * Only the people you follow, when that is what was asked for.
 *
 * Nothing is thrown away — the notifications are all still cached, and
 * unticking the box brings them straight back — this is only what reaches
 * the screen and the badge.
 *
 * An empty follow list means the relays have not handed one over yet, which
 * looks exactly like following nobody. Filtering on that would empty the page
 * for everyone whose contact list happens to be slow, so it is left alone
 * until there is a list to filter by.
 */
export function dropStrangers(
  notifications: NostrNotification[],
  follows: Set<string>
): NostrNotification[] {
  if (follows.size === 0) return notifications;
  return notifications.filter(n => follows.has(notificationActor(n.event)));
}

/**
 * Fold a fetch into what's already stored, and return the whole list.
 *
 * Both callers used to write the fetch straight over the cache. Relays answer
 * partially far more often than not — the pool returns shortly after the
 * first one replies — so a thin result quietly threw away everything older,
 * and an empty one wiped the page. Merging by id means a poor fetch can only
 * ever add.
 */
/**
 * A follow arrives as the whole of that person's contact list — two thousand
 * tags naming other people, seventy kilobytes of it, behind one line saying
 * they followed you. Kept as it came, twenty-seven of those filled three
 * megabytes and pushed this browser's storage to the edge of what it allows,
 * at which point writes fail silently: the badge counted a notification that
 * the page then could not find, and it only appeared once the page's own next
 * read of the relays happened to bring it back.
 *
 * Nothing here reads those tags. Unfollows are worked out from lists fetched
 * fresh, not from these. Only the one naming this account is worth keeping.
 */
function slimForStorage(notification: NostrNotification, owner: string): NostrNotification {
  const event = notification.event;
  if (event.kind !== EVENT_KINDS.CONTACTS) return notification;
  if (event.tags.length <= 1 && !event.content) return notification;

  return {
    ...notification,
    event: {
      ...event,
      tags: event.tags.filter(t => t[0] === 'p' && t[1] === owner),
      // The relay list some clients keep in a contact list's content, which
      // is nobody's business here either
      content: ''
    }
  };
}

export function cacheNotifications(
  pubkey: string,
  fresh: NostrNotification[]
): NostrNotification[] {
  const byId = new Map(readCachedNotifications(pubkey).map(n => [n.id, n]));
  for (const notification of fresh) byId.set(notification.id, notification);

  const merged = Array.from(byId.values())
    .sort((a, b) => (b.event.created_at || 0) - (a.event.created_at || 0))
    .slice(0, NOTIFICATION_CACHE_LIMIT);

  // Slimmed on the way to storage — including what is already there, so a
  // browser carrying the old, fat copies is cleaned out by the next write
  PersistentCache.set(
    notificationsCacheKey(pubkey),
    merged.map(notification => slimForStorage(notification, pubkey))
  );
  return merged;
}

/**
 * The notes a notification is *about* — the post that was liked, reposted or
 * zapped. They live in memory otherwise, so every reload showed the list
 * without its previews until the network answered again. Kept beside the
 * notifications, and trimmed to the same horizon.
 */
const targetsCacheKey = (pubkey: string): string => `notification_targets_${pubkey}`;

export function readCachedTargets(pubkey: string): Record<string, NostrEventSigned> {
  return PersistentCache.get<Record<string, NostrEventSigned>>(targetsCacheKey(pubkey)) || {};
}

export function cacheTargets(
  pubkey: string,
  targets: Record<string, NostrEventSigned>
): Record<string, NostrEventSigned> {
  const merged = { ...readCachedTargets(pubkey), ...targets };

  // Bounded by the notifications they belong to, newest first
  const trimmed = Object.entries(merged)
    .sort(([, a], [, b]) => (b.created_at || 0) - (a.created_at || 0))
    .slice(0, NOTIFICATION_CACHE_LIMIT);

  const result = Object.fromEntries(trimmed);
  PersistentCache.set(targetsCacheKey(pubkey), result);
  return result;
}

/**
 * Notifications = events that reference (`#p`) the logged-in user:
 * replies/mentions (kind 1), reposts (kind 6), reactions (kind 7),
 * zap receipts (kind 9735) and being named in a live stream's chat
 * (kind 1311) — which otherwise passed unnoticed unless you happened to be
 * watching that stream at that moment.
 */
export class NotificationCore {
  /**
   * A kind-1 note that also has an `e` tag is a reply to something in the
   * thread; without one it's a plain mention. Other kinds map 1:1.
   */
  static classify(event: NostrEventSigned): NotificationType {
    switch (event.kind) {
      case EVENT_KINDS.LIVE_CHAT_MESSAGE:
        return 'livechat';
      case EVENT_KINDS.REACTION:
        return 'reaction';
      case EVENT_KINDS.REPOST:
        return 'repost';
      case EVENT_KINDS.ZAP_RECEIPT:
        return 'zap';
      default:
        return event.tags.some(t => t[0] === 'e') ? 'reply' : 'mention';
    }
  }

  static async fetchNotifications(
    pubkey: string,
    limit: number = 100,
    since?: number,
    /**
     * Nothing newer than this — for reading further back. A relay answers
     * with its newest hundred, so the first fetch reaches a week or so into
     * a busy account; this is the next page.
     */
    until?: number
  ): Promise<NostrNotification[]> {
    const filters: NostrFilter[] = [
      {
        kinds: [
          EVENT_KINDS.TEXT_NOTE,
          // A reply written the NIP-22 way. Without this, replies from
          // Amethyst — which now writes every one of them like that — reach
          // nobody here: no notification, and no sign anyone answered.
          EVENT_KINDS.COMMENT,
          EVENT_KINDS.REPOST,
          EVENT_KINDS.REACTION,
          EVENT_KINDS.ZAP_RECEIPT,
          EVENT_KINDS.LIVE_CHAT_MESSAGE
        ],
        '#p': [pubkey],
        limit,
        ...(since !== undefined ? { since } : {}),
        ...(until !== undefined ? { until } : {})
      },
      // Contact lists naming you: whoever publishes one follows you. Not
      // asked for when reading back: a follow is news only when it happens,
      // and an old list says nothing about when that was.
      ...(until !== undefined ? [] : [{
        kinds: [EVENT_KINDS.CONTACTS],
        '#p': [pubkey],
        limit,
        ...(since !== undefined ? { since } : {})
      }])
    ];

    try {
      const relayPool = getRelayPool();
      // waitForAll — without this, which relay happens to answer within
      // the early-exit window varies call to call, so the "seen up to X"
      // marker (computed from whatever this particular call returned)
      // could miss a notification that only a slower relay has. That
      // notification then never actually gets marked as seen, and
      // resurfaces as unread again on a later poll that does catch it.
      // The account's own relays, plus a couple of wide ones: a mention only
      // its author's relays hold is invisible otherwise
      const [own, wider] = await Promise.all([
        relayPool.fetchEvents(filters, true),
        relayPool.fetchEventsFromExtraRelays(WIDER_RELAYS, filters).catch(() => [])
      ]);

      const byId = new Map<string, NostrEventSigned>();
      for (const event of [...own, ...wider]) byId.set(event.id, event);
      const events = [...byId.values()];

      // Drop future-dated spam (clock skew / bad actors) and your own
      // actions (you get #p'd on your own replies-to-self, reactions, etc.)
      const maxTimestamp = Math.floor(Date.now() / 1000) + 300;
      const usable = events
        .filter(e => (e.created_at || 0) <= maxTimestamp)
        .filter(e => e.pubkey !== pubkey);

      // A contact list is rewritten every time its owner follows anyone, so
      // only the first sight of someone counts as them following you
      const stored = readKnownFollowers(pubkey);
      // Nothing recorded yet means this browser is seeing the followers for
      // the first time. Everyone who followed long ago is remembered quietly —
      // a first visit greeting you with every follower you ever had is no
      // use — but the last couple of days are still news, and were being
      // swallowed: someone who followed an hour before this browser first
      // looked showed up in other clients and never here.
      const firstLook = stored === null;
      const known = new Set(stored || []);
      const now = Math.floor(Date.now() / 1000);
      // Relays answer partially, so a follower the first look missed turns up
      // on a later one and would read as brand new. Only a list published
      // after this browser started watching can be news — except on that
      // first look, where the window is what is recent rather than nothing.
      const since = firstLook ? now - FIRST_LOOK_WINDOW_S : watchingSince(pubkey);
      const follows: NostrNotification[] = [];
      for (const event of usable) {
        if (event.kind !== EVENT_KINDS.CONTACTS) continue;
        if (known.has(event.pubkey)) continue;
        known.add(event.pubkey);
        if ((event.created_at || 0) > since) {
          follows.push({ id: `follow-${event.pubkey}`, type: 'follow', event });
        }
      }
      // Watching starts now, whatever was announced: the window above is for
      // what to say on this first look, not for what counts as new later
      if (firstLook) PersistentCache.set(followersSinceKey(pubkey), now);
      if (firstLook || follows.length || usable.some(e => e.kind === EVENT_KINDS.CONTACTS)) {
        writeKnownFollowers(pubkey, Array.from(known));
      }

      const rest = usable
        .filter(e => e.kind !== EVENT_KINDS.CONTACTS)
        .map(e => ({ id: e.id, type: this.classify(e), event: e }));

      // What is kept from earlier visits is judged along with what just
      // arrived, so the chatter already sitting in the list goes as well
      await judgeReplies(pubkey, [
        ...rest,
        ...(PersistentCache.get<NostrNotification[]>(notificationsCacheKey(pubkey)) || [])
      ]);

      return dropThreadChatter(pubkey, [...rest, ...follows])
        .sort((a, b) => (b.event.created_at || 0) - (a.event.created_at || 0))
        .slice(0, limit);
    } catch (error) {
      console.error('Failed to fetch notifications:', error);
      return [];
    }
  }

  /**
   * Who stopped following you. There is no filter for this: an unfollow is a
   * contact list that no longer names you, and a relay cannot be asked for
   * events by what they *lack*. So the lists of everyone known to follow you
   * are fetched and checked, and anyone whose newest list has dropped you is
   * reported once, then forgotten until they follow again.
   */
  static async fetchUnfollows(pubkey: string): Promise<NostrNotification[]> {
    const known = readKnownFollowers(pubkey);
    if (!known || known.length === 0) return [];

    try {
      const events = await getRelayPool().fetchEvents([
        { kinds: [EVENT_KINDS.CONTACTS], authors: known, limit: known.length * 2 }
      ]);

      // Only the newest list from each of them says anything current
      const newest = new Map<string, NostrEventSigned>();
      for (const event of events) {
        const held = newest.get(event.pubkey);
        if (!held || (event.created_at || 0) > (held.created_at || 0)) {
          newest.set(event.pubkey, event);
        }
      }

      const gone: NostrNotification[] = [];
      const stillFollowing = new Set(known);
      const since = watchingSince(pubkey);
      for (const [author, event] of newest) {
        const followsMe = event.tags.some(t => t[0] === 'p' && t[1] === pubkey);
        if (followsMe) continue;
        // A list older than when we started watching proves nothing: it may
        // simply be a stale copy from before they followed, which some relay
        // still holds
        if ((event.created_at || 0) <= since) continue;
        stillFollowing.delete(author);
        gone.push({ id: `unfollow-${author}-${event.created_at}`, type: 'unfollow', event });
      }

      if (gone.length) writeKnownFollowers(pubkey, Array.from(stillFollowing));
      return gone;
    } catch (error) {
      console.error('Failed to check for unfollows:', error);
      return [];
    }
  }
}

/**
 * Tracks which notifications have been seen, per pubkey, in localStorage
 * so the unread badge survives reloads.
 */
export class NotificationStore {
  private static readonly PREFIX = 'nostr_notifications_seen_';
  private static readonly SEEN_IDS_PREFIX = 'nostr_notifications_seen_ids_';
  // Bounded so localStorage doesn't grow forever — old enough entries fall
  // off the end and back to relying on the legacy timestamp cutoff, which
  // is harmless since anything that old is well past it anyway
  private static readonly MAX_SEEN_IDS = 1000;

  static getLastSeen(pubkey: string): number {
    try {
      const raw = localStorage.getItem(this.PREFIX + pubkey);
      return raw ? parseInt(raw, 10) : 0;
    } catch {
      return 0;
    }
  }

  static setLastSeen(pubkey: string, timestamp: number): void {
    try {
      localStorage.setItem(this.PREFIX + pubkey, String(timestamp));
    } catch {
      // Best effort — a full quota just means the badge may re-show later
    }
  }

  private static getSeenIds(pubkey: string): string[] {
    try {
      const raw = localStorage.getItem(this.SEEN_IDS_PREFIX + pubkey);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  /**
   * Mark specific notifications as seen by id, not just "everything before
   * timestamp X" — a single relay being slow/unreachable on any one fetch
   * (background poll vs. the notifications page's own load race
   * independently against relay timing) meant a notification could keep
   * missing the "newest" cutoff on the visit that was supposed to clear
   * it, then reappear as unread the moment some other fetch happened to
   * reach the relay that has it. Once a notification has been shown here
   * even once, it should stay read regardless of later fetch luck.
   */
  static markSeen(pubkey: string, ids: string[]): void {
    if (ids.length === 0) return;
    try {
      const current = this.getSeenIds(pubkey);
      const currentSet = new Set(current);
      const merged = [...current, ...ids.filter(id => !currentSet.has(id))];
      const trimmed = merged.slice(-this.MAX_SEEN_IDS);
      localStorage.setItem(this.SEEN_IDS_PREFIX + pubkey, JSON.stringify(trimmed));
    } catch {
      // Best effort — a full quota just means the badge may re-show later
    }
  }

  static countUnread(pubkey: string, notifications: NostrNotification[]): number {
    const seenIds = new Set(this.getSeenIds(pubkey));
    const lastSeen = this.getLastSeen(pubkey);
    return notifications.filter(n => {
      if (seenIds.has(n.id)) return false;
      // Falls back to the timestamp cutoff for anything from before
      // per-id tracking existed
      return (n.event.created_at || 0) > lastSeen;
    }).length;
  }
}
