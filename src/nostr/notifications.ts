import { NostrEventSigned, NostrFilter, EVENT_KINDS } from '../types';
import { getRelayPool } from './relay';
import { PersistentCache } from './core';

export type NotificationType = 'reply' | 'mention' | 'reaction' | 'repost' | 'zap';

export interface NostrNotification {
  id: string;
  type: NotificationType;
  event: NostrEventSigned;
}

// Enough history to scroll back through without letting the list grow forever
const NOTIFICATION_CACHE_LIMIT = 200;

const notificationsCacheKey = (pubkey: string): string => `notifications_${pubkey}`;

export function readCachedNotifications(pubkey: string): NostrNotification[] {
  return PersistentCache.get<NostrNotification[]>(notificationsCacheKey(pubkey)) || [];
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
export function cacheNotifications(
  pubkey: string,
  fresh: NostrNotification[]
): NostrNotification[] {
  const byId = new Map(readCachedNotifications(pubkey).map(n => [n.id, n]));
  for (const notification of fresh) byId.set(notification.id, notification);

  const merged = Array.from(byId.values())
    .sort((a, b) => (b.event.created_at || 0) - (a.event.created_at || 0))
    .slice(0, NOTIFICATION_CACHE_LIMIT);

  PersistentCache.set(notificationsCacheKey(pubkey), merged);
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
 * replies/mentions (kind 1), reposts (kind 6), reactions (kind 7) and
 * zap receipts (kind 9735).
 */
export class NotificationCore {
  /**
   * A kind-1 note that also has an `e` tag is a reply to something in the
   * thread; without one it's a plain mention. Other kinds map 1:1.
   */
  static classify(event: NostrEventSigned): NotificationType {
    switch (event.kind) {
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
    since?: number
  ): Promise<NostrNotification[]> {
    const filters: NostrFilter[] = [
      {
        kinds: [
          EVENT_KINDS.TEXT_NOTE,
          EVENT_KINDS.REPOST,
          EVENT_KINDS.REACTION,
          EVENT_KINDS.ZAP_RECEIPT
        ],
        '#p': [pubkey],
        limit,
        ...(since !== undefined ? { since } : {})
      }
    ];

    try {
      const relayPool = getRelayPool();
      // waitForAll — without this, which relay happens to answer within
      // the early-exit window varies call to call, so the "seen up to X"
      // marker (computed from whatever this particular call returned)
      // could miss a notification that only a slower relay has. That
      // notification then never actually gets marked as seen, and
      // resurfaces as unread again on a later poll that does catch it.
      const events = await relayPool.fetchEvents(filters, true);

      // Drop future-dated spam (clock skew / bad actors) and your own
      // actions (you get #p'd on your own replies-to-self, reactions, etc.)
      const maxTimestamp = Math.floor(Date.now() / 1000) + 300;
      return events
        .filter(e => (e.created_at || 0) <= maxTimestamp)
        .filter(e => e.pubkey !== pubkey)
        .map(e => ({ id: e.id, type: this.classify(e), event: e }))
        .sort((a, b) => (b.event.created_at || 0) - (a.event.created_at || 0))
        .slice(0, limit);
    } catch (error) {
      console.error('Failed to fetch notifications:', error);
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
