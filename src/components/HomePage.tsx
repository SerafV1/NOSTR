import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { NostrEventSigned, NostrFilter, EVENT_KINDS, UserProfile } from '../types';
import { NostrCore, PersistentCache, EventCache } from '../nostr/core';
import { CredentialManager } from '../nostr/crypto';
import { loadCustomFeeds, saveCustomFeeds } from '../utils/customFeeds';
import { parseLiveEvent, encodeLiveNaddr, LiveStreamInfo } from '../utils/liveStream';
import EventCard from './EventCard';

interface HomePageProps {
  relaysConnected: boolean;
  onNavigateToProfile: (pubkey: string) => void;
  onNavigateToNote?: (noteId: string) => void;
  onNavigateToTopic?: (topic: string) => void;
}

type FeedType = 'home' | 'global' | 'topic';

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
  // New posts found by background polling, shown behind an X-style
  // "N new posts" button instead of jumping into the feed
  const [pendingEvents, setPendingEvents] = useState<NostrEventSigned[]>([]);
  // Reposts from followed accounts — only shown on the home feed's Posts
  // tab, interleaved with your own notes X-style (fetched once per feed
  // load, not part of the live-subscription/pending mechanism above)
  const [reposts, setReposts] = useState<{ repost: NostrEventSigned; original: NostrEventSigned }[]>([]);
  const [liveStreams, setLiveStreams] = useState<LiveStreamInfo[]>([]);
  const [liveProfiles, setLiveProfiles] = useState<Map<string, UserProfile>>(new Map());
  const navigate = useNavigate();

  // Refs mirror state so the polling interval reads fresh values without
  // re-creating itself on every feed update
  const eventsRef = useRef<NostrEventSigned[]>([]);
  const pendingRef = useRef<NostrEventSigned[]>([]);
  const followedRef = useRef<string[]>([]);
  const feedDropdownRef = useRef<HTMLDivElement>(null);
  eventsRef.current = events;
  pendingRef.current = pendingEvents;

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

  // Read a cached feed, dropping future-dated spam that older versions
  // may have persisted
  const readCachedFeed = (): NostrEventSigned[] => {
    const cached = PersistentCache.get<NostrEventSigned[]>(feedCacheKey()) || [];
    const maxTimestamp = Math.floor(Date.now() / 1000) + 300;
    return cached.filter(e => (e.created_at || 0) <= maxTimestamp);
  };

  useEffect(() => {
    if (relaysConnected) {
      fetchFeed();
    } else {
      // Relays not ready yet — show the cached feed instantly if we have one
      const cached = readCachedFeed();
      if (cached && cached.length > 0) {
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
  }, [feedType, activeTopic]);

  // Check whether anyone you follow is currently live (NIP-53) so the Home
  // feed can surface it — refreshed periodically since a stream can start
  // any time, not just when this page first loads
  useEffect(() => {
    if (!relaysConnected || feedType !== 'home' || !hasFollows) {
      setLiveStreams([]);
      return;
    }

    let cancelled = false;
    const loadLiveStreams = async () => {
      try {
        const events = await NostrCore.fetchLiveEvents('live', followedRef.current);
        if (cancelled) return;
        const infos = events.map(parseLiveEvent).filter(s => s.streamingUrl);
        setLiveStreams(infos);
        if (infos.length > 0) {
          const profiles = await NostrCore.fetchProfiles(infos.map(s => s.pubkey));
          if (!cancelled) setLiveProfiles(profiles);
        }
      } catch (error) {
        console.error('Failed to check for live streams:', error);
      }
    };

    loadLiveStreams();
    const interval = setInterval(loadLiveStreams, 60000);
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

      const shown = [...pendingRef.current, ...eventsRef.current];
      if (shown.some(e => e.id === event.id)) return;

      // A real home feed only contains followed authors (plus your own
      // posts) — mirrors the filter fetchFeed applies to its merged result
      if (feedType === 'home' && hasFollows) {
        const followedSet = new Set(followedRef.current);
        const ownPubkey = CredentialManager.getPublicKey();
        if (ownPubkey) followedSet.add(ownPubkey);
        if (!followedSet.has(event.pubkey)) return;
      }

      // Prefetch the author's profile so the card renders instantly on click
      await NostrCore.fetchProfiles([event.pubkey]);

      setPendingEvents(prev => {
        if (prev.some(e => e.id === event.id)) return prev;
        const merged = [event, ...prev];
        merged.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
        return merged.slice(0, 50);
      });
    };

    let subId: string | null = null;
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
    // onclose. Resubscribing on return rides the freshly reconnected socket
    // (see App's visibilitychange handler) and replays anything missed
    // in the gap via the `since` cursor above.
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') resubscribe();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (subId) NostrCore.unsubscribeLive(subId);
    };
  }, [relaysConnected, feedType, activeTopic, hasFollows]);

  const showPendingPosts = () => {
    const pending = pendingRef.current;
    if (pending.length === 0) return;
    setEvents(prev => {
      const ids = new Set(pending.map(e => e.id));
      const merged = [...pending, ...prev.filter(e => !ids.has(e.id))];
      PersistentCache.set(feedCacheKey(), merged.slice(0, 100));
      return merged;
    });
    setPendingEvents([]);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const fetchFeed = async () => {
    // Stale-while-revalidate: render the cached feed immediately, then
    // fetch fresh events and silently replace it
    const cached = readCachedFeed();
    if (cached && cached.length > 0) {
      setEvents(cached);
      setLoading(false);
    } else {
      setLoading(true);
      setEvents([]); // Clear old events while loading new feed
    }
    try {
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
      if (feedType === 'home' && followedRef.current.length > 0) {
        const followedSet = new Set(followedRef.current);
        const ownPubkey = CredentialManager.getPublicKey();
        if (ownPubkey) followedSet.add(ownPubkey); // own posts stay in the home feed
        merged = merged.filter(e => followedSet.has(e.pubkey));
      }

      // One batch query for all author profiles so cards render instantly
      // instead of each card querying its author separately
      await NostrCore.fetchProfiles(merged.map(e => e.pubkey));

      setEvents(merged);
      PersistentCache.set(feedCacheKey(), merged);

      // Reposts only make sense for the home feed — showing everyone's
      // reposts on Global/Topic would be unfilterable noise
      if (feedType === 'home' && followedRef.current.length > 0) {
        const repostResults = await NostrCore.fetchReposts(followedRef.current, 50);
        await NostrCore.fetchProfiles(repostResults.map(r => r.repost.pubkey));
        setReposts(repostResults);
      } else {
        setReposts([]);
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

          {liveStreams.length > 0 && (
            <div className="live-banner">
              {liveStreams.map(stream => {
                const profile = liveProfiles.get(stream.pubkey);
                const hostName = profile?.display_name || profile?.name || 'Someone you follow';
                const naddr = encodeLiveNaddr(EVENT_KINDS.LIVE_EVENT, stream.pubkey, stream.dTag);
                return (
                  <button
                    key={`${stream.pubkey}:${stream.dTag}`}
                    className="live-banner-item"
                    onClick={() => navigate(`/live/${naddr}`)}
                  >
                    <span className="live-banner-badge">LIVE</span>
                    {profile?.picture && <img src={profile.picture} alt="" className="live-banner-avatar" />}
                    <span className="live-banner-text"><strong>{hostName}</strong> is live now — {stream.title}</span>
                  </button>
                );
              })}
            </div>
          )}

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

          {visiblePendingEvents.length > 0 && (
            <button className="new-posts-btn" onClick={showPendingPosts}>
              ↑ Show {visiblePendingEvents.length} new {visiblePendingEvents.length === 1 ? 'post' : 'posts'}
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
                      onRefresh={fetchFeed}
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
                  onRefresh={fetchFeed}
                />
              );
            })}
          </div>
        </main>

        <aside className="home-sidebar-right">
          <div className="sidebar-card">
            <h3>Stats</h3>
            <div className="stats">
              <div className="stat-item">
                <span className="stat-label">Notes in Feed</span>
                <span className="stat-value">{events.length}</span>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
};

export default HomePage;
