import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { NostrEventSigned, NostrFilter, EVENT_KINDS, UserProfile } from '../types';
import { NostrCore, PersistentCache, EventCache } from '../nostr/core';
import { CredentialManager } from '../nostr/crypto';
import EmojiText from './EmojiText';
import { formatAddress } from '../utils/helpers';
import { loadCustomFeeds, saveCustomFeeds } from '../utils/customFeeds';
import { parseLiveEvent, encodeLiveNaddr, LiveStreamInfo } from '../utils/liveStream';
import { noteFeedChange } from '../utils/feedTrail';
import EventCard from './EventCard';

interface HomePageProps {
  relaysConnected: boolean;
  onNavigateToProfile: (pubkey: string) => void;
  onNavigateToNote?: (noteId: string) => void;
  onNavigateToTopic?: (topic: string) => void;
}

type FeedType = 'home' | 'global' | 'topic';

// How often the live subscription re-checks its relays and re-issues its
// REQ. Short enough that a silently dead stream recovers while you're still
// looking at the page, long enough not to churn connections.
const LIVE_RESUBSCRIBE_MS = 3 * 60 * 1000;

const liveStreamsCacheKeyFor = (pubkey: string | null): string =>
  pubkey ? `live_streams_${pubkey}` : 'live_streams';

/**
 * Last known live streams, re-parsed rather than stored as parsed values:
 * parseLiveEvent derives status from the event's age, so a stream that has
 * ended since comes back as 'ended' and is dropped instead of being shown
 * as still running.
 */
const readCachedLiveStreams = (): { info: LiveStreamInfo; followedPubkey: string }[] => {
  const cached = PersistentCache.get<{ event: NostrEventSigned; matchedPubkey: string }[]>(
    liveStreamsCacheKeyFor(CredentialManager.getPublicKey())
  );
  if (!cached) return [];
  return cached
    .map(({ event, matchedPubkey }) => ({ info: parseLiveEvent(event), followedPubkey: matchedPubkey }))
    .filter(x => x.info.streamingUrl && x.info.status === 'live');
};

const HomePage: React.FC<HomePageProps> = ({ relaysConnected, onNavigateToProfile, onNavigateToNote, onNavigateToTopic }) => {
  const [events, setEvents] = useState<NostrEventSigned[]>([]);
  const [loading, setLoading] = useState(true);
  const [feedType, setFeedType] = useState<FeedType>('home');
  const [activeTopic, setActiveTopic] = useState<string | null>(null);
  const [customFeeds, setCustomFeeds] = useState<string[]>(() => loadCustomFeeds());
  const [showFeedDropdown, setShowFeedDropdown] = useState(false);
  const [showAddFeedInput, setShowAddFeedInput] = useState(false);
  const [newFeedHashtag, setNewFeedHashtag] = useState('');
  const [hasFollows, setHasFollows] = useState<boolean | null>(null);
  const [contentTab, setContentTab] = useState<'posts' | 'replies'>('posts');
  // Reading further back: a fetch in flight, and the point where the relays
  // stopped having anything older to give
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  // State is too slow to guard with: the observer can fire several times in
  // one tick, and every one of those would pass a check on `loadingOlder`
  // before React had re-rendered with it set
  const loadingOlderRef = useRef(false);
  // One empty answer is not the end: relays drop sockets and answer thinly.
  // Two in a row is.
  const emptyRunsRef = useRef(0);
  // New posts found by background polling, shown behind an X-style
  // "N new posts" button instead of jumping into the feed
  const [pendingEvents, setPendingEvents] = useState<NostrEventSigned[]>([]);
  // Reposts from followed accounts — only shown on the home feed's Posts
  // tab, interleaved with your own notes X-style (fetched once per feed
  // load, not part of the live-subscription/pending mechanism above)
  const [reposts, setReposts] = useState<{ repost: NostrEventSigned; original: NostrEventSigned }[]>([]);
  // Reposts newer than what is on screen, waiting behind the same button new
  // posts wait behind. Without this a background refresh slipped them into
  // the top of the timeline on its own, which is the one thing that button
  // exists to prevent.
  const [pendingReposts, setPendingReposts] = useState<{ repost: NostrEventSigned; original: NostrEventSigned }[]>([]);
  // Seeded from cache so returning to Home shows the sidebar immediately.
  // It used to be filled inside an effect gated on hasFollows, which isn't
  // known until the whole feed has loaded — so the panel sat empty for
  // seconds with the answer already in storage.
  const [liveStreams, setLiveStreams] = useState<{ info: LiveStreamInfo; followedPubkey: string }[]>(
    () => readCachedLiveStreams()
  );
  const [liveProfiles, setLiveProfiles] = useState<Map<string, UserProfile>>(new Map());
  const navigate = useNavigate();

  // Refs mirror state so the polling interval reads fresh values without
  // re-creating itself on every feed update
  const eventsRef = useRef<NostrEventSigned[]>([]);
  const pendingRef = useRef<NostrEventSigned[]>([]);
  const repostsRef = useRef<{ repost: NostrEventSigned; original: NostrEventSigned }[]>([]);
  // Which feed the last fetch was for, so a switch is told from a refresh
  const lastFetchedFeed = useRef<string | null>(null);
  const followedRef = useRef<string[]>([]);
  const feedDropdownRef = useRef<HTMLDivElement>(null);
  eventsRef.current = events;
  pendingRef.current = pendingEvents;
  repostsRef.current = reposts;

  // Close the feed dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (feedDropdownRef.current && !feedDropdownRef.current.contains(e.target as Node)) {
        setShowFeedDropdown(false);
        setShowAddFeedInput(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Global and topic feeds are the same public content for everyone, so
  // they're shared across identities on this browser. Home feed depends on
  // who *you* follow, so it's cached per-pubkey — otherwise switching
  // identities on the same browser would briefly flash the previous
  // identity's home feed.
  const feedCacheKey = (): string => {
    if (feedType === 'global') return 'feed_global';
    if (feedType === 'topic' && activeTopic) return `feed_topic_${activeTopic}`;
    const pubkey = CredentialManager.getPublicKey();
    return pubkey ? `feed_home_${pubkey}` : 'feed_home';
  };

  // Authors allowed in the home feed: everyone you follow, plus yourself.
  // Falls back to the last known follow list so a cached feed can be
  // filtered before this session's contact-list fetch has resolved.
  const homeAuthors = (): Set<string> | null => {
    const follows = followedRef.current.length > 0
      ? followedRef.current
      : NostrCore.getCachedFollowedAccounts();
    if (follows.length === 0) return null;
    const allowed = new Set(follows);
    const ownPubkey = CredentialManager.getPublicKey();
    if (ownPubkey) allowed.add(ownPubkey); // own posts stay in the home feed
    return allowed;
  };

  // Read a cached feed, dropping future-dated spam that older versions
  // may have persisted
  const readCachedFeed = (): NostrEventSigned[] => {
    const cached = PersistentCache.get<NostrEventSigned[]>(feedCacheKey()) || [];
    const maxTimestamp = Math.floor(Date.now() / 1000) + 300;
    // Blocking someone has to clear them out of what was already cached,
    // not just out of the next fetch
    const fresh = NostrCore.dropBlocked(cached.filter(e => (e.created_at || 0) <= maxTimestamp));
    if (feedType !== 'home') return fresh;
    // Heal a home cache polluted by the global fallback — an older build
    // persisted those strangers under this key, and they'd otherwise be
    // rendered as your home feed on every load until a fetch replaced them
    const allowed = homeAuthors();
    // No follow list to check against yet (first load after upgrading, or
    // storage cleared) — show nothing rather than a cache that might be
    // someone else's posts. It costs one loading spinner, once: the fetch
    // right after this persists the follow list, so every later load can
    // validate the cache and render it instantly.
    if (!allowed) return [];
    return fresh.filter(e => allowed.has(e.pubkey));
  };

  useEffect(() => {
    if (relaysConnected) {
      // Refreshing the feed already on screen is one thing; switching to
      // another is a different one. Only the first waits behind the button:
      // a switch that "refreshed" left the old feed on screen and pushed the
      // new one behind "show new posts", so choosing Global, or a hashtag of
      // your own, appeared to do nothing at all.
      const key = `${feedType}:${activeTopic || ''}`;
      const firstLoad = lastFetchedFeed.current === null;
      const sameFeed = lastFetchedFeed.current === key;
      lastFetchedFeed.current = key;
      // Kept behind the button in two cases: refreshing the feed already on
      // screen, and the first load of a feed this browser has kept — which
      // is what a reload is. A switch to another feed replaces.
      const keepWhatIsThere = sameFeed
        ? eventsRef.current.length > 0
        : firstLoad && readCachedFeed().length > 0;
      fetchFeed({ background: keepWhatIsThere });
    } else {
      // Relays not ready yet — show the cached feed instantly if we have one
      const cached = readCachedFeed();
      if (cached && cached.length > 0) {
        noteFeedChange('cache shown', `${cached.length} posts, relays not ready`);
        setEvents(cached);
        setLoading(false);
      } else {
        setLoading(true);
      }
    }
  }, [feedType, activeTopic, relaysConnected]);

  // Discard pending new posts and stale reposts when switching feeds
  useEffect(() => {
    setPendingEvents([]);
    setReposts([]);
    setPendingReposts([]);
  }, [feedType, activeTopic]);

  // Home-feed-local cache of the last live-stream check, so navigating away
  // and back doesn't leave the sidebar empty for the many seconds the NIP-65
  // outbox lookup below takes to redo from scratch — show the last known
  // result instantly, then refresh in the background
  const liveStreamsCacheKey = (): string => liveStreamsCacheKeyFor(CredentialManager.getPublicKey());

  // Check whether anyone you follow is currently live (NIP-53) so the Home
  // feed can surface it — refreshed periodically since a stream can start
  // any time, not just when this page first loads
  useEffect(() => {
    // Only clear when we actually know there's nothing to show. hasFollows
    // is null until the feed load resolves, and blanking on that would undo
    // the cached list this page just rendered.
    if (feedType !== 'home' || hasFollows === false) {
      setLiveStreams([]);
      return;
    }
    if (!relaysConnected || !hasFollows) return;

    let cancelled = false;

    {
      const infos = readCachedLiveStreams();
      setLiveStreams(infos);
      if (infos.length > 0) {
        NostrCore.fetchProfiles(infos.map(x => x.followedPubkey)).then(profiles => {
          if (!cancelled) setLiveProfiles(profiles);
        });
      }
    }

    const loadLiveStreams = async () => {
      try {
        // Checks streams a followed account authored (with NIP-65 outbox
        // lookup for their own relays) AND streams where they're merely
        // tagged as a participant/guest via a 'p' tag on someone else's event
        const results = await NostrCore.fetchLiveEventsForFollows(followedRef.current);
        if (cancelled) return;
        PersistentCache.set(liveStreamsCacheKey(), results);
        const infos = results
          .map(({ event, matchedPubkey }) => ({ info: parseLiveEvent(event), followedPubkey: matchedPubkey }))
          .filter(x => x.info.streamingUrl);
        setLiveStreams(infos);
        if (infos.length > 0) {
          const profiles = await NostrCore.fetchProfiles(infos.map(x => x.followedPubkey));
          if (!cancelled) setLiveProfiles(profiles);
        }
      } catch (error) {
        console.error('Failed to check for live streams:', error);
      }
    };

    loadLiveStreams();
    // This does a NIP-65 outbox lookup across every followed account,
    // opening short-lived connections to whatever relays that turns up —
    // expensive for anyone following a lot of people, so it runs rarely,
    // not every minute
    const interval = setInterval(loadLiveStreams, 300000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [relaysConnected, feedType, hasFollows]);

  // Live feed: keep a REQ subscription open on the relay socket instead of
  // polling on a timer. A relay replies to `since` with anything stored
  // since that cursor, then keeps streaming new matches as they're
  // published — so posts stack up behind the "N new posts" button in real
  // time, including while the tab is backgrounded. Browsers throttle JS
  // timers in hidden tabs, but not traffic on a socket that's already open,
  // which is why polling used to stall until you switched back.
  useEffect(() => {
    if (!relaysConnected) return;
    // Home feed depends on knowing who you follow first (set by fetchFeed)
    if (feedType === 'home' && hasFollows === null) return;

    const buildFilters = (since: number): NostrFilter[] => {
      const kinds = [EVENT_KINDS.TEXT_NOTE, EVENT_KINDS.POLL];
      if (feedType === 'topic' && activeTopic) {
        return [{ kinds, '#t': [activeTopic.toLowerCase()], since }];
      }
      if (feedType === 'home' && hasFollows) {
        return [{ kinds, authors: followedRef.current, since }];
      }
      return [{ kinds, since }];
    };

    const handleEvent = async (event: NostrEventSigned) => {
      const maxTimestamp = Math.floor(Date.now() / 1000) + 300; // 5 min clock-skew tolerance
      if ((event.created_at || 0) > maxTimestamp) return;

      if (NostrCore.isBlocked(event.pubkey)) return;

      const shown = [...pendingRef.current, ...eventsRef.current];
      if (shown.some(e => e.id === event.id)) return;

      // A real home feed only contains followed authors (plus your own
      // posts) — mirrors the filter fetchFeed applies to its merged result
      if (feedType === 'home' && hasFollows) {
        const allowed = homeAuthors();
        if (allowed && !allowed.has(event.pubkey)) return;
      }

      // Prefetch the author's profile so the card renders instantly on click
      await NostrCore.fetchProfiles([event.pubkey]);

      noteFeedChange('live arrival', `1 post from ${event.pubkey.slice(0, 8)}`);
      setPendingEvents(prev => {
        if (prev.some(e => e.id === event.id)) return prev;
        // Re-check against events too, not just at the top of this
        // function — an authoritative fetchFeed() refresh can land while
        // the fetchProfiles() await above was in flight and already show
        // this same post, which the earlier check (run before that await)
        // wouldn't have caught yet
        if (eventsRef.current.some(e => e.id === event.id)) return prev;
        const merged = [event, ...prev];
        merged.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
        return merged.slice(0, 50);
      });
    };

    let subId: string | null = null;
    let cancelled = false;
    const resubscribe = () => {
      if (subId) NostrCore.unsubscribeLive(subId);
      const shown = [...pendingRef.current, ...eventsRef.current];
      // Clamp to now — a single future-dated event would otherwise push
      // the cursor into the future and the subscription would replay nothing
      const cursor = shown.length > 0
        ? Math.min(Math.max(...shown.map(e => e.created_at || 0)) + 1, Math.floor(Date.now() / 1000))
        : Math.floor(Date.now() / 1000);
      subId = NostrCore.subscribeLive(buildFilters(cursor), handleEvent);
    };

    resubscribe();

    // A backgrounded tab's socket can die silently without ever firing
    // onclose. Sending the fresh REQ immediately on visibilitychange used
    // to race App's relay reconnect (same event, but that one's async) —
    // the REQ went out before the socket was actually back up and just
    // got lost, so the catch-up only showed up later, whenever something
    // else happened to resubscribe. Wait for reconnection to actually
    // finish before resubscribing.
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      NostrCore.refreshRelayConnections().then(() => {
        if (!cancelled) resubscribe();
      });
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    // Leave the tab open and in front all afternoon and nothing above ever
    // fires: visibilitychange needs you to leave and come back. Meanwhile a
    // socket can die quietly, or a relay can drop the REQ while the socket
    // stays open, and the feed goes silent with nothing to notice it. So
    // re-check on a timer too. Resubscribing carries a `since` cursor, so
    // anything published while the stream was dead is replayed rather than
    // lost, and nothing already shown comes back twice.
    const healthCheck = setInterval(() => {
      NostrCore.refreshRelayConnections().then(() => {
        if (!cancelled) resubscribe();
      });
    }, LIVE_RESUBSCRIBE_MS);

    return () => {
      cancelled = true;
      clearInterval(healthCheck);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (subId) NostrCore.unsubscribeLive(subId);
    };
  }, [relaysConnected, feedType, activeTopic, hasFollows]);

  const showPendingPosts = () => {
    const pending = pendingRef.current;
    const waitingReposts = pendingReposts;
    if (pending.length === 0 && waitingReposts.length === 0) return;

    noteFeedChange('button pressed', `${pending.length} posts, ${waitingReposts.length} reposts`);
    if (pending.length > 0) {
      setEvents(prev => {
        const ids = new Set(pending.map(e => e.id));
        const merged = [...pending, ...prev.filter(e => !ids.has(e.id))];
        PersistentCache.set(feedCacheKey(), merged.slice(0, 100));
        return merged;
      });
    }

    // The reposts held back with them go in at the same moment, or the
    // button would leave half of what it counted behind
    if (waitingReposts.length > 0) {
      setReposts(prev => {
        const ids = new Set(waitingReposts.map(r => r.repost.id));
        return [...waitingReposts, ...prev.filter(r => !ids.has(r.repost.id))];
      });
      setPendingReposts([]);
    }

    setPendingEvents([]);
    // .app-main is the actual scrolling element, not window — this page
    // never scrolls the window itself (.app is pinned to 100vh)
    document.querySelector('.app-main')?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  /**
   * `background` is a refresh of a feed already on screen — after the tab
   * comes back and the relays reconnect, say. Anything newer than what is
   * shown goes behind the "new posts" button rather than appearing under the
   * reader's eyes: coming back to the tab used to rewrite the feed on its
   * own, which is the one thing that button exists to prevent.
   */
  /**
   * The next page back, asked for from the oldest post on screen. Relays are
   * asked for what came before that moment rather than for "page 2" — there
   * are no pages in a set of relays that each hold a different slice.
   */
  const loadOlder = async () => {
    const shown = eventsRef.current;
    if (loadingOlderRef.current || reachedEnd || shown.length === 0) return;

    let until = Math.min(...shown.map(e => e.created_at || 0)) - 1;
    if (until <= 0) return;

    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const known = new Set(shown.map(e => e.id));

      // A page can come back holding nothing this feed shows — all of it
      // already on screen, or, on a home feed, all of it from people not
      // followed. That is not the end of the feed, so the reach goes further
      // back and asks again rather than stopping on the first empty page.
      for (let attempt = 0; attempt < 3; attempt++) {
        let older: NostrEventSigned[];

        // Every relay is heard out here, unlike the feed's own fetch: the
        // first answer decides whether there is history left, and a fast
        // relay with a short memory would end the feed for all of them
        if (feedType === 'global') {
          older = await NostrCore.fetchGlobalFeed(50, undefined, until, true);
        } else if (feedType === 'topic' && activeTopic) {
          older = await NostrCore.fetchEventsByTag(activeTopic, 50, undefined, until, true);
        } else if (followedRef.current.length > 0) {
          older = await NostrCore.fetchHomeFeed(followedRef.current, 50, undefined, until, true);
        } else {
          older = await NostrCore.fetchGlobalFeed(50, undefined, until, true);
        }

        if (older.length === 0) {
          // Nothing before this moment — but a relay that dropped its socket
          // answers the same way, so a day is stepped over and it is asked
          // again rather than the feed ending here
          until -= 86400;
          continue;
        }

        // Older than what was asked for, and nothing else. Not every relay
        // honours `until` — one that ignores it answers with its newest, and
        // those posts then arrived at the top of the feed as if they had been
        // scrolled to, which is exactly what the "show new posts" button
        // exists to prevent.
        let fresh = older.filter(e => !known.has(e.id) && (e.created_at || 0) <= until);
        // Same rule the feed itself keeps: a home feed holds followed authors
        if (feedType === 'home') {
          const allowed = homeAuthors();
          if (allowed) fresh = fresh.filter(e => allowed.has(e.pubkey));
        }

        if (fresh.length > 0) {
          emptyRunsRef.current = 0;
          noteFeedChange('older loaded', `${fresh.length} posts before ${new Date(until * 1000).toLocaleTimeString()}`);
          await NostrCore.fetchProfiles(fresh.map(e => e.pubkey));
          setEvents(prev => {
            const ids = new Set(prev.map(e => e.id));
            return [...prev, ...fresh.filter(e => !ids.has(e.id))]
              .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
          });
          return;
        }

        const oldestSeen = Math.min(...older.map(e => e.created_at || 0));
        // Not actually further back than the last ask, so asking again the
        // same way would return the same page for ever
        until = !oldestSeen || oldestSeen - 1 >= until ? until - 86400 : oldestSeen - 1;
      }

      // Three tries brought nothing this feed can show. Once is a thin
      // answer; twice running is the end of what the relays keep.
      emptyRunsRef.current += 1;
      if (emptyRunsRef.current >= 2) setReachedEnd(true);
    } catch (error) {
      console.error('Failed to load older posts:', error);
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  };

  // The end of the feed coming into view is the request for more. A margin
  // ahead of it so the next page is already arriving as the reader gets
  // there, rather than after they have stopped at the bottom.
  useEffect(() => {
    const sentinel = bottomRef.current;
    if (!sentinel || loading || reachedEnd) return;

    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) loadOlder(); },
      { rootMargin: '600px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, reachedEnd, loadingOlder, feedType, activeTopic, contentTab]);

  // A different feed starts again from its own newest
  useEffect(() => {
    setReachedEnd(false);
  }, [feedType, activeTopic]);

  const fetchFeed = async ({ background = false }: { background?: boolean } = {}) => {
    // Stale-while-revalidate: render the cached feed immediately, then fetch
    // fresh events behind it.
    //
    // A feed restored from the cache counts as a feed on screen, so what the
    // fetch brings back waits behind the "show new posts" button like any
    // other arrival. Without this a reload — which is what pulling down at
    // the top of a phone screen does — replaced everything with the newest
    // posts, and the feed looked as though it had moved on its own.
    const cached = readCachedFeed();
    if (!background) {
      // Arriving at this feed: whatever is on screen belongs to another one
      if (cached && cached.length > 0) {
        noteFeedChange('cache shown', `${cached.length} posts, replacing what was there`);
        setEvents(cached);
        eventsRef.current = cached;
        setLoading(false);
      } else {
        setLoading(true);
        setEvents([]); // Clear old events while loading new feed
        eventsRef.current = [];
      }
    } else if (eventsRef.current.length === 0 && cached && cached.length > 0) {
      // Refreshing with nothing drawn yet — a reload. The kept feed goes up
      // first, and what the fetch brings waits behind the button.
      // Assigned to the ref as well: the merge below reads it to decide what
      // counts as new, and no render has happened yet.
      noteFeedChange('cache shown', `${cached.length} posts, refreshing behind it`);
      setEvents(cached);
      eventsRef.current = cached;
      setLoading(false);
    }
    try {
      // Refresh the block list before the feed, so a block made in another
      // client (or on another device) is already in effect when posts land
      await NostrCore.fetchBlockedPubkeys();

      let fetchedEvents: NostrEventSigned[];

      if (feedType === 'global') {
        console.log('Fetching global feed...');
        fetchedEvents = await NostrCore.fetchGlobalFeed(100);
      } else if (feedType === 'topic' && activeTopic) {
        console.log('Fetching topic feed:', activeTopic);
        fetchedEvents = await NostrCore.fetchEventsByTag(activeTopic, 100);
      } else {
        console.log('Fetching home feed from followed accounts...');
        // First try to get followed accounts
        const followedAccounts = await NostrCore.fetchFollowedAccounts();
        console.log('Followed accounts:', followedAccounts);
        followedRef.current = followedAccounts;

        if (followedAccounts.length === 0) {
          // No followed accounts, use global feed instead
          setHasFollows(false);
          console.log('No followed accounts, showing global feed');
          fetchedEvents = await NostrCore.fetchGlobalFeed(100);
        } else {
          setHasFollows(true);
          // Fetch from followed accounts
          fetchedEvents = await NostrCore.fetchHomeFeed(followedAccounts, 100);
        }
      }

      console.log('Fetched events:', fetchedEvents.length);

      // Merge fresh events with the cached feed instead of replacing it —
      // a thin fresh result (slow relays skipped) must not regress the feed
      const cachedNow = readCachedFeed();
      const freshIds = new Set(fetchedEvents.map(e => e.id));
      let merged = [...fetchedEvents, ...cachedNow.filter(e => !freshIds.has(e.id))]
        .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
        .slice(0, 100);

      // A real home feed must only contain followed authors — drops global
      // posts cached earlier by the no-follows fallback
      if (feedType === 'home') {
        const allowed = homeAuthors();
        if (allowed) merged = merged.filter(e => allowed.has(e.pubkey));
      }

      // One batch query for all author profiles so cards render instantly
      // instead of each card querying its author separately
      await NostrCore.fetchProfiles(merged.map(e => e.pubkey));

      const shownNow = eventsRef.current;
      if (background && shownNow.length > 0) {
        const known = new Set(shownNow.map(e => e.id));
        const newestShown = Math.max(...shownNow.map(e => e.created_at || 0));
        // Only what is genuinely newer than the feed on screen — older posts
        // this fetch happened to reach further back for are not "new"
        const arrived = merged.filter(
          e => !known.has(e.id) && (e.created_at || 0) > newestShown
        );
        if (arrived.length > 0) {
          noteFeedChange('held back', `${arrived.length} posts waiting for the button`);
          setPendingEvents(prev => {
            const ids = new Set(prev.map(e => e.id));
            return [...arrived.filter(e => !ids.has(e.id)), ...prev]
              .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
              .slice(0, 50);
          });
        }
      } else {
        noteFeedChange('feed replaced', `${merged.length} posts, was ${eventsRef.current.length}`);
        setEvents(merged);
      }
      // The global fallback shown to an account with no follows is not a
      // home feed — persisting it under the home key would replay those
      // strangers as "your" feed on every later load
      if (!(feedType === 'home' && followedRef.current.length === 0)) {
        PersistentCache.set(feedCacheKey(), merged);
      }

      // The live subscription can start streaming "new" posts while this
      // fetch is still in flight (it doesn't wait for `events` to be ready
      // before computing its cursor) — anything it already queued up that
      // this authoritative fetch also picked up is now visible in `merged`,
      // so drop it from pending instead of double-counting/re-showing it
      setPendingEvents(prev => {
        const mergedIds = new Set(merged.map(e => e.id));
        return prev.filter(e => !mergedIds.has(e.id));
      });

      // Reposts only make sense for the home feed — showing everyone's
      // reposts on Global/Topic would be unfilterable noise
      if (feedType === 'home' && followedRef.current.length > 0) {
        let repostResults = await NostrCore.fetchReposts(followedRef.current, 50);
        // Keep reposts inside the window the feed itself covers. Relays hand
        // back reposts far older than the 100 notes above, and interleaving
        // those stretches the timeline back weeks — the feed then reads as
        // mostly other people's reposts rather than as your own feed.
        const oldestNote = merged.length > 0
          ? Math.min(...merged.map(e => e.created_at || 0))
          : 0;
        if (oldestNote > 0) {
          repostResults = repostResults.filter(r => (r.repost.created_at || 0) >= oldestNote);
        }
        await NostrCore.fetchProfiles(repostResults.map(r => r.repost.pubkey));

        const shownNotes = eventsRef.current;
        if (background && shownNotes.length > 0) {
          // Anything not already on screen waits for the button, whatever its
          // timestamp says. Holding back only what was newer than the top post
          // still let an older repost — one a previous fetch had missed —
          // appear in the middle of the timeline on its own.
          // Two ways a repost counts as already part of this feed: it is on
          // screen, or it is older than the newest post on screen — which is
          // what a feed restored from the cache looks like, since the cache
          // keeps notes and no reposts at all. Anything newer than the top
          // post is an arrival, and waits for the button.
          const shownReposts = new Set(repostsRef.current.map(r => r.repost.id));
          const newestShownNote = Math.max(...shownNotes.map(e => e.created_at || 0));
          const belongs = (r: { repost: NostrEventSigned }) =>
            shownReposts.has(r.repost.id) || (r.repost.created_at || 0) <= newestShownNote;

          const held = repostResults.filter(r => !belongs(r));
          if (held.length > 0) noteFeedChange('reposts held', `${held.length} waiting`);
          setReposts(repostResults.filter(belongs));
          setPendingReposts(held);
        } else {
          noteFeedChange('reposts shown', `${repostResults.length} with a fresh feed`);
          setReposts(repostResults);
          setPendingReposts([]);
        }
      } else {
        setReposts([]);
        setPendingReposts([]);
      }
    } catch (error) {
      console.error('Failed to fetch feed:', error);
      // Keep showing the cached feed (if any) on fetch failure
    } finally {
      setLoading(false);
    }
  };

  // A kind-1 note referencing another event is a reply
  const isReply = (e: NostrEventSigned) => e.tags.some(t => t[0] === 'e');
  const visibleEvents = events.filter(e => (contentTab === 'replies' ? isReply(e) : !isReply(e)));
  // pendingEvents mixes posts and replies — only count/show the ones that
  // actually match the active tab, otherwise the "N new posts" button can
  // fire and merge in items the current filter hides, looking like a no-op
  const visiblePendingEvents = pendingEvents.filter(e => (contentTab === 'replies' ? isReply(e) : !isReply(e)));
  // Reposts are only drawn on the posts tab, so they are only counted there
  const waitingCount = visiblePendingEvents.length + (contentTab === 'replies' ? 0 : pendingReposts.length);

  // Posts tab interleaves your notes with what followed accounts have
  // reposted, X-style, sorted newest first by whichever action is newer
  type TimelineItem =
    | { type: 'note'; key: string; createdAt: number; event: NostrEventSigned }
    | { type: 'repost'; key: string; createdAt: number; repost: NostrEventSigned; original: NostrEventSigned };

  const timelineItems: TimelineItem[] = contentTab === 'replies'
    ? visibleEvents.map(event => ({ type: 'note', key: event.id, createdAt: event.created_at || 0, event }))
    : [
        ...visibleEvents.map(event => ({ type: 'note' as const, key: event.id, createdAt: event.created_at || 0, event })),
        ...reposts.map(({ repost, original }) => ({
          type: 'repost' as const,
          key: repost.id,
          createdAt: repost.created_at || 0,
          repost,
          original
        }))
      ].sort((a, b) => b.createdAt - a.createdAt);

  const selectFeed = (type: FeedType, topic?: string) => {
    setFeedType(type);
    setActiveTopic(topic || null);
    setShowFeedDropdown(false);
    setShowAddFeedInput(false);
  };

  const handleAddFeed = (e: React.FormEvent) => {
    e.preventDefault();
    const tag = newFeedHashtag.trim().replace(/^#/, '').toLowerCase();
    if (!tag) return;
    if (!customFeeds.includes(tag)) {
      const updated = [...customFeeds, tag];
      setCustomFeeds(updated);
      saveCustomFeeds(updated);
    }
    setNewFeedHashtag('');
    selectFeed('topic', tag);
  };

  const handleRemoveFeed = (tag: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = customFeeds.filter(t => t !== tag);
    setCustomFeeds(updated);
    saveCustomFeeds(updated);
    if (feedType === 'topic' && activeTopic === tag) {
      selectFeed('home');
    }
  };

  const currentFeedLabel = feedType === 'global'
    ? 'Global Feed'
    : feedType === 'topic'
      ? `#${activeTopic}`
      : 'Home Feed';

  return (
    <div className="home-page">
      <div className="home-container">
        <aside className="home-sidebar">
          <div className="sidebar-card">
            <h3>Feed</h3>
            <div className="feed-dropdown-wrapper" ref={feedDropdownRef}>
              <button
                type="button"
                className="feed-dropdown-toggle"
                onClick={() => setShowFeedDropdown(show => !show)}
              >
                <span>{currentFeedLabel}</span>
                <span className="feed-dropdown-caret">▾</span>
              </button>

              {showFeedDropdown && (
                <div className="feed-dropdown-menu">
                  <button
                    type="button"
                    className={`feed-dropdown-item ${feedType === 'home' ? 'active' : ''}`}
                    onClick={() => selectFeed('home')}
                  >
                    Home Feed
                  </button>
                  <button
                    type="button"
                    className={`feed-dropdown-item ${feedType === 'global' ? 'active' : ''}`}
                    onClick={() => selectFeed('global')}
                  >
                    Global Feed
                  </button>

                  {customFeeds.length > 0 && <div className="feed-dropdown-divider" />}
                  {customFeeds.map(tag => (
                    <div
                      key={tag}
                      className={`feed-dropdown-item feed-dropdown-item-custom ${feedType === 'topic' && activeTopic === tag ? 'active' : ''}`}
                    >
                      <button
                        type="button"
                        className="feed-dropdown-item-label"
                        onClick={() => selectFeed('topic', tag)}
                      >
                        #{tag}
                      </button>
                      <button
                        type="button"
                        className="feed-dropdown-remove"
                        onClick={(e) => handleRemoveFeed(tag, e)}
                        title="Remove feed"
                      >
                        ✕
                      </button>
                    </div>
                  ))}

                  <div className="feed-dropdown-divider" />
                  {showAddFeedInput ? (
                    <form className="feed-dropdown-add-form" onSubmit={handleAddFeed}>
                      <input
                        autoFocus
                        type="text"
                        placeholder="hashtag"
                        value={newFeedHashtag}
                        onChange={(e) => setNewFeedHashtag(e.target.value)}
                      />
                      <button
                        type="submit"
                        className="btn btn-primary btn-small"
                        disabled={!newFeedHashtag.trim()}
                      >
                        Add
                      </button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      className="feed-dropdown-item feed-dropdown-add"
                      onClick={() => setShowAddFeedInput(true)}
                    >
                      + Add Feed
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </aside>

        <main className="home-main">
          <div className="feed-header">
            <h2>
              {feedType === 'global'
                ? 'Global Feed'
                : feedType === 'topic'
                  ? `#${activeTopic}`
                  : hasFollows === false
                    ? 'Global Feed (Follow accounts to build your home feed)'
                    : 'Home Feed'}
            </h2>
          </div>

          <div className="feed-tabs">
            <button
              className={`feed-tab ${contentTab === 'posts' ? 'active' : ''}`}
              onClick={() => setContentTab('posts')}
            >
              Posts
            </button>
            <button
              className={`feed-tab ${contentTab === 'replies' ? 'active' : ''}`}
              onClick={() => setContentTab('replies')}
            >
              Replies
            </button>
          </div>

          {waitingCount > 0 && (
            <button className="new-posts-btn" onClick={showPendingPosts}>
              ↑ Show {waitingCount} new {waitingCount === 1 ? 'post' : 'posts'}
            </button>
          )}

          {loading && (
            <div className="loading">
              {!relaysConnected ? 'Connecting to relays...' : 'Loading feed...'}
            </div>
          )}

          {!loading && timelineItems.length === 0 && (
            <div className="empty-state">
              <p>
                {contentTab === 'replies'
                  ? 'No replies in this feed'
                  : feedType === 'global'
                    ? 'No public notes found'
                    : feedType === 'topic'
                      ? `No posts found for #${activeTopic}`
                      : hasFollows === false
                        ? 'Start by following some accounts to build your home feed'
                        : 'No notes from accounts you follow'}
              </p>
            </div>
          )}

          <div className="events-list">
            {timelineItems.map((item) => {
              if (item.type === 'repost') {
                const reposterProfile = EventCache.getProfile(item.repost.pubkey);
                const reposterName = reposterProfile?.display_name || reposterProfile?.name || 'Someone you follow';
                return (
                  <div key={item.key} className="reposted-item">
                    <div className="reposted-label">
                      {reposterProfile?.picture && (
                        <img src={reposterProfile.picture} alt="" className="reposted-avatar" />
                      )}
                      {reposterName} Reposted
                    </div>
                    <EventCard
                      event={item.original}
                      onNavigateToProfile={onNavigateToProfile}
                      onNavigateToNote={onNavigateToNote}
                      onNavigateToTopic={onNavigateToTopic}
                      onRefresh={() => fetchFeed()}
                    />
                  </div>
                );
              }
              return (
                <EventCard
                  key={item.key}
                  event={item.event}
                  onNavigateToProfile={onNavigateToProfile}
                  onNavigateToNote={onNavigateToNote}
                  onNavigateToTopic={onNavigateToTopic}
                  onRefresh={() => fetchFeed()}
                />
              );
            })}
          </div>

          {timelineItems.length > 0 && (
            <div className="feed-end" ref={bottomRef}>
              {loadingOlder
                ? 'Loading older posts…'
                : reachedEnd
                  ? 'That is as far back as the relays go'
                  : ''}
            </div>
          )}
        </main>

        <aside className="home-sidebar-right">
          <div className="sidebar-card">
            <h3>Live Now</h3>
            {liveStreams.length === 0 ? (
              <p className="live-sidebar-empty">No one you follow is live right now.</p>
            ) : (
              <div className="live-banner">
                {liveStreams.map(({ info, followedPubkey }) => {
                  // liveProfiles is filled by a relay round trip, but the
                  // panel itself renders instantly from cache — so fall back
                  // to the locally known profile first. Otherwise the name
                  // visibly changes from a placeholder a second later.
                  const profile = liveProfiles.get(followedPubkey) || EventCache.getProfile(followedPubkey);
                  const name = profile?.display_name || profile?.name || formatAddress(followedPubkey);
                  const isGuest = followedPubkey !== info.pubkey;
                  const naddr = encodeLiveNaddr(EVENT_KINDS.LIVE_EVENT, info.pubkey, info.dTag);
                  return (
                    <button
                      key={`${info.pubkey}:${info.dTag}`}
                      className="live-banner-item"
                      onClick={() => navigate(`/live/${naddr}`)}
                    >
                      <span className="live-banner-badge">LIVE</span>
                      {profile?.picture && <img src={profile.picture} alt="" className="live-banner-avatar" />}
                      <span className="live-banner-text">
                        <strong><EmojiText text={name} emojis={profile?.emojis} /></strong> {isGuest ? 'is a guest on' : 'is live now —'} {info.title}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
};

export default HomePage;
