import { 
  NostrEventSigned, 
  NostrEvent, 
  UserProfile, 
  NostrFilter,
  EVENT_KINDS,
  EventWithMetadata
} from '../types';
import { NostrCrypto, CredentialManager, ExtensionManager } from './crypto';
import { getRelayPool } from './relay';

/**
 * Core NOSTR protocol operations
 */
export class NostrCore {
  /**
   * Create and publish a text note
   */
  static async publishNote(
    content: string,
    replyTo?: string,
    hashtags?: string[]
  ): Promise<NostrEventSigned | null> {
    const isExtension = CredentialManager.isExtensionMode();
    
    if (!isExtension && !CredentialManager.getPrivateKey()) {
      console.error('Private key not found');
      return null;
    }

    const tags: string[][] = [];
    
    if (replyTo) {
      tags.push(['e', replyTo, '', 'reply']);
    }

    hashtags?.forEach(tag => {
      tags.push(['t', tag.toLowerCase()]);
    });

    const event: NostrEvent = {
      kind: EVENT_KINDS.TEXT_NOTE,
      content,
      tags
    };

    try {
      let signed: NostrEventSigned;

      if (isExtension) {
        signed = await this.signEventWithExtension(event);
      } else {
        const privkey = CredentialManager.getPrivateKey();
        if (!privkey) throw new Error('Private key not found');
        signed = NostrCrypto.signEvent(event, privkey);
      }

      if (!signed) throw new Error('Failed to sign event');

      const relayPool = getRelayPool();
      const results = await relayPool.publishEvent(signed);
      if (!Array.from(results.values()).some(Boolean)) {
        throw new Error('No relay accepted the note');
      }
      return signed;
    } catch (error) {
      console.error('Failed to publish note:', error);
      return null;
    }
  }

  /**
   * Publish user metadata (kind 0)
   */
  static async publishProfile(profile: Partial<UserProfile>): Promise<NostrEventSigned | null> {
    const isExtension = CredentialManager.isExtensionMode();
    
    if (!isExtension && !CredentialManager.getPrivateKey()) {
      console.error('Private key not found');
      return null;
    }

    const event: NostrEvent = {
      kind: EVENT_KINDS.SET_METADATA,
      content: JSON.stringify(profile),
      tags: []
    };

    try {
      let signed: NostrEventSigned;

      if (isExtension) {
        signed = await this.signEventWithExtension(event);
      } else {
        const privkey = CredentialManager.getPrivateKey();
        if (!privkey) throw new Error('Private key not found');
        signed = NostrCrypto.signEvent(event, privkey);
      }

      if (!signed) throw new Error('Failed to sign event');

      const relayPool = getRelayPool();
      const results = await relayPool.publishEvent(signed);
      if (!Array.from(results.values()).some(Boolean)) {
        throw new Error('No relay accepted the profile');
      }
      return signed;
    } catch (error) {
      console.error('Failed to publish profile:', error);
      return null;
    }
  }

  /**
   * Fetch user profile from relays
   */
  static async fetchUserProfile(pubkey: string): Promise<UserProfile | null> {
    const filters: NostrFilter[] = [
      {
        kinds: [EVENT_KINDS.SET_METADATA],
        authors: [pubkey],
        limit: 10
      }
    ];

    try {
      const relayPool = getRelayPool();
      const events = await relayPool.fetchEvents(filters);

      if (events.length === 0) {
        return null;
      }

      const profile = this.mergeMetadataEvents(pubkey, events);
      EventCache.addProfile(profile);
      return profile;
    } catch (error) {
      console.error('Failed to fetch profile:', error);
      return null;
    }
  }

  /**
   * Merge metadata events oldest-first so newer values win, but fields
   * present only in older events (e.g. a bio a buggy client dropped)
   * are still shown
   */
  private static mergeMetadataEvents(pubkey: string, events: NostrEventSigned[]): UserProfile {
    const sorted = [...events].sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
    const merged: Record<string, unknown> = {};

    for (const event of sorted) {
      try {
        const data = JSON.parse(event.content) as Record<string, unknown>;
        for (const [key, value] of Object.entries(data)) {
          if (value !== '' && value !== null && value !== undefined) {
            merged[key] = value;
          }
        }
      } catch {
        // Skip events with malformed content
      }
    }

    return { ...merged, pubkey } as UserProfile;
  }

  /**
   * Fetch profiles for many authors in one relay query (instead of one
   * query per card) and cache them
   */
  static async fetchProfiles(pubkeys: string[]): Promise<Map<string, UserProfile>> {
    const unique = Array.from(new Set(pubkeys));
    const missing = unique.filter(pk => !EventCache.getProfile(pk));

    if (missing.length > 0) {
      try {
        const relayPool = getRelayPool();
        const events = await relayPool.fetchEvents([
          {
            kinds: [EVENT_KINDS.SET_METADATA],
            authors: missing
          }
        ]);

        const byAuthor = new Map<string, NostrEventSigned[]>();
        for (const event of events) {
          const list = byAuthor.get(event.pubkey);
          if (list) {
            list.push(event);
          } else {
            byAuthor.set(event.pubkey, [event]);
          }
        }

        for (const [pk, authorEvents] of byAuthor) {
          EventCache.addProfile(this.mergeMetadataEvents(pk, authorEvents));
        }
      } catch (error) {
        console.error('Failed to batch fetch profiles:', error);
      }
    }

    const result = new Map<string, UserProfile>();
    for (const pk of unique) {
      const profile = EventCache.getProfile(pk);
      if (profile) result.set(pk, profile);
    }
    return result;
  }

  /**
   * Fetch followed accounts from current user's contacts (kind 3)
   */
  static async fetchFollowedAccounts(): Promise<string[]> {
    const pubkey = CredentialManager.getPublicKey();
    if (!pubkey) {
      console.error('Public key not found');
      return [];
    }

    const filters: NostrFilter[] = [
      {
        kinds: [EVENT_KINDS.CONTACTS],
        authors: [pubkey],
        limit: 1
      }
    ];

    try {
      const relayPool = getRelayPool();
      const events = await relayPool.fetchEvents(filters);
      
      if (events.length === 0) {
        // No contacts event, return empty list
        return [];
      }

      const latestEvent = events.reduce((latest, current) => 
        (current.created_at || 0) > (latest.created_at || 0) ? current : latest
      );

      // Extract pubkeys from tags (kind 3 has 'p' tags for each followed pubkey)
      const followedPubkeys = latestEvent.tags
        .filter(tag => tag[0] === 'p')
        .map(tag => tag[1])
        .filter((pubkey): pubkey is string => typeof pubkey === 'string' && pubkey.length > 0);

      return followedPubkeys;
    } catch (error) {
      console.error('Failed to fetch followed accounts:', error);
      return [];
    }
  }

  /**
   * Fetch home feed from followed accounts
   */
  static async fetchFollowedFeed(limit: number = 100): Promise<NostrEventSigned[]> {
    const followedAccounts = await this.fetchFollowedAccounts();
    
    if (followedAccounts.length === 0) {
      // If no followed accounts, return empty feed with a message
      console.log('No followed accounts found');
      return [];
    }

    return this.fetchHomeFeed(followedAccounts, limit);
  }

  /**
   * Drop events with timestamps in the future (spam / clock skew) — they
   * pin themselves to the top of feeds and break since-based polling
   */
  private static dropFutureEvents(events: NostrEventSigned[]): NostrEventSigned[] {
    const maxTimestamp = Math.floor(Date.now() / 1000) + 300; // 5 min skew tolerance
    return events.filter(e => (e.created_at || 0) <= maxTimestamp);
  }

  /**
   * Fetch user's notes
   */
  static async fetchUserNotes(
    pubkey: string,
    limit: number = 100
  ): Promise<NostrEventSigned[]> {
    const filters: NostrFilter[] = [
      {
        kinds: [EVENT_KINDS.TEXT_NOTE],
        authors: [pubkey],
        limit
      }
    ];

    try {
      const relayPool = getRelayPool();
      const events = this.dropFutureEvents(await relayPool.fetchEvents(filters));
      return events.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    } catch (error) {
      console.error('Failed to fetch user notes:', error);
      return [];
    }
  }

  /**
   * Fetch home feed
   */
  static async fetchHomeFeed(
    authors: string[],
    limit: number = 100,
    since?: number
  ): Promise<NostrEventSigned[]> {
    const filters: NostrFilter[] = [
      {
        kinds: [EVENT_KINDS.TEXT_NOTE],
        authors,
        limit,
        ...(since !== undefined ? { since } : {})
      }
    ];

    try {
      const relayPool = getRelayPool();
      const events = this.dropFutureEvents(await relayPool.fetchEvents(filters));
      return events.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    } catch (error) {
      console.error('Failed to fetch feed:', error);
      return [];
    }
  }

  /**
   * Fetch global feed
   */
  static async fetchGlobalFeed(limit: number = 100, since?: number): Promise<NostrEventSigned[]> {
    const filters: NostrFilter[] = [
      {
        kinds: [EVENT_KINDS.TEXT_NOTE],
        limit,
        ...(since !== undefined ? { since } : {})
      }
    ];

    try {
      const relayPool = getRelayPool();
      const events = this.dropFutureEvents(await relayPool.fetchEvents(filters));
      return events.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    } catch (error) {
      console.error('Failed to fetch global feed:', error);
      return [];
    }
  }

  /**
   * Fetch events by hashtag
   */
  static async fetchEventsByTag(
    tag: string,
    limit: number = 100
  ): Promise<NostrEventSigned[]> {
    const filters: NostrFilter[] = [
      {
        kinds: [EVENT_KINDS.TEXT_NOTE],
        '#t': [tag.toLowerCase()],
        limit
      }
    ];

    try {
      const relayPool = getRelayPool();
      const events = await relayPool.fetchEvents(filters);
      return events.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    } catch (error) {
      console.error('Failed to fetch events by tag:', error);
      return [];
    }
  }

  /**
   * Fetch replies to an event
   */
  static async fetchReplies(eventId: string, limit: number = 50): Promise<NostrEventSigned[]> {
    const filters: NostrFilter[] = [
      {
        kinds: [EVENT_KINDS.TEXT_NOTE],
        '#e': [eventId],
        limit
      }
    ];

    try {
      const relayPool = getRelayPool();
      const events = await relayPool.fetchEvents(filters);
      return events.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    } catch (error) {
      console.error('Failed to fetch replies:', error);
      return [];
    }
  }

  /**
   * Sign event using extension or private key
   */
  private static async signEventWithExtension(event: NostrEvent): Promise<NostrEventSigned> {
    // NIP-07: the template must contain ONLY created_at/kind/tags/content —
    // strict extensions reject templates with extra fields like pubkey
    const eventTemplate = {
      kind: event.kind,
      created_at: Math.floor(Date.now() / 1000),
      tags: event.tags || [],
      content: event.content
    };

    const signed = await ExtensionManager.signEvent(eventTemplate);
    if (!signed || !(signed as any).id || !(signed as any).sig) {
      throw new Error(
        'Extension did not sign the event — check the extension popup and its site permissions'
      );
    }
    return signed as NostrEventSigned;
  }

  /**
   * Add reaction to an event
   */
  static async addReaction(
    eventId: string,
    emoji: string = '+',
    authorPubkey?: string
  ): Promise<NostrEventSigned | null> {
    const isExtension = CredentialManager.isExtensionMode();

    if (!isExtension && !CredentialManager.getPrivateKey()) {
      console.error('Private key not found');
      return null;
    }

    try {
      // Caller usually already has the author's pubkey on the event —
      // only query the relays for it as a fallback
      const author = authorPubkey || await this.getEventAuthor(eventId);
      if (!author) throw new Error('Could not find event author');

      const event: NostrEvent = {
        kind: EVENT_KINDS.REACTION,
        content: emoji,
        tags: [['e', eventId], ['p', author]]
      };

      let signed: NostrEventSigned;

      if (isExtension) {
        signed = await this.signEventWithExtension(event);
      } else {
        const privkey = CredentialManager.getPrivateKey();
        if (!privkey) throw new Error('Private key not found');
        signed = NostrCrypto.signEvent(event, privkey);
      }

      if (!signed) throw new Error('Failed to sign event');

      const relayPool = getRelayPool();
      const results = await relayPool.publishEvent(signed);
      if (!Array.from(results.values()).some(Boolean)) {
        throw new Error('No relay accepted the reaction');
      }
      return signed;
    } catch (error) {
      console.error('Failed to add reaction:', error);
      return null;
    }
  }

  /**
   * Repost an event (NIP-18, kind 6)
   */
  static async repostEvent(original: NostrEventSigned): Promise<NostrEventSigned | null> {
    const isExtension = CredentialManager.isExtensionMode();

    if (!isExtension && !CredentialManager.getPrivateKey()) {
      console.error('Private key not found');
      return null;
    }

    try {
      const event: NostrEvent = {
        kind: EVENT_KINDS.REPOST,
        content: JSON.stringify(original),
        tags: [['e', original.id], ['p', original.pubkey]]
      };

      let signed: NostrEventSigned;

      if (isExtension) {
        signed = await this.signEventWithExtension(event);
      } else {
        const privkey = CredentialManager.getPrivateKey();
        if (!privkey) throw new Error('Private key not found');
        signed = NostrCrypto.signEvent(event, privkey);
      }

      if (!signed) throw new Error('Failed to sign event');

      const relayPool = getRelayPool();
      const results = await relayPool.publishEvent(signed);
      if (!Array.from(results.values()).some(Boolean)) {
        throw new Error('No relay accepted the repost');
      }
      return signed;
    } catch (error) {
      console.error('Failed to repost:', error);
      return null;
    }
  }

  /**
   * Extract the amount in sats from a zap receipt (kind 9735)
   */
  private static parseZapAmountSats(zapReceipt: NostrEventSigned): number {
    // Primary source: the bolt11 invoice amount (lnbc<amount><multiplier>1...)
    const bolt11 = zapReceipt.tags.find(t => t[0] === 'bolt11')?.[1];
    if (bolt11) {
      const match = /^ln(?:bc|tbs|tb|bcrt)?(\d+)([munp]?)1/i.exec(bolt11);
      if (match) {
        const digits = parseInt(match[1], 10);
        const multipliers: Record<string, number> = { '': 1, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12 };
        const btc = digits * (multipliers[match[2].toLowerCase()] ?? 1);
        return Math.floor(btc * 1e8);
      }
    }

    // Fallback: the embedded zap request's amount tag (millisats)
    try {
      const description = zapReceipt.tags.find(t => t[0] === 'description')?.[1];
      if (description) {
        const zapRequest = JSON.parse(description);
        const amountTag = (zapRequest.tags as string[][] | undefined)?.find(t => t[0] === 'amount')?.[1];
        if (amountTag) return Math.floor(parseInt(amountTag, 10) / 1000);
      }
    } catch {
      // Malformed description — no amount available
    }

    return 0;
  }

  /**
   * Fetch engagement (replies, reposts, likes, zap total) for an event
   * in one query. zapSats is the summed amount in sats, not a count.
   */
  static async fetchEngagement(eventId: string): Promise<{
    replies: number;
    reposts: number;
    likes: number;
    zapSats: number;
    myReaction: string | null;
    myRepost: boolean;
  }> {
    const result = {
      replies: 0,
      reposts: 0,
      likes: 0,
      zapSats: 0,
      myReaction: null as string | null,
      myRepost: false
    };

    try {
      const relayPool = getRelayPool();
      const events = await relayPool.fetchEvents([
        {
          kinds: [EVENT_KINDS.TEXT_NOTE, EVENT_KINDS.REPOST, EVENT_KINDS.REACTION, EVENT_KINDS.ZAP_RECEIPT],
          '#e': [eventId],
          limit: 500
        }
      ]);

      const ownPubkey = CredentialManager.getPublicKey();

      for (const ev of events) {
        if (ev.kind === EVENT_KINDS.TEXT_NOTE) {
          result.replies++;
        } else if (ev.kind === EVENT_KINDS.REPOST) {
          result.reposts++;
          if (ownPubkey && ev.pubkey === ownPubkey) {
            result.myRepost = true;
          }
        } else if (ev.kind === EVENT_KINDS.REACTION) {
          result.likes++;
          if (ownPubkey && ev.pubkey === ownPubkey) {
            result.myReaction = ev.content || '❤️';
          }
        } else if (ev.kind === EVENT_KINDS.ZAP_RECEIPT) {
          result.zapSats += this.parseZapAmountSats(ev);
        }
      }
    } catch (error) {
      console.error('Failed to fetch engagement:', error);
    }

    return result;
  }

  /**
   * Delete an event (kind 5)
   */
  static async deleteEvent(eventId: string): Promise<NostrEventSigned | null> {
    const isExtension = CredentialManager.isExtensionMode();
    
    if (!isExtension && !CredentialManager.getPrivateKey()) {
      console.error('Private key not found');
      return null;
    }

    const event: NostrEvent = {
      kind: EVENT_KINDS.DELETION,
      content: '',
      tags: [['e', eventId]]
    };

    try {
      let signed: NostrEventSigned;

      if (isExtension) {
        signed = await this.signEventWithExtension(event);
      } else {
        const privkey = CredentialManager.getPrivateKey();
        if (!privkey) throw new Error('Private key not found');
        signed = NostrCrypto.signEvent(event, privkey);
      }

      if (!signed) throw new Error('Failed to sign event');

      const relayPool = getRelayPool();
      await relayPool.publishEvent(signed);
      return signed;
    } catch (error) {
      console.error('Failed to delete event:', error);
      return null;
    }
  }

  /**
   * Get event author's public key
   */
  static async getEventAuthor(eventId: string): Promise<string | null> {
    const filters: NostrFilter[] = [
      {
        ids: [eventId]
      }
    ];

    try {
      const relayPool = getRelayPool();
      const events = await relayPool.fetchEvents(filters);
      return events[0]?.pubkey || null;
    } catch (error) {
      console.error('Failed to get event author:', error);
      return null;
    }
  }

  /**
   * Fetch event by ID
   */
  static async fetchEventById(eventId: string): Promise<NostrEventSigned | null> {
    const filters: NostrFilter[] = [
      {
        ids: [eventId]
      }
    ];

    try {
      const relayPool = getRelayPool();
      const events = await relayPool.fetchEvents(filters);
      return events[0] || null;
    } catch (error) {
      console.error('Failed to fetch event:', error);
      return null;
    }
  }

  /**
   * Search events by content
   */
  static async searchEvents(query: string, limit: number = 50): Promise<NostrEventSigned[]> {
    // Note: Search is a complex feature and not all relays support it
    // This is a basic implementation that fetches global feed and filters locally
    const filters: NostrFilter[] = [
      {
        kinds: [EVENT_KINDS.TEXT_NOTE],
        limit: Math.min(limit * 2, 500)
      }
    ];

    try {
      const relayPool = getRelayPool();
      const events = await relayPool.fetchEvents(filters);
      
      const queryLower = query.toLowerCase();
      const filtered = events.filter(event => 
        event.content.toLowerCase().includes(queryLower)
      );
      
      return filtered.slice(0, limit).sort((a, b) =>
        (b.created_at || 0) - (a.created_at || 0)
      );
    } catch (error) {
      console.error('Failed to search events:', error);
      return [];
    }
  }

  /**
   * Search profiles by name, display name, NIP-05 or bio.
   * No relay-side full-text search for kind 0 is assumed — fetch a broad
   * batch of recent profiles and filter client-side.
   */
  static async searchProfiles(query: string, limit: number = 30): Promise<UserProfile[]> {
    const queryLower = query.toLowerCase();

    try {
      const relayPool = getRelayPool();
      const events = await relayPool.fetchEvents([
        { kinds: [EVENT_KINDS.SET_METADATA], limit: 500 }
      ]);

      const byAuthor = new Map<string, NostrEventSigned[]>();
      for (const event of events) {
        const list = byAuthor.get(event.pubkey);
        if (list) list.push(event);
        else byAuthor.set(event.pubkey, [event]);
      }

      const matches: UserProfile[] = [];
      for (const [pubkey, authorEvents] of byAuthor) {
        const profile = this.mergeMetadataEvents(pubkey, authorEvents);
        const haystack = [profile.name, profile.display_name, profile.nip05, profile.about]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (haystack.includes(queryLower)) {
          EventCache.addProfile(profile);
          matches.push(profile);
        }
      }

      return matches.slice(0, limit);
    } catch (error) {
      console.error('Failed to search profiles:', error);
      return [];
    }
  }

  /**
   * Sum zap amounts (sats) per event id in one batched relay query,
   * instead of one fetchEngagement call per event
   */
  static async fetchZapTotals(eventIds: string[]): Promise<Map<string, number>> {
    const totals = new Map<string, number>();
    if (eventIds.length === 0) return totals;

    try {
      const relayPool = getRelayPool();
      const zapReceipts = await relayPool.fetchEvents([
        { kinds: [EVENT_KINDS.ZAP_RECEIPT], '#e': eventIds, limit: 1000 }
      ]);

      const idSet = new Set(eventIds);
      for (const receipt of zapReceipts) {
        const targetId = receipt.tags.find(t => t[0] === 'e' && idSet.has(t[1]))?.[1];
        if (!targetId) continue;
        const amount = this.parseZapAmountSats(receipt);
        totals.set(targetId, (totals.get(targetId) || 0) + amount);
      }
    } catch (error) {
      console.error('Failed to fetch zap totals:', error);
    }

    return totals;
  }
}

/**
 * Small localStorage-backed store for stale-while-revalidate rendering:
 * cached data is shown instantly while fresh data loads in the background
 */
export class PersistentCache {
  private static readonly PREFIX = 'nostr_cache_';

  static get<T>(key: string): T | null {
    try {
      const raw = localStorage.getItem(this.PREFIX + key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  static set(key: string, value: unknown): void {
    try {
      localStorage.setItem(this.PREFIX + key, JSON.stringify(value));
    } catch (error) {
      // Quota exceeded or serialization failure — cache is best-effort
      console.warn(`[Cache] Failed to persist ${key}:`, error);
    }
  }

  static remove(key: string): void {
    try {
      localStorage.removeItem(this.PREFIX + key);
    } catch {
      // ignore
    }
  }
}

/**
 * Event cache manager
 */
export class EventCache {
  private static cache: Map<string, EventWithMetadata> = new Map();
  private static profileCache: Map<string, UserProfile> | null = null;
  private static readonly PROFILES_KEY = 'profiles';
  private static readonly MAX_PERSISTED_PROFILES = 500;
  private static persistTimer: ReturnType<typeof setTimeout> | null = null;

  private static profiles(): Map<string, UserProfile> {
    if (!this.profileCache) {
      const stored = PersistentCache.get<UserProfile[]>(this.PROFILES_KEY);
      this.profileCache = new Map((stored || []).map(p => [p.pubkey, p]));
    }
    return this.profileCache;
  }

  // Debounced write-through so batch inserts don't hammer localStorage
  private static schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      const list = Array.from(this.profiles().values()).slice(-this.MAX_PERSISTED_PROFILES);
      PersistentCache.set(this.PROFILES_KEY, list);
    }, 500);
  }

  static addEvent(event: NostrEventSigned, relayUrl?: string): void {
    if (!this.cache.has(event.id)) {
      this.cache.set(event.id, { ...event, relayUrl });
    }
  }

  static getEvent(id: string): EventWithMetadata | null {
    return this.cache.get(id) || null;
  }

  static addProfile(profile: UserProfile): void {
    this.profiles().set(profile.pubkey, profile);
    this.schedulePersist();
  }

  static getProfile(pubkey: string): UserProfile | null {
    return this.profiles().get(pubkey) || null;
  }

  /** All locally known profiles — instant, no relay round trip */
  static getAllProfiles(): UserProfile[] {
    return Array.from(this.profiles().values());
  }

  static clear(): void {
    this.cache.clear();
    this.profiles().clear();
    PersistentCache.remove(this.PROFILES_KEY);
  }

  static getSize(): number {
    return this.cache.size;
  }
}
