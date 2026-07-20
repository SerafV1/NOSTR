import { NostrEventSigned, NostrFilter, EVENT_KINDS } from '../types';
import { getRelayPool } from './relay';

export type NotificationType = 'reply' | 'mention' | 'reaction' | 'repost' | 'zap';

export interface NostrNotification {
  id: string;
  type: NotificationType;
  event: NostrEventSigned;
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
      const events = await relayPool.fetchEvents(filters);

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
 * Tracks the last-seen notification timestamp per pubkey in localStorage
 * so the unread badge survives reloads.
 */
export class NotificationStore {
  private static readonly PREFIX = 'nostr_notifications_seen_';

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

  static countUnread(pubkey: string, notifications: NostrNotification[]): number {
    const lastSeen = this.getLastSeen(pubkey);
    return notifications.filter(n => (n.event.created_at || 0) > lastSeen).length;
  }
}
