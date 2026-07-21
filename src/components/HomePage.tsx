import React, { useState, useEffect, useRef } from 'react';
import { NostrEventSigned } from '../types';
import { NostrCore, PersistentCache } from '../nostr/core';
import { CredentialManager } from '../nostr/crypto';
import { loadCustomFeeds, saveCustomFeeds } from '../utils/customFeeds';
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

  // Discard pending new posts when switching feeds
  useEffect(() => {
    setPendingEvents([]);
  }, [feedType, activeTopic]);

  // Poll for posts newer than the newest one we show; they stack up behind
  // the "N new posts" button instead of shifting the feed
  useEffect(() => {
    if (!relaysConnected) return;

    const checkForNewPosts = async () => {
      const shown = [...pendingRef.current, ...eventsRef.current];
      if (shown.length === 0) return;
      // Clamp to now — a single future-dated event would otherwise push
      // `since` into the future and the poll would never match anything
      const newest = Math.min(
        Math.max(...shown.map(e => e.created_at || 0)),
        Math.floor(Date.now() / 1000)
      );

      try {
        let fresh: NostrEventSigned[];
        const authors = followedRef.current;
        if (feedType === 'home' && authors.length > 0) {
          fresh = await NostrCore.fetchHomeFeed(authors, 50, newest + 1);
        } else if (feedType === 'topic' && activeTopic) {
          fresh = await NostrCore.fetchEventsByTag(activeTopic, 50, newest + 1);
        } else {
          fresh = await NostrCore.fetchGlobalFeed(50, newest + 1);
        }

        const seen = new Set(shown.map(e => e.id));
        const newOnes = fresh.filter(e => !seen.has(e.id));
        if (newOnes.length === 0) return;

        // Prefetch author profiles so the cards render instantly on click
        await NostrCore.fetchProfiles(newOnes.map(e => e.pubkey));

        setPendingEvents(prev => {
          const ids = new Set(prev.map(e => e.id));
          const merged = [...newOnes.filter(e => !ids.has(e.id)), ...prev];
          merged.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
          return merged.slice(0, 50);
        });
      } catch (error) {
        console.error('Failed to check for new posts:', error);
      }
    };

    // First check soon after load, then every 30s
    const firstCheck = setTimeout(checkForNewPosts, 10000);
    const interval = setInterval(checkForNewPosts, 30000);
    return () => {
      clearTimeout(firstCheck);
      clearInterval(interval);
    };
  }, [relaysConnected, feedType, activeTopic]);

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

          {pendingEvents.length > 0 && (
            <button className="new-posts-btn" onClick={showPendingPosts}>
              ↑ Show {pendingEvents.length} new {pendingEvents.length === 1 ? 'post' : 'posts'}
            </button>
          )}

          {loading && (
            <div className="loading">
              {!relaysConnected ? 'Connecting to relays...' : 'Loading feed...'}
            </div>
          )}

          {!loading && visibleEvents.length === 0 && (
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
            {visibleEvents.map((event) => (
              <EventCard 
                key={event.id}
                event={event}
                onNavigateToProfile={onNavigateToProfile}
                onNavigateToNote={onNavigateToNote}
                onNavigateToTopic={onNavigateToTopic}
                onRefresh={fetchFeed}
              />
            ))}
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
