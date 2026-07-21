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
import { isEffectivelyLive } from '../utils/liveStream';

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
    hashtags?: string[],
    mentionPubkeys?: string[]
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

    mentionPubkeys?.forEach(pubkey => {
      tags.push(['p', pubkey]);
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
      throw error;
    }
  }

  /**
   * Publish a poll (kind 1068, draft NIP-69). `pollType` "user" maps to the
   * standard singlechoice poll — one response per voter. "zap" isn't part
   * of the draft spec; it's tagged as its own polltype value and just
   * records intent for now (weighting votes by zap amount is a follow-up —
   * this only covers publishing the poll itself).
   */
  static async publishPoll(
    question: string,
    options: string[],
    pollType: 'user' | 'zap',
    endsAt?: number
  ): Promise<NostrEventSigned | null> {
    const isExtension = CredentialManager.isExtensionMode();

    if (!isExtension && !CredentialManager.getPrivateKey()) {
      console.error('Private key not found');
      return null;
    }

    const tags: string[][] = options.map((option, i) => ['option', String(i), option]);
    tags.push(['polltype', pollType === 'zap' ? 'zap' : 'singlechoice']);
    if (endsAt !== undefined) tags.push(['endsAt', String(endsAt)]);

    const relayPool = getRelayPool();
    relayPool.getRelays().slice(0, 3).forEach(url => tags.push(['relay', url]));

    const event: NostrEvent = {
      kind: EVENT_KINDS.POLL,
      content: question,
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

      const results = await relayPool.publishEvent(signed);
      if (!Array.from(results.values()).some(Boolean)) {
        throw new Error('No relay accepted the poll');
      }
      return signed;
    } catch (error) {
      console.error('Failed to publish poll:', error);
      throw error;
    }
  }

  /**
   * Vote on a poll (kind 1018) — publishing a new response for the same
   * poll supersedes the previous one, since tally reads only the latest
   * response per voter.
   */
  static async publishPollResponse(pollId: string, optionId: string): Promise<NostrEventSigned | null> {
    const isExtension = CredentialManager.isExtensionMode();

    if (!isExtension && !CredentialManager.getPrivateKey()) {
      console.error('Private key not found');
      return null;
    }

    const event: NostrEvent = {
      kind: EVENT_KINDS.POLL_RESPONSE,
      content: '',
      tags: [
        ['e', pollId],
        ['response', optionId]
      ]
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
        throw new Error('No relay accepted the vote');
      }
      return signed;
    } catch (error) {
      console.error('Failed to publish poll response:', error);
      throw error;
    }
  }

  /**
   * Fetch all responses (kind 1018) for a poll — tally by taking only the
   * latest response per voter (a later vote overrides an earlier one)
   */
  static async fetchPollResponses(pollId: string, limit: number = 500): Promise<NostrEventSigned[]> {
    const filters: NostrFilter[] = [
      { kinds: [EVENT_KINDS.POLL_RESPONSE], '#e': [pollId], limit }
    ];

    try {
      const relayPool = getRelayPool();
      return await relayPool.fetchEvents(filters);
    } catch (error) {
      console.error('Failed to fetch poll responses:', error);
      return [];
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
      // Update the cache immediately — otherwise anything reading
      // EventCache (e.g. the header avatar) doesn't see this until the
      // next relay fetch, even though we just published it ourselves
      EventCache.addProfile({ ...profile, pubkey: signed.pubkey } as UserProfile);
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
    return this.fetchFollowingList(pubkey);
  }

  /**
   * Fetch the pubkeys any given account follows (kind 3) — same as
   * fetchFollowedAccounts but for an arbitrary profile, not just yourself
   */
  static async fetchFollowingList(pubkey: string): Promise<string[]> {
    try {
      const existing = await this.fetchContactListEvent(pubkey);
      if (!existing) return [];
      return existing.tags
        .filter(tag => tag[0] === 'p')
        .map(tag => tag[1])
        .filter((pk): pk is string => typeof pk === 'string' && pk.length > 0);
    } catch (error) {
      console.error('Failed to fetch following list:', error);
      return [];
    }
  }

  /**
   * Count distinct accounts whose contact list includes this pubkey.
   * Approximate — bounded by `limit` and by what the connected relays
   * happen to have indexed, same tradeoff every Nostr client makes since
   * there's no authoritative global follower count.
   */
  static async fetchFollowersCount(pubkey: string, limit: number = 1000): Promise<{ count: number; capped: boolean }> {
    try {
      const relayPool = getRelayPool();
      const events = await relayPool.fetchEvents([
        { kinds: [EVENT_KINDS.CONTACTS], '#p': [pubkey], limit }
      ]);
      const authors = new Set(events.map(e => e.pubkey));
      return { count: authors.size, capped: events.length >= limit };
    } catch (error) {
      console.error('Failed to fetch followers count:', error);
      return { count: 0, capped: false };
    }
  }

  /**
   * Best-effort account creation date — the earliest profile (kind 0)
   * event we can find. Nostr has no real "join date"; like every client,
   * this is an approximation bounded by relay retention.
   */
  static async fetchAccountCreatedAt(pubkey: string): Promise<number | null> {
    try {
      const relayPool = getRelayPool();
      const events = await relayPool.fetchEvents([
        { kinds: [EVENT_KINDS.SET_METADATA], authors: [pubkey], limit: 50 }
      ]);
      if (events.length === 0) return null;
      return Math.min(...events.map(e => e.created_at || Infinity));
    } catch (error) {
      console.error('Failed to fetch account creation date:', error);
      return null;
    }
  }

  /**
   * Fetch the latest raw kind-3 contact list event (not just the pubkeys)
   * so follow/unfollow can preserve existing tags and content instead of
   * wiping the list — kind 3 is a replaceable event, relays only keep
   * whatever we last published.
   */
  private static async fetchContactListEvent(pubkey: string): Promise<NostrEventSigned | null> {
    try {
      const relayPool = getRelayPool();
      const events = await relayPool.fetchEvents([
        { kinds: [EVENT_KINDS.CONTACTS], authors: [pubkey], limit: 5 }
      ]);
      if (events.length === 0) return null;
      return events.reduce((latest, current) =>
        (current.created_at || 0) > (latest.created_at || 0) ? current : latest
      );
    } catch (error) {
      console.error('Failed to fetch contact list event:', error);
      return null;
    }
  }

  private static async publishContactList(tags: string[][], content: string): Promise<boolean> {
    const isExtension = CredentialManager.isExtensionMode();
    if (!isExtension && !CredentialManager.getPrivateKey()) {
      throw new Error('Private key not found');
    }

    const event: NostrEvent = { kind: EVENT_KINDS.CONTACTS, content, tags };

    let signed: NostrEventSigned;
    if (isExtension) {
      signed = await this.signEventWithExtension(event);
    } else {
      const privkey = CredentialManager.getPrivateKey();
      if (!privkey) throw new Error('Private key not found');
      signed = NostrCrypto.signEvent(event, privkey);
    }

    const relayPool = getRelayPool();
    const results = await relayPool.publishEvent(signed);
    if (!Array.from(results.values()).some(Boolean)) {
      throw new Error('No relay accepted the updated contact list');
    }
    return true;
  }

  /**
   * Whether the logged-in user already follows this pubkey
   */
  static async isFollowing(targetPubkey: string): Promise<boolean> {
    const ownPubkey = CredentialManager.getPublicKey();
    if (!ownPubkey) return false;
    const existing = await this.fetchContactListEvent(ownPubkey);
    return !!existing?.tags.some(t => t[0] === 'p' && t[1] === targetPubkey);
  }

  /**
   * Follow a pubkey — adds a `p` tag to the existing contact list (kind 3)
   */
  static async followUser(targetPubkey: string): Promise<boolean> {
    const ownPubkey = CredentialManager.getPublicKey();
    if (!ownPubkey) throw new Error('Public key not found');

    const existing = await this.fetchContactListEvent(ownPubkey);
    const tags = existing ? [...existing.tags] : [];
    if (tags.some(t => t[0] === 'p' && t[1] === targetPubkey)) {
      return true; // already following
    }
    tags.push(['p', targetPubkey]);

    return this.publishContactList(tags, existing?.content || '');
  }

  /**
   * Unfollow a pubkey — removes its `p` tag from the contact list (kind 3)
   */
  static async unfollowUser(targetPubkey: string): Promise<boolean> {
    const ownPubkey = CredentialManager.getPublicKey();
    if (!ownPubkey) throw new Error('Public key not found');

    const existing = await this.fetchContactListEvent(ownPubkey);
    if (!existing) return true; // nothing to unfollow

    const tags = existing.tags.filter(t => !(t[0] === 'p' && t[1] === targetPubkey));
    return this.publishContactList(tags, existing.content || '');
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
        kinds: [EVENT_KINDS.TEXT_NOTE, EVENT_KINDS.POLL],
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
   * Fetch reposts (kind 6) by one or more authors, paired with the original
   * note. NIP-18 embeds the original event as JSON in the repost's content —
   * used when present; falls back to fetching by the repost's `e` tag
   * for reposts that only include the tag (some clients omit content).
   */
  static async fetchReposts(authors: string[], limit: number = 50): Promise<{ repost: NostrEventSigned; original: NostrEventSigned }[]> {
    if (authors.length === 0) return [];

    const filters: NostrFilter[] = [
      {
        kinds: [EVENT_KINDS.REPOST],
        authors,
        limit
      }
    ];

    try {
      const relayPool = getRelayPool();
      const repostEvents = this.dropFutureEvents(await relayPool.fetchEvents(filters));

      const embedded = new Map<string, NostrEventSigned>();
      const missingIds: string[] = [];

      for (const repost of repostEvents) {
        try {
          const parsed = JSON.parse(repost.content) as NostrEventSigned;
          if (parsed?.id && parsed?.pubkey && parsed?.content !== undefined) {
            embedded.set(repost.id, parsed);
            EventCache.addEvent(parsed);
            continue;
          }
        } catch {
          // Not embedded JSON — fetch it by id below
        }
        const targetId = repost.tags.find(t => t[0] === 'e')?.[1];
        if (targetId) missingIds.push(targetId);
      }

      const fetchedMissing = missingIds.length > 0 ? await this.fetchEventsByIds(missingIds) : new Map<string, NostrEventSigned>();

      const results: { repost: NostrEventSigned; original: NostrEventSigned }[] = [];
      for (const repost of repostEvents) {
        const original = embedded.get(repost.id)
          ?? fetchedMissing.get(repost.tags.find(t => t[0] === 'e')?.[1] || '');
        if (original) results.push({ repost, original });
      }

      return results.sort((a, b) => (b.repost.created_at || 0) - (a.repost.created_at || 0));
    } catch (error) {
      console.error('Failed to fetch reposts:', error);
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
        kinds: [EVENT_KINDS.TEXT_NOTE, EVENT_KINDS.POLL],
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
        kinds: [EVENT_KINDS.TEXT_NOTE, EVENT_KINDS.POLL],
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
    limit: number = 100,
    since?: number
  ): Promise<NostrEventSigned[]> {
    const filters: NostrFilter[] = [
      {
        kinds: [EVENT_KINDS.TEXT_NOTE, EVENT_KINDS.POLL],
        '#t': [tag.toLowerCase()],
        limit,
        ...(since !== undefined ? { since } : {})
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
   * Open a live REQ subscription — relays reply with any stored events
   * matching `filters` first, then keep streaming new ones as they're
   * published. Unlike the `fetch*Feed` methods (one-shot query, meant to
   * be re-run on a timer), this rides the open WebSocket connection, so
   * new posts arrive immediately even while the tab is in the background
   * — background tabs throttle JS timers, not already-open socket traffic.
   */
  static subscribeLive(filters: NostrFilter[], onEvent: (event: NostrEventSigned) => void): string {
    const relayPool = getRelayPool();
    return relayPool.subscribe(filters, onEvent);
  }

  static unsubscribeLive(subscriptionId: string): void {
    getRelayPool().unsubscribe(subscriptionId);
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
   * Fetch an addressable event (NIP-19 naddr) by its (kind, author, d-tag)
   * coordinate rather than by id — these events are replaceable, so when
   * several match, the most recent one is the current version.
   */
  static async fetchEventByAddress(
    kind: number,
    pubkey: string,
    identifier: string
  ): Promise<NostrEventSigned | null> {
    // Filter by author/`d` tag client-side rather than via relay-side
    // filters — not every relay indexes arbitrary tags (or combines them
    // with an authors filter) reliably, and silently returns nothing
    // instead of erroring (same issue fetchLiveEvents had with '#status').
    const matchesAddress = (e: NostrEventSigned) =>
      e.pubkey === pubkey && (e.tags.find(t => t[0] === 'd')?.[1] || '') === identifier;

    try {
      const relayPool = getRelayPool();

      // waitForAll: true — a single specific event must not be lost just
      // because some other, faster relay answered first with unrelated
      // matches of the same kind (the default early-exit optimization is
      // tuned for feed loads, not a single-item lookup like this one)
      let events = await relayPool.fetchEvents([{ kinds: [kind], authors: [pubkey], limit: 50 }], true);
      let matches = events.filter(matchesAddress);

      // Narrow query came up empty — some relays don't reliably answer a
      // combined kind+authors filter. Fall back to a kind-only query and
      // filter client-side instead.
      if (matches.length === 0) {
        events = await relayPool.fetchEvents([{ kinds: [kind], limit: 200 }], true);
        matches = events.filter(matchesAddress);
      }

      if (matches.length === 0) return null;
      return matches.reduce((latest, current) =>
        (current.created_at || 0) > (latest.created_at || 0) ? current : latest
      );
    } catch (error) {
      console.error('Failed to fetch event by address:', error);
      return null;
    }
  }

  /**
   * Fetch live events (NIP-53, kind 30311), optionally by status and/or
   * authors. Addressable events can arrive from multiple relays at
   * different revisions — dedupe by (pubkey, d-tag), keeping the newest.
   */
  static async fetchLiveEvents(
    status?: 'planned' | 'live' | 'ended',
    authors?: string[],
    limit: number = 100
  ): Promise<NostrEventSigned[]> {
    // Filter status client-side rather than via a relay-side '#status' tag
    // filter — plenty of relays don't reliably index arbitrary tags,
    // especially combined with an `authors` filter, and silently return
    // nothing instead of erroring. It also has to happen after the dedupe
    // below anyway: an older cached "live" revision must lose to a newer
    // "ended" one, not the other way around.
    const filters: NostrFilter[] = [
      {
        kinds: [EVENT_KINDS.LIVE_EVENT],
        limit,
        ...(authors ? { authors } : {})
      }
    ];

    try {
      const relayPool = getRelayPool();
      // waitForAll — live event volume is low, so it's worth the extra
      // latency to not have a slower relay's stream cut off by a faster
      // relay's unrelated results (see fetchEventByAddress above)
      const events = await relayPool.fetchEvents(filters, true);

      const latestByAddress = new Map<string, NostrEventSigned>();
      events.forEach(event => {
        const dTag = event.tags.find(t => t[0] === 'd')?.[1] || '';
        const address = `${event.pubkey}:${dTag}`;
        const existing = latestByAddress.get(address);
        if (!existing || (event.created_at || 0) > (existing.created_at || 0)) {
          latestByAddress.set(address, event);
        }
      });

      let results = Array.from(latestByAddress.values());
      if (status === 'live') {
        // A stale "live" tag (broadcaster never published "ended") doesn't
        // count as actually live — see isEffectivelyLive
        results = results.filter(isEffectivelyLive);
      } else if (status) {
        results = results.filter(e => (e.tags.find(t => t[0] === 'status')?.[1] || 'ended') === status);
      }

      return results.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    } catch (error) {
      console.error('Failed to fetch live events:', error);
      return [];
    }
  }

  /**
   * NIP-65: each author's own published relay list (kind 10002) — their
   * write relays are where they actually publish, which may not overlap
   * at all with our default relay set.
   */
  static async fetchRelayLists(authors: string[]): Promise<Map<string, string[]>> {
    if (authors.length === 0) return new Map();

    try {
      const relayPool = getRelayPool();
      const events = await relayPool.fetchEvents(
        [{ kinds: [10002], authors, limit: authors.length * 2 }],
        true
      );

      const latestByAuthor = new Map<string, NostrEventSigned>();
      events.forEach(event => {
        const existing = latestByAuthor.get(event.pubkey);
        if (!existing || (event.created_at || 0) > (existing.created_at || 0)) {
          latestByAuthor.set(event.pubkey, event);
        }
      });

      const result = new Map<string, string[]>();
      latestByAuthor.forEach((event, pubkey) => {
        const writeRelays = event.tags
          .filter(t => t[0] === 'r' && (t[2] === undefined || t[2] === 'write'))
          .map(t => t[1]);
        if (writeRelays.length > 0) result.set(pubkey, writeRelays);
      });
      return result;
    } catch (error) {
      console.error('Failed to fetch relay lists:', error);
      return new Map();
    }
  }

  /**
   * Like fetchLiveEvents, but also checks each author's own NIP-65 write
   * relays for any we're not already connected to — the "outbox model".
   * Without this, a broadcaster whose client publishes only to their own
   * relay (not our default set) would never show up as live here even
   * though they're publishing correctly.
   */
  static async fetchLiveEventsOutbox(authors: string[], limit: number = 100): Promise<NostrEventSigned[]> {
    const poolResults = await this.fetchLiveEvents('live', authors, limit);

    try {
      const relayPool = getRelayPool();
      const knownRelays = new Set(relayPool.getRelayConfigs().map(c => c.url));
      const relayLists = await this.fetchRelayLists(authors);

      const extraRelays = new Set<string>();
      relayLists.forEach(urls => urls.forEach(u => {
        if (!knownRelays.has(u)) extraRelays.add(u);
      }));

      if (extraRelays.size === 0) return poolResults;

      const extraEvents = await relayPool.fetchEventsFromExtraRelays(
        Array.from(extraRelays),
        [{ kinds: [EVENT_KINDS.LIVE_EVENT], authors, limit }]
      );

      const combined = new Map<string, NostrEventSigned>();
      [...poolResults, ...extraEvents].forEach(e => combined.set(e.id, e));

      const latestByAddress = new Map<string, NostrEventSigned>();
      combined.forEach(event => {
        const dTag = event.tags.find(t => t[0] === 'd')?.[1] || '';
        const address = `${event.pubkey}:${dTag}`;
        const existing = latestByAddress.get(address);
        if (!existing || (event.created_at || 0) > (existing.created_at || 0)) {
          latestByAddress.set(address, event);
        }
      });

      return Array.from(latestByAddress.values())
        .filter(isEffectivelyLive)
        .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    } catch (error) {
      console.error('Outbox live event lookup failed:', error);
      return poolResults;
    }
  }

  /**
   * Live streams relevant to a set of followed accounts — either they
   * authored the stream themselves (fetchLiveEventsOutbox), or NIP-53
   * tagged them as a participant (host/speaker/guest) on someone else's
   * stream via a 'p' tag. Returns each match paired with which followed
   * pubkey it's relevant through, since that's not always the event author.
   */
  static async fetchLiveEventsForFollows(
    authors: string[],
    limit: number = 100
  ): Promise<{ event: NostrEventSigned; matchedPubkey: string }[]> {
    if (authors.length === 0) return [];

    const authored = await this.fetchLiveEventsOutbox(authors, limit);

    let participantEvents: NostrEventSigned[] = [];
    try {
      const relayPool = getRelayPool();
      const raw = await relayPool.fetchEvents(
        [{ kinds: [EVENT_KINDS.LIVE_EVENT], '#p': authors, limit }],
        true
      );

      const latestByAddress = new Map<string, NostrEventSigned>();
      raw.forEach(event => {
        const dTag = event.tags.find(t => t[0] === 'd')?.[1] || '';
        const address = `${event.pubkey}:${dTag}`;
        const existing = latestByAddress.get(address);
        if (!existing || (event.created_at || 0) > (existing.created_at || 0)) {
          latestByAddress.set(address, event);
        }
      });

      participantEvents = Array.from(latestByAddress.values()).filter(isEffectivelyLive);
    } catch (error) {
      console.error('Failed to fetch participant live events:', error);
    }

    const followedSet = new Set(authors);
    const results = new Map<string, { event: NostrEventSigned; matchedPubkey: string }>();

    authored.forEach(event => {
      const address = `${event.pubkey}:${event.tags.find(t => t[0] === 'd')?.[1] || ''}`;
      results.set(address, { event, matchedPubkey: event.pubkey });
    });

    participantEvents.forEach(event => {
      const address = `${event.pubkey}:${event.tags.find(t => t[0] === 'd')?.[1] || ''}`;
      if (results.has(address)) return; // already counted via authorship
      const participantPubkey = event.tags.find(t => t[0] === 'p' && followedSet.has(t[1]))?.[1];
      if (participantPubkey) results.set(address, { event, matchedPubkey: participantPubkey });
    });

    return Array.from(results.values()).sort(
      (a, b) => (b.event.created_at || 0) - (a.event.created_at || 0)
    );
  }

  /**
   * Fetch multiple events by id in one relay query, reusing the cache for
   * ids already seen (e.g. from earlier feed loads) instead of refetching
   */
  static async fetchEventsByIds(eventIds: string[]): Promise<Map<string, NostrEventSigned>> {
    const unique = Array.from(new Set(eventIds));
    const result = new Map<string, NostrEventSigned>();
    const missing: string[] = [];

    for (const id of unique) {
      const cached = EventCache.getEvent(id);
      if (cached) {
        result.set(id, cached);
      } else {
        missing.push(id);
      }
    }

    if (missing.length > 0) {
      try {
        const relayPool = getRelayPool();
        const events = await relayPool.fetchEvents([{ ids: missing }]);
        for (const event of events) {
          EventCache.addEvent(event);
          result.set(event.id, event);
        }
      } catch (error) {
        console.error('Failed to batch fetch events by id:', error);
      }
    }

    return result;
  }

  /**
   * Public accessor for the zap amount parser — used when rendering zap
   * notifications outside fetchEngagement/fetchZapTotals
   */
  static getZapAmountSats(zapReceipt: NostrEventSigned): number {
    return this.parseZapAmountSats(zapReceipt);
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

  /**
   * Pull recipient/sender/note/amount out of a zap receipt. The sender is
   * only reliably known via the NIP-57 `P` (uppercase) tag; not every
   * receipt has one, so this falls back to the embedded zap request's own
   * `pubkey` (inside the `description` tag), which is always present and
   * signed by the real sender.
   */
  private static parseZapReceipt(receipt: NostrEventSigned): {
    recipientPubkey: string;
    senderPubkey: string | null;
    noteId?: string;
    sats: number;
    createdAt: number;
  } {
    const recipientPubkey = receipt.tags.find(t => t[0] === 'p')?.[1] || '';
    let senderPubkey = receipt.tags.find(t => t[0] === 'P')?.[1] || null;

    if (!senderPubkey) {
      try {
        const description = receipt.tags.find(t => t[0] === 'description')?.[1];
        const zapRequest = description ? JSON.parse(description) : null;
        if (zapRequest && typeof zapRequest.pubkey === 'string') {
          senderPubkey = zapRequest.pubkey;
        }
      } catch {
        // Malformed description — sender stays unknown
      }
    }

    return {
      recipientPubkey,
      senderPubkey,
      noteId: receipt.tags.find(t => t[0] === 'e')?.[1],
      sats: this.parseZapAmountSats(receipt),
      createdAt: receipt.created_at || 0
    };
  }

  /**
   * Fetch zaps this pubkey sent AND received, merged into one
   * chronological activity feed. Best-effort like all zap attribution —
   * bounded by `limit` per direction and by what receipts a relay has.
   */
  static async fetchZapActivity(pubkey: string, limit: number = 50): Promise<ZapActivity[]> {
    try {
      const relayPool = getRelayPool();
      const [sentReceipts, receivedReceipts] = await Promise.all([
        relayPool.fetchEvents([{ kinds: [EVENT_KINDS.ZAP_RECEIPT], '#P': [pubkey], limit }]),
        relayPool.fetchEvents([{ kinds: [EVENT_KINDS.ZAP_RECEIPT], '#p': [pubkey], limit }])
      ]);

      const seen = new Set<string>();
      const activity: ZapActivity[] = [];

      for (const receipt of sentReceipts) {
        if (seen.has(receipt.id)) continue;
        seen.add(receipt.id);
        const parsed = this.parseZapReceipt(receipt);
        if (!parsed.recipientPubkey) continue;
        activity.push({
          id: receipt.id,
          direction: 'sent',
          counterpartyPubkey: parsed.recipientPubkey,
          noteId: parsed.noteId,
          sats: parsed.sats,
          createdAt: parsed.createdAt
        });
      }

      for (const receipt of receivedReceipts) {
        if (seen.has(receipt.id)) continue; // e.g. a self-zap already counted above
        seen.add(receipt.id);
        const parsed = this.parseZapReceipt(receipt);
        if (!parsed.senderPubkey) continue; // can't attribute who sent it
        activity.push({
          id: receipt.id,
          direction: 'received',
          counterpartyPubkey: parsed.senderPubkey,
          noteId: parsed.noteId,
          sats: parsed.sats,
          createdAt: parsed.createdAt
        });
      }

      return activity.sort((a, b) => b.createdAt - a.createdAt);
    } catch (error) {
      console.error('Failed to fetch zap activity:', error);
      return [];
    }
  }
}

export interface ZapActivity {
  id: string;
  direction: 'sent' | 'received';
  /** Who the zap was sent to (direction='sent') or received from (direction='received') */
  counterpartyPubkey: string;
  noteId?: string;
  sats: number;
  createdAt: number;
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
