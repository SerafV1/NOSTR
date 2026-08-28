import { 
  NostrEventSigned, 
  NostrEvent, 
  UserProfile, 
  NostrFilter,
  EVENT_KINDS,
  EventWithMetadata
} from '../types';
import { nip19 } from 'nostr-tools';
import { NostrCrypto, CredentialManager, ExtensionManager } from './crypto';
import { getRelayPool } from './relay';
import { replyTags } from './replyTags';
import { bunkerSignEvent } from './bunker';
import { isEffectivelyLive } from '../utils/liveStream';
import { quoteRefRegex } from '../utils/media';
import { customEmojiMap } from '../utils/customEmoji';

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
    mentionPubkeys?: string[],
    /** Called as each relay answers, so the composer can show it happening */
    onRelayResult?: (url: string, accepted: boolean) => void
  ): Promise<NostrEventSigned | null> {
    if (!CredentialManager.canSign()) {
      console.error('No signing method available');
      return null;
    }

    const tags: string[][] = [];
    // Everyone this reply is addressed to, so a mention cannot repeat them
    const replyPeople = new Set<string>();

    // Answering a NIP-22 comment has to be a comment as well, or the reply
    // hangs outside the conversation for whoever wrote it: a client reading
    // that thread looks for comments, not for kind 1 notes carrying 'e'
    // tags. Replying to an ordinary note stays an ordinary note — that is
    // still what every client understands.
    const parent = replyTo ? await this.replyParent(replyTo) : null;
    const asComment = parent?.kind === EVENT_KINDS.COMMENT;

    if (parent) {
      const { tags: threadTags, people } = replyTags(parent, CredentialManager.getPublicKey());
      tags.push(...threadTags);
      people.forEach((pubkey: string) => replyPeople.add(pubkey));
    } else if (replyTo) {
      // The note answered could not be read, so there is nobody to name —
      // still better a reply the relays carry than no reply at all
      tags.push(['e', replyTo, '', 'reply']);
    }

    hashtags?.forEach(tag => {
      tags.push(['t', tag.toLowerCase()]);
    });

    mentionPubkeys?.forEach(pubkey => {
      // Whoever the reply already names is not named twice
      if (!replyPeople.has(pubkey)) tags.push(['p', pubkey]);
    });

    const event: NostrEvent = {
      kind: asComment ? EVENT_KINDS.COMMENT : EVENT_KINDS.TEXT_NOTE,
      content,
      tags
    };

    try {
      const signed = await this.signAnyMode(event);

      if (!signed) throw new Error('Failed to sign event');

      const relayPool = getRelayPool();
      const results = await relayPool.publishEvent(signed, onRelayResult);
      if (!Array.from(results.values()).some(Boolean)) {
        throw new Error('No relay accepted the note');
      }
      return signed;
    } catch (error) {
      console.error('Failed to publish note:', error);
      throw error;
    }
  }

  // ---------------------------------------------------------------------
  // Backing an account up, and putting it back
  //
  // Everything below is the account's own lists: who it follows, who it has
  // muted, what its profile says. All three are replaceable events, which
  // means restoring one is publishing over whatever the relays hold — so
  // restoring merges rather than replaces, and never builds from an empty
  // base it could not read.
  // ---------------------------------------------------------------------

  /** The follow list as it stands, or null when the relays would not say */
  static async readFollowList(): Promise<{ tags: string[][]; content: string } | null> {
    const ownPubkey = CredentialManager.getPublicKey();
    if (!ownPubkey) return null;
    const { event, safe } = await this.resolveListBase(EVENT_KINDS.CONTACTS, ownPubkey);
    if (!event && !safe) return null;
    return { tags: event?.tags || [], content: event?.content || '' };
  }

  /** The mute list as it stands, or null when the relays would not say */
  static async readMuteList(): Promise<{ tags: string[][]; content: string } | null> {
    const ownPubkey = CredentialManager.getPublicKey();
    if (!ownPubkey) return null;
    const { event, safe } = await this.resolveListBase(EVENT_KINDS.MUTE_LIST, ownPubkey);
    if (!event && !safe) return null;
    return { tags: event?.tags || [], content: event?.content || '' };
  }

  /**
   * Add these people to the follow list, keeping everyone already in it.
   * Returns how many were not there before.
   */
  static async restoreFollows(pubkeys: string[]): Promise<number> {
    const ownPubkey = CredentialManager.getPublicKey();
    if (!ownPubkey) throw new Error('Public key not found');

    const { event: existing, safe } = await this.resolveListBase(EVENT_KINDS.CONTACTS, ownPubkey);
    if (!existing && !safe) throw new Error(this.CONTACT_LIST_UNAVAILABLE);

    const tags = existing ? [...existing.tags] : [];
    const already = new Set(tags.filter(t => t[0] === 'p').map(t => t[1]));
    let added = 0;
    for (const pubkey of pubkeys) {
      if (!/^[0-9a-f]{64}$/i.test(pubkey) || already.has(pubkey)) continue;
      tags.push(['p', pubkey]);
      already.add(pubkey);
      added++;
    }

    if (added > 0) await this.publishContactList(tags, existing?.content || '');
    return added;
  }

  /** The same for the mute list */
  static async restoreMutes(pubkeys: string[]): Promise<number> {
    const ownPubkey = CredentialManager.getPublicKey();
    if (!ownPubkey) throw new Error('Public key not found');

    const { event: existing, safe } = await this.resolveListBase(EVENT_KINDS.MUTE_LIST, ownPubkey);
    if (!existing && !safe) throw new Error(this.LIST_UNAVAILABLE);

    const tags = existing ? [...existing.tags] : [];
    const already = new Set(tags.filter(t => t[0] === 'p').map(t => t[1]));
    let added = 0;
    for (const pubkey of pubkeys) {
      if (!/^[0-9a-f]{64}$/i.test(pubkey) || already.has(pubkey)) continue;
      tags.push(['p', pubkey]);
      already.add(pubkey);
      added++;
    }

    if (added > 0) {
      await this.publishReplaceableList(EVENT_KINDS.MUTE_LIST, tags, existing?.content || '');
      this.mutedCache = null;
    }
    return added;
  }

  /**
   * The event being replied to, so a reply can be written in the same form.
   * Whatever is on screen has just been rendered, so the cache almost always
   * answers; the relays are only asked when it does not.
   */
  private static async replyParent(eventId: string): Promise<NostrEventSigned | null> {
    const cached = EventCache.getEvent(eventId);
    if (cached) return cached;
    try {
      return await this.fetchEventById(eventId);
    } catch {
      // A reply is worth publishing even when its parent cannot be read;
      // it just goes out in the older form
      return null;
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
    if (!CredentialManager.canSign()) {
      console.error('No signing method available');
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
      const signed = await this.signAnyMode(event);

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
    if (!CredentialManager.canSign()) {
      console.error('No signing method available');
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
      const signed = await this.signAnyMode(event);

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
    
    if (!CredentialManager.canSign()) {
      console.error('No signing method available');
      return null;
    }

    const event: NostrEvent = {
      kind: EVENT_KINDS.SET_METADATA,
      content: JSON.stringify(profile),
      tags: []
    };

    try {
      const signed = await this.signAnyMode(event);

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
  // The same idea as the engagement batch below: every card asks for the
  // person who wrote it, and asking one at a time meant 1,102 queries to the
  // relays for a single screen of a feed — measured — which is what the posts
  // themselves were queuing behind.
  private static profileWaiting = new Map<string, ((profile: UserProfile | null) => void)[]>();
  private static profileTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly PROFILE_BATCH = 40;

  static async fetchUserProfile(pubkey: string): Promise<UserProfile | null> {
    return new Promise(resolve => {
      const waiting = this.profileWaiting.get(pubkey) || [];
      waiting.push(resolve);
      this.profileWaiting.set(pubkey, waiting);

      if (this.profileWaiting.size >= this.PROFILE_BATCH) {
        void this.askAboutWaitingPeople();
      } else if (!this.profileTimer) {
        this.profileTimer = setTimeout(() => { void this.askAboutWaitingPeople(); }, 200);
      }
    });
  }

  private static async askAboutWaitingPeople(): Promise<void> {
    if (this.profileTimer) {
      clearTimeout(this.profileTimer);
      this.profileTimer = null;
    }

    const asked = this.profileWaiting;
    this.profileWaiting = new Map();
    const pubkeys = Array.from(asked.keys());
    if (pubkeys.length === 0) return;

    const found = new Map<string, UserProfile>();
    try {
      const events = await getRelayPool().fetchEvents([
        {
          kinds: [EVENT_KINDS.SET_METADATA],
          authors: pubkeys,
          // Several relays may hold several copies each, and the newest of
          // them wins below
          limit: pubkeys.length * 10
        }
      ]);

      const byAuthor = new Map<string, NostrEventSigned[]>();
      for (const event of events) {
        const held = byAuthor.get(event.pubkey) || [];
        held.push(event);
        byAuthor.set(event.pubkey, held);
      }
      for (const [author, metadata] of byAuthor) {
        const profile = this.mergeMetadataEvents(author, metadata);
        EventCache.addProfile(profile);
        found.set(author, profile);
      }
    } catch (error) {
      console.error('Failed to fetch profile:', error);
    }

    for (const [pubkey, resolvers] of asked) {
      const profile = found.get(pubkey) || null;
      for (const resolve of resolvers) resolve(profile);
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
    // A name may be written as :shortcode:, with the picture named in the
    // metadata event's own tags (NIP-30)
    let emojis: Record<string, string> = {};

    for (const event of sorted) {
      emojis = { ...emojis, ...customEmojiMap(event.tags) };
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

    return { ...merged, pubkey, emojis } as UserProfile;
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

  private static followsCacheKey(pubkey: string): string {
    return `follows_${pubkey}`;
  }

  /**
   * Last known follow list, without hitting a relay. Callers that need to
   * decide *right now* whether an author belongs in the home feed (cache
   * rendering, before any fetch has resolved) use this.
   */
  static getCachedFollowedAccounts(): string[] {
    const pubkey = CredentialManager.getPublicKey();
    if (!pubkey) return [];
    return PersistentCache.get<string[]>(this.followsCacheKey(pubkey)) || [];
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

    const follows = await this.fetchFollowingList(pubkey);
    if (follows.length > 0) {
      PersistentCache.set(this.followsCacheKey(pubkey), follows);
      return follows;
    }

    // An empty result is ambiguous: a brand-new account that follows
    // nobody looks exactly like relays that failed to hand over an
    // existing contact list. Callers turn "follows nobody" into an
    // unfiltered global feed, so guessing wrong fills the home feed with
    // strangers — prefer the last list we actually saw.
    return this.getCachedFollowedAccounts();
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
  /**
   * How much this person has written, and how many people follow them — asked
   * of the relays as a count rather than gathered by fetching everything.
   * Null when no relay in the pool answers that question, which is when the
   * page falls back to saying how much it has read itself.
   */
  static async countUserNotes(
    pubkey: string,
    onAnswer?: (count: number) => void
  ): Promise<number | null> {
    return getRelayPool().countEvents(
      [{ kinds: [EVENT_KINDS.TEXT_NOTE, EVENT_KINDS.COMMENT], authors: [pubkey] }],
      onAnswer
    );
  }

  static async countFollowers(
    pubkey: string,
    onAnswer?: (count: number) => void
  ): Promise<number | null> {
    return getRelayPool().countEvents(
      [{ kinds: [EVENT_KINDS.CONTACTS], '#p': [pubkey] }],
      onAnswer
    );
  }

  static async fetchFollowersCount(pubkey: string, limit: number = 1000): Promise<{ count: number; capped: boolean }> {
    const { pubkeys, capped } = await this.fetchFollowers(pubkey, limit);
    return { count: pubkeys.length, capped };
  }

  /**
   * The accounts whose contact list includes this pubkey. Same approximation
   * as the count above — bounded by `limit` and by what the connected relays
   * have indexed — but returns who they are, for the profile's Followers tab.
   */
  static async fetchFollowers(pubkey: string, limit: number = 1000): Promise<{ pubkeys: string[]; capped: boolean }> {
    try {
      const relayPool = getRelayPool();
      const events = await relayPool.fetchEvents([
        { kinds: [EVENT_KINDS.CONTACTS], '#p': [pubkey], limit }
      ]);
      // One account can have several contact-list events across relays —
      // it's still one follower
      const authors = new Set(events.map(e => e.pubkey));
      return { pubkeys: Array.from(authors), capped: events.length >= limit };
    } catch (error) {
      console.error('Failed to fetch followers:', error);
      return { pubkeys: [], capped: false };
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
    return this.fetchReplaceableListEvent(EVENT_KINDS.CONTACTS, pubkey);
  }

  /**
   * Latest raw event for one of the user's replaceable lists (contacts,
   * mute list). Relays keep only the newest, so an edit has to start from
   * this event's tags rather than from scratch.
   */
  private static async fetchReplaceableListEvent(kind: number, pubkey: string): Promise<NostrEventSigned | null> {
    try {
      const relayPool = getRelayPool();
      // waitForAll — this drives whether the home feed is author-filtered
      // at all. A false "you follow no one" (because some other relay
      // answered empty before the one relay holding your real, possibly
      // large contact list got a chance to) silently turns the home feed
      // into the unfiltered global feed, which looks like random posts.
      const events = await relayPool.fetchEvents(
        [{ kinds: [kind], authors: [pubkey], limit: 5 }],
        true
      );
      if (events.length === 0) return null;
      const latest = events.reduce((newest, current) =>
        (current.created_at || 0) > (newest.created_at || 0) ? current : newest
      );
      // Remember it: the next edit needs a trustworthy base even if the
      // relays are unreachable at that moment
      PersistentCache.set(this.listCacheKey(kind, pubkey), latest);
      return latest;
    } catch (error) {
      console.error(`Failed to fetch kind ${kind} list event:`, error);
      return null;
    }
  }

  private static async publishContactList(tags: string[][], content: string): Promise<boolean> {
    return this.publishReplaceableList(EVENT_KINDS.CONTACTS, tags, content);
  }

  private static async publishReplaceableList(
    kind: number,
    tags: string[][],
    content: string
  ): Promise<boolean> {
    if (!CredentialManager.canSign()) {
      throw new Error('No signing method available — log in again');
    }

    const event: NostrEvent = { kind, content, tags };

    const signed = await this.signAnyMode(event);

    const relayPool = getRelayPool();
    const results = await relayPool.publishEvent(signed);
    if (!Array.from(results.values()).some(Boolean)) {
      throw new Error('No relay accepted the updated list');
    }
    // What we just published is now the authoritative list — remember it, so
    // the next edit builds on it even if no relay answers at that moment
    PersistentCache.set(this.listCacheKey(signed.kind, signed.pubkey), signed);
    return true;
  }

  /**
   * Whether the logged-in user already follows this pubkey
   */
  // ---------------------------------------------------------------------
  // Blocking (NIP-51 mute list, kind 10000)
  //
  // Public 'p' tags only. The spec also allows an encrypted `content`
  // payload for private mutes; a public list is what other clients read
  // back reliably, and a block that only this client honours is worse than
  // no block at all.
  // ---------------------------------------------------------------------

  private static mutedCache: Set<string> | null = null;

  /**
   * Blocked pubkeys, straight from local storage. Feed rendering needs the
   * answer synchronously on every event, so it can't await a relay.
   */
  static getBlockedPubkeys(): Set<string> {
    if (this.mutedCache) return this.mutedCache;
    const ownPubkey = CredentialManager.getPublicKey();
    if (!ownPubkey) return new Set();
    const stored = PersistentCache.get<NostrEventSigned>(
      this.listCacheKey(EVENT_KINDS.MUTE_LIST, ownPubkey)
    );
    this.mutedCache = new Set(
      (stored?.tags || []).filter(t => t[0] === 'p' && t[1]).map(t => t[1])
    );
    return this.mutedCache;
  }

  static isBlocked(pubkey: string): boolean {
    return this.getBlockedPubkeys().has(pubkey);
  }

  /** Drop anything authored by a blocked account. */
  static dropBlocked(events: NostrEventSigned[]): NostrEventSigned[] {
    const blocked = this.getBlockedPubkeys();
    if (blocked.size === 0) return events;
    return events.filter(e => !blocked.has(e.pubkey));
  }

  // ---------------------------------------------------------------------
  // Bookmarks (NIP-51, kind 10003)
  //
  // Public 'e' tags, for the same reason the mute list is public: a list
  // written where only this client can read it is one that disappears the
  // moment its owner opens another app.
  // ---------------------------------------------------------------------

  private static bookmarksCache: Set<string> | null = null;

  /**
   * Bookmarked note ids from local storage. The button on every card in a
   * feed needs the answer without waiting for a relay.
   */
  static getBookmarkedIds(): Set<string> {
    if (this.bookmarksCache) return this.bookmarksCache;
    const ownPubkey = CredentialManager.getPublicKey();
    if (!ownPubkey) return new Set();
    const stored = PersistentCache.get<NostrEventSigned>(
      this.listCacheKey(EVENT_KINDS.BOOKMARKS, ownPubkey)
    );
    this.bookmarksCache = new Set(
      (stored?.tags || []).filter(t => t[0] === 'e' && t[1]).map(t => t[1])
    );
    return this.bookmarksCache;
  }

  static isBookmarked(eventId: string): boolean {
    return this.getBookmarkedIds().has(eventId);
  }

  /** Read the list back from the relays, for another device's bookmarks */
  static async fetchBookmarkedIds(): Promise<Set<string>> {
    const ownPubkey = CredentialManager.getPublicKey();
    if (!ownPubkey) return new Set();
    await this.fetchReplaceableListEvent(EVENT_KINDS.BOOKMARKS, ownPubkey);
    this.bookmarksCache = null;
    return this.getBookmarkedIds();
  }

  static async addBookmark(eventId: string): Promise<boolean> {
    const ownPubkey = CredentialManager.getPublicKey();
    if (!ownPubkey) throw new Error('Public key not found');

    const { event: existing, safe } = await this.resolveListBase(EVENT_KINDS.BOOKMARKS, ownPubkey);
    // Publishing a fresh list over one the relays simply failed to hand back
    // would erase every bookmark already in it
    if (!existing && !safe) throw new Error(this.LIST_UNAVAILABLE);

    const tags = existing ? [...existing.tags] : [];
    if (tags.some(t => t[0] === 'e' && t[1] === eventId)) return true;
    tags.push(['e', eventId]);

    const published = await this.publishReplaceableList(EVENT_KINDS.BOOKMARKS, tags, existing?.content || '');
    this.bookmarksCache = null;
    return published;
  }

  static async removeBookmark(eventId: string): Promise<boolean> {
    const ownPubkey = CredentialManager.getPublicKey();
    if (!ownPubkey) throw new Error('Public key not found');

    const { event: existing, safe } = await this.resolveListBase(EVENT_KINDS.BOOKMARKS, ownPubkey);
    if (!existing) {
      if (!safe) throw new Error(this.LIST_UNAVAILABLE);
      return true; // nothing bookmarked
    }

    const tags = existing.tags.filter(t => !(t[0] === 'e' && t[1] === eventId));
    const published = await this.publishReplaceableList(EVENT_KINDS.BOOKMARKS, tags, existing.content || '');
    this.bookmarksCache = null;
    return published;
  }

  /**
   * The bookmarked notes themselves, newest first. Ids the relays no longer
   * hold are left out rather than drawn as gaps.
   */
  static async fetchBookmarkedNotes(): Promise<NostrEventSigned[]> {
    const ids = [...(await this.fetchBookmarkedIds())];
    if (ids.length === 0) return [];

    const relayPool = getRelayPool();
    const events = this.dropBlocked(await relayPool.fetchEvents([{ ids }], true));
    EventCache.addEvents(events);
    return events.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  }

  /**
   * Refresh the block list from relays. Called on feed load so a block made
   * in another client (or on another device) takes effect here too.
   */
  static async fetchBlockedPubkeys(): Promise<Set<string>> {
    const ownPubkey = CredentialManager.getPublicKey();
    if (!ownPubkey) return new Set();
    await this.fetchReplaceableListEvent(EVENT_KINDS.MUTE_LIST, ownPubkey);
    this.mutedCache = null; // re-read from what the fetch just persisted
    return this.getBlockedPubkeys();
  }

  static async blockUser(targetPubkey: string): Promise<boolean> {
    const ownPubkey = CredentialManager.getPublicKey();
    if (!ownPubkey) throw new Error('Public key not found');
    if (targetPubkey === ownPubkey) throw new Error('You cannot block yourself');

    const { event: existing, safe } = await this.resolveListBase(EVENT_KINDS.MUTE_LIST, ownPubkey);
    if (!existing && !safe) throw new Error(this.LIST_UNAVAILABLE);

    const tags = existing ? [...existing.tags] : [];
    if (tags.some(t => t[0] === 'p' && t[1] === targetPubkey)) return true; // already blocked
    tags.push(['p', targetPubkey]);

    const published = await this.publishReplaceableList(EVENT_KINDS.MUTE_LIST, tags, existing?.content || '');
    this.mutedCache = null;
    return published;
  }

  static async unblockUser(targetPubkey: string): Promise<boolean> {
    const ownPubkey = CredentialManager.getPublicKey();
    if (!ownPubkey) throw new Error('Public key not found');

    const { event: existing, safe } = await this.resolveListBase(EVENT_KINDS.MUTE_LIST, ownPubkey);
    if (!existing) {
      if (!safe) throw new Error(this.LIST_UNAVAILABLE);
      return true; // nothing blocked
    }

    const tags = existing.tags.filter(t => !(t[0] === 'p' && t[1] === targetPubkey));
    const published = await this.publishReplaceableList(EVENT_KINDS.MUTE_LIST, tags, existing.content || '');
    this.mutedCache = null;
    return published;
  }

  static async isFollowing(targetPubkey: string): Promise<boolean> {
    const ownPubkey = CredentialManager.getPublicKey();
    if (!ownPubkey) return false;
    const existing = await this.fetchContactListEvent(ownPubkey);
    return !!existing?.tags.some(t => t[0] === 'p' && t[1] === targetPubkey);
  }

  /**
   * Follow a pubkey — adds a `p` tag to the existing contact list (kind 3)
   */
  /**
   * The contact list to edit, or null if we can't establish one safely.
   *
   * Kind 3 is replaceable: publishing one built from the wrong base doesn't
   * merge, it *destroys* whatever the relays held. A follow click while
   * relays are timing out used to fall back to an empty base and wipe the
   * entire follow list globally, one click. So: take the newest of what the
   * relays just returned and what we last saw ourselves, and treat "nothing
   * anywhere" as a hard stop rather than as "you follow nobody".
   */
  private static async resolveContactListBase(
    pubkey: string
  ): Promise<{ event: NostrEventSigned | null; safe: boolean }> {
    return this.resolveListBase(EVENT_KINDS.CONTACTS, pubkey);
  }

  private static async resolveListBase(
    kind: number,
    pubkey: string
  ): Promise<{ event: NostrEventSigned | null; safe: boolean }> {
    const fetched = await this.fetchReplaceableListEvent(kind, pubkey);
    const remembered = PersistentCache.get<NostrEventSigned>(this.listCacheKey(kind, pubkey));

    const newest = [fetched, remembered]
      .filter((e): e is NostrEventSigned => !!e)
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0] || null;

    if (newest) return { event: newest, safe: true };

    // Nothing anywhere. For the contact list we have a second witness: the
    // follow list persisted separately. If that says this account follows
    // people, then a kind 3 exists somewhere and the relays simply failed
    // us — publishing now would replace it with whatever we build here.
    if (kind === EVENT_KINDS.CONTACTS && this.getCachedFollowedAccounts().length > 0) {
      return { event: null, safe: false };
    }

    // No list from anywhere. That's legitimate for a brand-new account, but
    // indistinguishable from every relay having failed us — so only trust it
    // when relays are actually reachable and simply had nothing to say.
    return { event: null, safe: getRelayPool().getConnectedRelayCount() > 0 };
  }

  /**
   * Kind 3 keeps its original key so the anti-wipe memory written by
   * earlier versions still counts; anything newer is keyed by kind.
   */
  private static listCacheKey(kind: number, pubkey: string): string {
    return kind === EVENT_KINDS.CONTACTS ? `contact_list_${pubkey}` : `list_${kind}_${pubkey}`;
  }

  private static readonly CONTACT_LIST_UNAVAILABLE =
    'Could not load your follow list from any relay. Not publishing, because that would erase the list you already have — check your relay connections and try again.';

  private static readonly LIST_UNAVAILABLE =
    'Could not load your list from any relay. Not publishing, because that would erase the list you already have — check your relay connections and try again.';

  /**
   * Thrown when no contact list could be found anywhere. Publishing one now
   * would create it — or silently replace a real list the relays failed to
   * hand over. Only the user can tell those apart, so callers catch this,
   * ask, and retry with createIfMissing.
   */
  static readonly NO_EXISTING_CONTACT_LIST = 'NO_EXISTING_CONTACT_LIST';

  static async followUser(
    targetPubkey: string,
    options: { createIfMissing?: boolean } = {}
  ): Promise<boolean> {
    const ownPubkey = CredentialManager.getPublicKey();
    if (!ownPubkey) throw new Error('Public key not found');

    const { event: existing, safe } = await this.resolveContactListBase(ownPubkey);
    if (!existing) {
      if (!safe) throw new Error(this.CONTACT_LIST_UNAVAILABLE);
      if (!options.createIfMissing) throw new Error(this.NO_EXISTING_CONTACT_LIST);
    }

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

    const { event: existing, safe } = await this.resolveContactListBase(ownPubkey);
    if (!existing) {
      if (!safe) throw new Error(this.CONTACT_LIST_UNAVAILABLE);
      return true; // genuinely nothing to unfollow
    }

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
    limit: number = 100,
    /** Only what they wrote before this, for reading further back */
    until?: number,
    /** Hear out every relay — reading back through a profile, the first
     *  answer must not decide that a person's history has run out */
    thorough: boolean = false
  ): Promise<NostrEventSigned[]> {
    const filters: NostrFilter[] = [
      {
        // Comments belong here too: a profile's Replies tab is built from
        // what this person wrote, and their replies are increasingly
        // written as comments rather than as notes
        kinds: [EVENT_KINDS.TEXT_NOTE, EVENT_KINDS.POLL, EVENT_KINDS.COMMENT],
        authors: [pubkey],
        limit,
        ...(until ? { until } : {})
      }
    ];

    try {
      const relayPool = getRelayPool();
      const events = this.dropFutureEvents(await relayPool.fetchEvents(filters, thorough));
      EventCache.addEvents(events);
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
      // `limit` is per-relay: the pool merges every relay's answer, so eight
      // relays return up to eight times what was asked for. Re-apply the cap
      // to the merged result — otherwise reposts flood the home feed and
      // drown out the posts from accounts you actually follow. Cutting here,
      // before resolving originals, also saves fetching the ones we'd drop.
      const repostEvents = this.dropBlocked(this.dropFutureEvents(await relayPool.fetchEvents(filters)))
        .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
        .slice(0, limit);

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
        // A repost has two authors, and blocking has to cover both — the
        // point of blocking someone is not seeing their posts, including
        // when somebody you do follow hands them to you
        if (original && !this.isBlocked(original.pubkey)) results.push({ repost, original });
      }

      return results.sort((a, b) => (b.repost.created_at || 0) - (a.repost.created_at || 0));
    } catch (error) {
      console.error('Failed to fetch reposts:', error);
      return [];
    }
  }

  /**
   * Resolve a repost (kind 6) down to the actual note it points to — NIP-18
   * says the repost's content MAY embed the original event as JSON, and
   * otherwise its 'e' tag has to be fetched. A repost can itself target
   * another repost (someone reposting a repost), so this unwraps
   * recursively until it lands on something that isn't a repost, capped
   * to guard against a pathological/malicious chain.
   */
  static async resolveRepostOriginal(repost: NostrEventSigned, depth: number = 0): Promise<NostrEventSigned | null> {
    if (depth > 5) return null;

    let original: NostrEventSigned | null = null;
    try {
      const parsed = JSON.parse(repost.content) as NostrEventSigned;
      if (parsed?.id && parsed?.pubkey && parsed?.content !== undefined) {
        EventCache.addEvent(parsed);
        original = parsed;
      }
    } catch {
      // Not embedded JSON — fall through to fetching it by id
    }

    if (!original) {
      const targetId = repost.tags.find(t => t[0] === 'e')?.[1];
      if (!targetId) return null;
      original = await this.fetchEventById(targetId);
    }

    if (original && original.kind === EVENT_KINDS.REPOST) {
      return this.resolveRepostOriginal(original, depth + 1);
    }
    return original;
  }

  /**
   * Find the first nostr:note1/nevent1/naddr1 reference in a note's
   * content and resolve it to the event it actually points to — unwrapped
   * through a repost if that's what the reference targets. Shared by the
   * top-level quote card and, recursively, by nested quote-of-a-quote
   * previews so both use the exact same resolution logic.
   */
  static async resolveQuoteReference(content: string): Promise<{ note: NostrEventSigned; repostedBy?: string } | null> {
    const matches = content.match(quoteRefRegex());
    if (!matches || matches.length === 0) return null;

    const link = matches[0];
    const linkLower = link.toLowerCase();
    const bech32 = link.replace(/^nostr:/i, '');

    try {
      let note: NostrEventSigned | null = null;

      if (linkLower.includes('naddr1')) {
        const decoded = nip19.decode(bech32);
        if (decoded.type !== 'naddr') return null;
        const { kind, pubkey, identifier } = decoded.data as { kind: number; pubkey: string; identifier: string };
        note = await this.fetchEventByAddress(kind, pubkey, identifier);
      } else if (linkLower.includes('nevent1')) {
        const decoded = nip19.decode(bech32);
        if (decoded.type !== 'nevent') return null;
        const { id, relays, author } = decoded.data as { id: string; relays?: string[]; author?: string };
        note = await this.fetchEventById(id, relays, author);
      } else {
        const decoded = nip19.decode(bech32);
        if (decoded.type !== 'note' || typeof decoded.data !== 'string') return null;
        note = await this.fetchEventById(decoded.data);
      }

      if (!note) return null;

      if (note.kind === EVENT_KINDS.REPOST) {
        const original = await this.resolveRepostOriginal(note);
        return original ? { note: original, repostedBy: note.pubkey } : null;
      }

      return { note };
    } catch (error) {
      console.error('Failed to resolve quote reference:', error);
      return null;
    }
  }

  /**
   * Fetch home feed
   */
  static async fetchHomeFeed(
    authors: string[],
    limit: number = 100,
    since?: number,
    /** Only what was published before this, for reading further back */
    until?: number,
    /**
     * Hear every relay out instead of answering as soon as one has spoken.
     * Worth the wait when reading further back: the fast answer decides
     * whether there is any history left, and a thin one ends the feed.
     */
    waitForAll?: boolean
  ): Promise<NostrEventSigned[]> {
    const filters: NostrFilter[] = [
      {
        kinds: [EVENT_KINDS.TEXT_NOTE, EVENT_KINDS.POLL],
        authors,
        limit,
        ...(since !== undefined ? { since } : {}),
        ...(until !== undefined ? { until } : {})
      }
    ];

    try {
      const relayPool = getRelayPool();
      const events = this.dropBlocked(this.dropFutureEvents(await relayPool.fetchEvents(filters, waitForAll)));
      EventCache.addEvents(events);
      return events.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    } catch (error) {
      console.error('Failed to fetch feed:', error);
      return [];
    }
  }

  /**
   * Fetch global feed
   */
  static async fetchGlobalFeed(
    limit: number = 100,
    since?: number,
    /** Only what was published before this, for reading further back */
    until?: number,
    /** See fetchHomeFeed: hear every relay out rather than the first */
    waitForAll?: boolean
  ): Promise<NostrEventSigned[]> {
    const filters: NostrFilter[] = [
      {
        kinds: [EVENT_KINDS.TEXT_NOTE, EVENT_KINDS.POLL],
        limit,
        ...(since !== undefined ? { since } : {}),
        ...(until !== undefined ? { until } : {})
      }
    ];

    try {
      const relayPool = getRelayPool();
      const events = this.dropBlocked(this.dropFutureEvents(await relayPool.fetchEvents(filters, waitForAll)));
      EventCache.addEvents(events);
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
    since?: number,
    /** Only what was published before this, for reading further back */
    until?: number,
    /** See fetchHomeFeed: hear every relay out rather than the first */
    waitForAll?: boolean
  ): Promise<NostrEventSigned[]> {
    const filters: NostrFilter[] = [
      {
        kinds: [EVENT_KINDS.TEXT_NOTE, EVENT_KINDS.POLL],
        '#t': [tag.toLowerCase()],
        limit,
        ...(since !== undefined ? { since } : {}),
        ...(until !== undefined ? { until } : {})
      }
    ];

    try {
      const relayPool = getRelayPool();
      const events = this.dropBlocked(await relayPool.fetchEvents(filters, waitForAll));
      EventCache.addEvents(events);
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
   * Reconnects any relay whose socket has dropped (e.g. closed by the
   * browser while the tab was backgrounded). Callers that resubscribe or
   * refetch right after this should await it first — sending a REQ to a
   * relay that's still mid-reconnect silently goes nowhere.
   */
  static async refreshRelayConnections(): Promise<void> {
    await getRelayPool().refreshConnectionStatus();
  }

  /**
   * Fetch chat messages for a live stream (NIP-53, kind 1311) — filtered
   * by the 'a' tag coordinate ("<kind>:<pubkey>:<d-tag>") of the live
   * event they belong to. Returned oldest-first, ready to render top to
   * bottom like a normal chat log.
   */
  /**
   * A stream's own mute list, kept by whoever runs the stream.
   *
   * Nostr has no way to take a message back or to make another client hide
   * it — chat messages are public events, and each client decides what to
   * show. What a host *can* do is publish who they have thrown out, and
   * clients that care can honour it. Measured before building this: of 154
   * live events on the relays, not one named a moderator, and no report or
   * label pointed at a stream — so there was no convention to follow.
   *
   * Kept as a NIP-51 people set (kind 30000) whose `d` names the stream, so
   * it is addressable, replaceable, and readable by anyone.
   */
  private static streamMuteIdentifier(identifier: string): string {
    return `livechat-mute:${identifier}`;
  }

  static async fetchStreamMuteList(owners: string[], identifier: string): Promise<Set<string>> {
    const muted = new Set<string>();
    if (owners.length === 0) return muted;

    try {
      // waitForAll: the pool normally returns as soon as any relay answers,
      // and a list like this lives on the two or three relays its owner
      // publishes to — the fast "nothing here" from everyone else would win
      // the race and the list would read as empty
      const events = await getRelayPool().fetchEvents([{
        kinds: [EVENT_KINDS.PEOPLE_SET],
        authors: owners,
        '#d': [this.streamMuteIdentifier(identifier)]
      }], true);

      // Replaceable per author: only their newest list counts
      const newest = new Map<string, NostrEventSigned>();
      for (const event of events) {
        const held = newest.get(event.pubkey);
        if (!held || (event.created_at || 0) > (held.created_at || 0)) newest.set(event.pubkey, event);
      }
      for (const event of newest.values()) {
        for (const tag of event.tags) {
          if (tag[0] === 'p' && tag[1]) muted.add(tag[1]);
        }
      }
    } catch (error) {
      console.error('Failed to fetch the stream mute list:', error);
    }
    return muted;
  }

  /** Add or remove someone from the stream's list. Only its owner can. */
  static async setStreamMuted(
    address: string,
    identifier: string,
    target: string,
    muted: boolean
  ): Promise<Set<string>> {
    const ownPubkey = CredentialManager.getPublicKey();
    if (!ownPubkey) throw new Error('Public key not found');

    const current = await this.fetchStreamMuteList([ownPubkey], identifier);
    if (muted) current.add(target); else current.delete(target);

    const signed = await this.signAnyMode({
      kind: EVENT_KINDS.PEOPLE_SET,
      content: '',
      tags: [
        ['d', this.streamMuteIdentifier(identifier)],
        // What the list is about, so it can be found from the stream itself
        ['a', address],
        ...[...current].map(pubkey => ['p', pubkey])
      ]
    });

    const results = await getRelayPool().publishEvent(signed);
    if (!Array.from(results.values()).some(Boolean)) {
      throw new Error('No relay accepted the change');
    }
    return current;
  }

  /**
   * Announce that this account is watching a live stream (NIP-53 room
   * presence, kind 10312). Being replaceable, each viewer has one current
   * event; it is republished while they stay, and simply goes stale once
   * they leave. Without publishing one, a viewer who never says anything is
   * invisible to every client — including this one.
   */
  static async publishLivePresence(address: string, relayHint?: string): Promise<boolean> {
    if (!CredentialManager.canSign()) return false;

    try {
      const signed = await this.signAnyMode({
        kind: EVENT_KINDS.LIVE_PRESENCE,
        content: '',
        tags: [['a', address, relayHint || '', 'root']]
      });
      const results = await getRelayPool().publishEvent(signed);
      return Array.from(results.values()).some(Boolean);
    } catch (error) {
      console.error('Failed to publish presence:', error);
      return false;
    }
  }

  /**
   * Reactions (kind 7) to a batch of events — one query for a whole chat's
   * worth of messages rather than one per message.
   */
  static async fetchReactionsTo(eventIds: string[]): Promise<NostrEventSigned[]> {
    if (eventIds.length === 0) return [];
    try {
      return await getRelayPool().fetchEvents([
        { kinds: [EVENT_KINDS.REACTION], '#e': eventIds, limit: 1000 }
      ]);
    } catch (error) {
      console.error('Failed to fetch reactions:', error);
      return [];
    }
  }

  /**
   * Sign a NIP-57 zap request (kind 9734) to hand to the LNURL provider.
   * It is never published by us — the provider embeds it in the receipt it
   * publishes once the invoice is paid, which is what makes a zap public.
   * Returns null when we cannot sign, leaving the payment anonymous.
   */
  static async createZapRequest(params: {
    recipientPubkey: string;
    amountMsats: number;
    eventId?: string;
    eventAddress?: string;
    comment?: string;
  }): Promise<string | null> {
    if (!CredentialManager.canSign()) return null;

    try {
      const relays = getRelayPool().getRelays().slice(0, 6);
      const tags: string[][] = [
        ['p', params.recipientPubkey],
        ['amount', String(params.amountMsats)],
        ['relays', ...relays]
      ];
      if (params.eventId) tags.push(['e', params.eventId]);
      if (params.eventAddress) tags.push(['a', params.eventAddress]);

      const signed = await this.signAnyMode({
        kind: EVENT_KINDS.ZAP_REQUEST,
        content: params.comment || '',
        tags
      });
      return JSON.stringify(signed);
    } catch (error) {
      console.error('Failed to create zap request:', error);
      return null;
    }
  }

  /**
   * A receipt is supposed to carry the invoice that was paid and the zap
   * request behind it. Some carry neither, leaving nothing to show but
   * "Someone zapped 0 sats" — of 596 receipts sampled across live streams,
   * 38 were like this.
   */
  static zapIsShowable(zapReceipt: NostrEventSigned): boolean {
    return this.parseZapAmountSats(zapReceipt) > 0 || !!this.zapComment(zapReceipt);
  }

  /**
   * Zap receipts (kind 9735) aimed at a live stream — the ones tagged with
   * the stream's address, which is how a zap made from the stream page is
   * distinguished from any other zap to the same person.
   */
  static async fetchLiveZaps(address: string, limit: number = 100): Promise<NostrEventSigned[]> {
    try {
      // Waits for every relay. Asked the usual way — first answer wins — the
      // zaps a stream has taken came back all but empty, so the chat showed
      // none while the zappers panel, whose subscription replays them from
      // scratch, listed a dozen
      const events = await getRelayPool().fetchEvents([
        { kinds: [EVENT_KINDS.ZAP_RECEIPT], '#a': [address], limit }
      ], true);
      return events
        .filter(event => this.zapIsShowable(event))
        .sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
    } catch (error) {
      console.error('Failed to fetch live stream zaps:', error);
      return [];
    }
  }

  /**
   * Who paid, per the zap request the provider embedded in the receipt.
   * The receipt itself is signed by the provider, so its pubkey is the
   * wallet's, not the sender's.
   */
  static zapSenderPubkey(zapReceipt: NostrEventSigned): string | null {
    try {
      const description = zapReceipt.tags.find(t => t[0] === 'description')?.[1];
      if (!description) return null;
      const zapRequest = JSON.parse(description);
      return typeof zapRequest.pubkey === 'string' ? zapRequest.pubkey : null;
    } catch {
      return null;
    }
  }

  /**
   * Who was paid. The receipt carries the recipient's 'p' tag, but not every
   * provider copies it across, so fall back to the embedded zap request.
   */
  static zapRecipientPubkey(zapReceipt: NostrEventSigned): string | null {
    const direct = zapReceipt.tags.find(t => t[0] === 'p')?.[1];
    if (direct) return direct;
    try {
      const description = zapReceipt.tags.find(t => t[0] === 'description')?.[1];
      if (!description) return null;
      const zapRequest = JSON.parse(description);
      return (zapRequest.tags as string[][] | undefined)?.find(t => t[0] === 'p')?.[1] || null;
    } catch {
      return null;
    }
  }

  /** The message the sender attached to the zap, if any */
  static zapComment(zapReceipt: NostrEventSigned): string {
    try {
      const description = zapReceipt.tags.find(t => t[0] === 'description')?.[1];
      if (!description) return '';
      const zapRequest = JSON.parse(description);
      return typeof zapRequest.content === 'string' ? zapRequest.content : '';
    } catch {
      return '';
    }
  }

  static async fetchLiveChatMessages(
    address: string,
    limit: number = 200,
    /**
     * Wait for every relay instead of returning on the first answer. The
     * quick answer is what the chat opens with; asked again this way, the
     * relays that were slower fill in what the first one did not have —
     * which is what made a chat look stuck until it was reloaded.
     */
    waitForAll: boolean = false
  ): Promise<NostrEventSigned[]> {
    try {
      const relayPool = getRelayPool();
      const events = await relayPool.fetchEvents([
        { kinds: [EVENT_KINDS.LIVE_CHAT_MESSAGE], '#a': [address], limit }
      ], waitForAll);
      return events.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
    } catch (error) {
      console.error('Failed to fetch live chat messages:', error);
      return [];
    }
  }

  /**
   * Post a chat message to a live stream (NIP-53, kind 1311).
   */
  static async publishLiveChatMessage(
    address: string,
    relayHint: string | undefined,
    content: string,
    /** Anyone tagged in the message — without a 'p' tag they never hear of it */
    mentioned: string[] = []
  ): Promise<NostrEventSigned | null> {
    if (!CredentialManager.canSign()) {
      console.error('No signing method available');
      return null;
    }

    const event: NostrEvent = {
      kind: EVENT_KINDS.LIVE_CHAT_MESSAGE,
      content,
      tags: [
        ['a', address, relayHint || '', 'root'],
        ...Array.from(new Set(mentioned)).map(pubkey => ['p', pubkey])
      ]
    };

    try {
      const signed = await this.signAnyMode(event);

      if (!signed) throw new Error('Failed to sign event');

      const relayPool = getRelayPool();
      const results = await relayPool.publishEvent(signed);
      if (!Array.from(results.values()).some(Boolean)) {
        throw new Error('No relay accepted the chat message');
      }
      return signed;
    } catch (error) {
      console.error('Failed to publish live chat message:', error);
      throw error;
    }
  }

  /**
   * Fetch replies to an event
   */
  static async fetchReplies(
    eventId: string,
    limit: number = 50,
    /**
     * Wait for every relay rather than stopping shortly after the first one
     * answers. The quick way is right for a feed, where a card is one of a
     * hundred; it is wrong for the post someone opened, where a relay that
     * was a second slow means the conversation reads as empty.
     */
    thorough: boolean = false
  ): Promise<NostrEventSigned[]> {
    const filters: NostrFilter[] = [
      {
        // Both ways of writing a reply: the older kind 1 carrying 'e' tags,
        // and NIP-22 comments, which is what Amethyst now writes. The
        // comment's parent is its lowercase 'e', so one filter finds both.
        kinds: [EVENT_KINDS.TEXT_NOTE, EVENT_KINDS.COMMENT],
        '#e': [eventId],
        limit
      }
    ];

    try {
      const relayPool = getRelayPool();
      const events = this.dropBlocked(await relayPool.fetchEvents(filters, thorough));
      EventCache.addEvents(events);
      return events.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    } catch (error) {
      console.error('Failed to fetch replies:', error);
      return [];
    }
  }

  /**
   * Sign event using extension or private key
   */
  /**
   * Sign an event with whatever this session logged in with. Every publish
   * used to carry its own copy of this if/else, which is why adding a third
   * signer meant touching ten places.
   *
   * With an Android signer (NIP-55) there is no in-page signing: this
   * navigates to the signer app and never returns. The page comes back
   * through the callback URL and the signed event is published there.
   */
  static async signAnyMode(event: NostrEvent): Promise<NostrEventSigned> {
    // A paired remote signer answers over a relay, so unlike NIP-55 this
    // returns here rather than navigating the page away
    if (CredentialManager.isBunkerMode()) {
      return bunkerSignEvent(event);
    }
    if (CredentialManager.isExtensionMode()) {
      return this.signEventWithExtension(event);
    }
    const privkey = CredentialManager.getPrivateKey();
    if (!privkey) throw new Error('Private key not found');
    return NostrCrypto.signEvent(event, privkey);
  }

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
    if (!CredentialManager.canSign()) {
      console.error('No signing method available');
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

      const signed = await this.signAnyMode(event);

      if (!signed) throw new Error('Failed to sign event');

      const relayPool = getRelayPool();
      const results = await relayPool.publishEvent(signed);
      if (!Array.from(results.values()).some(Boolean)) {
        throw new Error('No relay accepted the reaction');
      }
      this.rememberOwnAction('reactions', eventId, emoji);
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
    if (!CredentialManager.canSign()) {
      console.error('No signing method available');
      return null;
    }

    try {
      const event: NostrEvent = {
        kind: EVENT_KINDS.REPOST,
        content: JSON.stringify(original),
        tags: [['e', original.id], ['p', original.pubkey]]
      };

      const signed = await this.signAnyMode(event);

      if (!signed) throw new Error('Failed to sign event');

      const relayPool = getRelayPool();
      const results = await relayPool.publishEvent(signed);
      if (!Array.from(results.values()).some(Boolean)) {
        throw new Error('No relay accepted the repost');
      }
      this.rememberOwnAction('reposts', original.id, '1');
      return signed;
    } catch (error) {
      console.error('Failed to repost:', error);
      return null;
    }
  }

  /**
   * Extract the amount in sats from a zap receipt (kind 9735)
   */
  static parseZapAmountSats(zapReceipt: NostrEventSigned): number {
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
  /**
   * What this account has done to a note, remembered locally.
   *
   * Relays take a moment to index a reaction and the pool answers shortly
   * after the first of them replies, so a like you just made is usually
   * absent from the next engagement query — and the card would drop it,
   * showing nothing for something that did happen.
   */
  private static ownActionsKey(kind: 'reactions' | 'reposts'): string {
    return `own_${kind}_${CredentialManager.getPublicKey() || 'anon'}`;
  }

  private static readOwnActions(kind: 'reactions' | 'reposts'): Record<string, string> {
    return PersistentCache.get<Record<string, string>>(this.ownActionsKey(kind)) || {};
  }

  private static rememberOwnAction(kind: 'reactions' | 'reposts', eventId: string, value: string): void {
    const all = this.readOwnActions(kind);
    all[eventId] = value;
    // Bounded: only the recent ones matter, since older notes come back from
    // the relays reliably by then
    const trimmed = Object.entries(all).slice(-300);
    PersistentCache.set(this.ownActionsKey(kind), Object.fromEntries(trimmed));
  }

  /**
   * The last numbers seen under a post, kept so that a reader coming back to
   * the feed reads them straight away instead of watching a row of noughts
   * until the relays answer. Four numbers per post, so the whole page's worth
   * costs less than one of the posts it belongs to.
   */
  private static readonly ENGAGEMENT_MEMORY_KEY = 'engagement_counts';
  private static readonly ENGAGEMENT_MEMORY_LIMIT = 400;
  private static engagementMemory: Map<string, EngagementCounts> | null = null;

  private static engagementCounts(): Map<string, EngagementCounts> {
    if (!this.engagementMemory) {
      const stored = PersistentCache.get<[string, EngagementCounts][]>(this.ENGAGEMENT_MEMORY_KEY);
      this.engagementMemory = new Map(stored || []);
    }
    return this.engagementMemory;
  }

  /** What was last counted under this post, if it has been seen before */
  static rememberedEngagement(eventId: string): EngagementCounts | null {
    return this.engagementCounts().get(eventId) || null;
  }

  private static rememberEngagement(eventId: string, counts: EngagementCounts): void {
    const memory = this.engagementCounts();
    // Re-inserted so the most recently read posts are the ones kept
    memory.delete(eventId);
    memory.set(eventId, counts);
    while (memory.size > this.ENGAGEMENT_MEMORY_LIMIT) {
      const oldest = memory.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      memory.delete(oldest);
    }
    PersistentCache.set(this.ENGAGEMENT_MEMORY_KEY, Array.from(memory.entries()));
  }

  // Cards ask about their own post; the relays are asked about fifty at a
  // time. Whoever asks first waits a fifth of a second for the rest of the
  // page to join them — long enough for a screenful of cards to be drawn,
  // short enough not to be seen.
  private static engagementWaiting = new Map<string, ((events: NostrEventSigned[]) => void)[]>();
  private static engagementTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly ENGAGEMENT_BATCH = 50;

  private static engagementFor(eventId: string): Promise<NostrEventSigned[]> {
    return new Promise(resolve => {
      const waiting = this.engagementWaiting.get(eventId) || [];
      waiting.push(resolve);
      this.engagementWaiting.set(eventId, waiting);

      if (this.engagementWaiting.size >= this.ENGAGEMENT_BATCH) {
        void this.askAboutWaitingPosts();
      } else if (!this.engagementTimer) {
        this.engagementTimer = setTimeout(() => { void this.askAboutWaitingPosts(); }, 200);
      }
    });
  }

  private static async askAboutWaitingPosts(): Promise<void> {
    if (this.engagementTimer) {
      clearTimeout(this.engagementTimer);
      this.engagementTimer = null;
    }

    const asked = this.engagementWaiting;
    this.engagementWaiting = new Map();
    const ids = Array.from(asked.keys());
    if (ids.length === 0) return;

    let events: NostrEventSigned[] = [];
    try {
      events = await getRelayPool().fetchEvents([
        {
          kinds: [
            EVENT_KINDS.TEXT_NOTE,
            EVENT_KINDS.COMMENT,
            EVENT_KINDS.REPOST,
            EVENT_KINDS.REACTION,
            EVENT_KINDS.ZAP_RECEIPT
          ],
          '#e': ids,
          limit: 2000
        }
      ]);
    } catch (error) {
      console.error('Failed to fetch engagement:', error);
    }

    // An answer can belong to more than one of them — a reply carries the
    // thread's root as well as the post it answers
    const wanted = new Set(ids);
    const perPost = new Map<string, NostrEventSigned[]>(ids.map(id => [id, []]));
    for (const event of events) {
      const named = new Set(
        event.tags.filter(t => t[0] === 'e' && wanted.has(t[1])).map(t => t[1])
      );
      for (const id of named) perPost.get(id)!.push(event);
    }

    for (const [id, resolvers] of asked) {
      const found = perPost.get(id) || [];
      for (const resolve of resolvers) resolve(found);
    }
  }

  static async fetchEngagement(eventId: string, thorough: boolean = false): Promise<{
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
      // One post on its own where it is the post being read; otherwise the
      // question is asked for a page of them at once. A feed of a hundred
      // cards each asking on its own was a hundred queries to every relay —
      // measured at 1,272 of them in forty seconds, which is why the numbers
      // took so long to appear and why the posts themselves were slow behind
      // them.
      const events = thorough
        ? await getRelayPool().fetchEvents([
            {
              kinds: [
                EVENT_KINDS.TEXT_NOTE,
                EVENT_KINDS.COMMENT,
                EVENT_KINDS.REPOST,
                EVENT_KINDS.REACTION,
                EVENT_KINDS.ZAP_RECEIPT
              ],
              '#e': [eventId],
              limit: 500
            }
          ], true)
        : await this.engagementFor(eventId);

      const ownPubkey = CredentialManager.getPublicKey();

      for (const ev of events) {
        if (ev.kind === EVENT_KINDS.TEXT_NOTE || ev.kind === EVENT_KINDS.COMMENT) {
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

    // Fold in what this browser knows it did. Without this a like vanishes
    // from the card seconds after being made, because the relays haven't
    // caught up yet.
    const ownReaction = this.readOwnActions('reactions')[eventId];
    if (ownReaction && !result.myReaction) {
      result.myReaction = ownReaction;
      result.likes += 1;
    }
    if (this.readOwnActions('reposts')[eventId] && !result.myRepost) {
      result.myRepost = true;
      result.reposts += 1;
    }

    this.rememberEngagement(eventId, {
      replies: result.replies,
      reposts: result.reposts,
      likes: result.likes,
      zapSats: result.zapSats
    });

    return result;
  }

  /**
   * Delete an event (kind 5)
   */
  static async deleteEvent(eventId: string): Promise<NostrEventSigned | null> {
    
    if (!CredentialManager.canSign()) {
      console.error('No signing method available');
      return null;
    }

    const event: NostrEvent = {
      kind: EVENT_KINDS.DELETION,
      content: '',
      tags: [['e', eventId]]
    };

    try {
      const signed = await this.signAnyMode(event);

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
   * Fetch event by ID. If a note only lives on one or two of our relays,
   * whether this succeeds can come down to whether that specific relay
   * happened to answer inside our timeout window on this particular
   * attempt — normal variance on a decentralized network, not something
   * a single try can paper over. Retry a couple of times, a beat apart,
   * before actually reporting it missing.
   *
   * `hintRelays` are relay hints carried by an nevent/nprofile/naddr
   * reference itself (NIP-19) — the whole point of embedding them is that
   * the referenced event might not be on any relay we'd otherwise think to
   * ask, e.g. a note bridged in from the Fediverse living only on a bridge
   * relay. Tried after our own pool comes up empty.
   */
  static async fetchEventById(eventId: string, hintRelays?: string[], authorHint?: string): Promise<NostrEventSigned | null> {
    // An event is immutable once signed, so a copy we already hold is as
    // good as a fetched one — and this lookup is expensive: waitForAll,
    // twice, a second apart. Walking a reply chain used to pay that per
    // ancestor, in sequence, for notes usually sitting in the feed cache.
    const known = EventCache.getEvent(eventId);
    if (known) return known;

    const filters: NostrFilter[] = [
      {
        ids: [eventId]
      }
    ];
    const relayPool = getRelayPool();

    // Our own pool and the reference's relay hints are tried in parallel,
    // not the hint only after the pool gives up — that used to mean up to
    // ~12s of retrying relays that were never going to have this event
    // before even touching the one relay that actually does.
    const poolAttempt = async (): Promise<NostrEventSigned | null> => {
      // waitForAll — a single-note lookup only has one relay that can ever
      // answer (an exact id match), so the early-exit optimization (built
      // for "a fast relay's results are good enough") has nothing to gain
      // here and can only cost us the note if that one relay is slow.
      // Retried a couple of times, a beat apart: whether this succeeds can
      // come down to whether the one relay that has it happened to answer
      // inside our timeout window on this particular attempt.
      for (let i = 0; i < 2; i++) {
        const events = await relayPool.fetchEvents(filters, true);
        if (events[0]) return events[0];
        if (i === 0) await new Promise(resolve => setTimeout(resolve, 1000));
      }
      return null;
    };

    const hintAttempt = async (): Promise<NostrEventSigned | null> => {
      if (!hintRelays || hintRelays.length === 0) return null;
      const knownRelays = new Set(relayPool.getRelayConfigs().map(c => c.url));
      const extraRelays = hintRelays.filter(url => !knownRelays.has(url));
      if (extraRelays.length === 0) return null;
      const events = await relayPool.fetchEventsFromExtraRelays(extraRelays, filters);
      return events[0] || null;
    };

    // Modern nevent references often embed the author's pubkey alongside
    // (or instead of) explicit relay hints. When neither our pool nor an
    // explicit hint has the note, check that author's own NIP-65 write
    // relays — the same outbox fallback already used for live events —
    // since plenty of notes only ever get published there.
    const authorOutboxAttempt = async (): Promise<NostrEventSigned | null> => {
      if (!authorHint) return null;
      const relayLists = await this.fetchRelayLists([authorHint]);
      const authorRelays = relayLists.get(authorHint);
      if (!authorRelays || authorRelays.length === 0) return null;
      const knownRelays = new Set(relayPool.getRelayConfigs().map(c => c.url));
      const alreadyTried = new Set(hintRelays || []);
      const extraRelays = authorRelays.filter(url => !knownRelays.has(url) && !alreadyTried.has(url));
      if (extraRelays.length === 0) return null;
      const events = await relayPool.fetchEventsFromExtraRelays(extraRelays, filters);
      return events[0] || null;
    };

    try {
      const results = await Promise.allSettled([poolAttempt(), hintAttempt(), authorOutboxAttempt()]);
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          // Remember it: walking a thread asks for the same notes again
          EventCache.addEvent(result.value);
          return result.value;
        }
      }
      return null;
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
      const latest = matches.reduce((newest, current) =>
        (current.created_at || 0) > (newest.created_at || 0) ? current : newest
      );
      EventCache.addAddressable(latest);
      return latest;
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
      // Opening one of these afterwards should not have to ask the relays
      // again for something already on screen
      results.forEach(event => EventCache.addAddressable(event));
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
    // Neither lookup depends on the other's result, so run them
    // concurrently instead of paying both round-trips back to back
    const [poolResults, relayLists] = await Promise.all([
      this.fetchLiveEvents('live', authors, limit),
      this.fetchRelayLists(authors)
    ]);

    try {
      const relayPool = getRelayPool();
      const knownRelays = new Set(relayPool.getRelayConfigs().map(c => c.url));

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

    // Authored-stream lookup and participant-tag lookup are independent
    // queries — run them concurrently rather than one after the other
    const [authored, participantEvents] = await Promise.all([
      this.fetchLiveEventsOutbox(authors, limit),
      (async (): Promise<NostrEventSigned[]> => {
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

          return Array.from(latestByAddress.values()).filter(isEffectivelyLive);
        } catch (error) {
          console.error('Failed to fetch participant live events:', error);
          return [];
        }
      })()
    ]);

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
  /**
   * Read a pasted account identifier as a pubkey — npub, nprofile, a raw
   * hex key, any of them optionally carrying a `nostr:` prefix. Returns
   * null for anything that isn't one, so callers can fall back to a normal
   * text search.
   */
  static pubkeyFromIdentifier(input: string): string | null {
    const candidate = input.trim().replace(/^nostr:/i, '');
    if (!candidate) return null;

    if (/^[0-9a-f]{64}$/i.test(candidate)) return candidate.toLowerCase();

    if (/^(npub|nprofile)1[a-z0-9]+$/i.test(candidate)) {
      try {
        const decoded = nip19.decode(candidate.toLowerCase());
        if (decoded.type === 'npub' && typeof decoded.data === 'string') return decoded.data;
        if (decoded.type === 'nprofile') return (decoded.data as { pubkey: string }).pubkey;
      } catch {
        // Malformed bech32 — treat it as ordinary search text
      }
    }
    return null;
  }

  static async searchProfiles(query: string, limit: number = 30): Promise<UserProfile[]> {
    const queryLower = query.toLowerCase();

    // A pasted npub/nprofile/hex key names exactly one account — look it up
    // directly instead of hoping it turns up in the sample of profiles below
    const identifier = this.pubkeyFromIdentifier(query);
    if (identifier) {
      const profile = await this.fetchUserProfile(identifier);
      // Even with no kind 0 anywhere, the account itself is a valid result —
      // returning nothing would read as "no such user", which is wrong
      return [profile ?? { pubkey: identifier }];
    }

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
/** The four numbers under a post, as last counted */
export interface EngagementCounts {
  replies: number;
  reposts: number;
  likes: number;
  zapSats: number;
}

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

  // Bounded so a long session browsing feed after feed can't grow this
  // without limit; Map keeps insertion order, so the oldest go first
  private static readonly MAX_EVENTS = 2000;

  static addEvent(event: NostrEventSigned, relayUrl?: string): void {
    if (!this.cache.has(event.id)) {
      this.cache.set(event.id, { ...event, relayUrl });
      if (this.cache.size > this.MAX_EVENTS) {
        for (const id of this.cache.keys()) {
          this.cache.delete(id);
          if (this.cache.size <= this.MAX_EVENTS) break;
        }
      }
    }
  }

  /**
   * Remember a whole feed's worth of notes. Opening one of them afterwards
   * renders from here instead of going back to the relays for something we
   * already have.
   */
  static addEvents(events: NostrEventSigned[]): void {
    for (const event of events) this.addEvent(event);
  }

  // Addressable events (NIP-33/NIP-53) are identified by
  // "<kind>:<pubkey>:<d-tag>" rather than by id, so they need their own
  // index — looking one up by event id is not something a caller can do.
  private static addressable: Map<string, NostrEventSigned> = new Map();

  static addAddressable(event: NostrEventSigned): void {
    const dTag = event.tags.find(t => t[0] === 'd')?.[1] || '';
    const key = `${event.kind}:${event.pubkey}:${dTag}`;
    const existing = this.addressable.get(key);
    // Only the newest revision matters — that's what "replaceable" means
    if (!existing || (event.created_at || 0) >= (existing.created_at || 0)) {
      this.addressable.set(key, event);
    }
  }

  static getAddressable(kind: number, pubkey: string, identifier: string): NostrEventSigned | null {
    return this.addressable.get(`${kind}:${pubkey}:${identifier}`) || null;
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
