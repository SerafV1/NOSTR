import React, { useState, useEffect, useRef } from 'react';
import { NostrEventSigned } from '../types';
import { NostrCore, PersistentCache } from '../nostr/core';
import { CredentialManager } from '../nostr/crypto';
import EventCard from './EventCard';
import ComposeNote from './ComposeNote';

interface HomePageProps {
  relaysConnected: boolean;
  onNavigateToProfile: (pubkey: string) => void;
  onNavigateToNote?: (noteId: string) => void;
  onNavigateToTopic?: (topic: string) => void;
}

const HomePage: React.FC<HomePageProps> = ({ relaysConnected, onNavigateToProfile, onNavigateToNote, onNavigateToTopic }) => {
  const [events, setEvents] = useState<NostrEventSigned[]>([]);
  const [loading, setLoading] = useState(true);
  const [feedType, setFeedType] = useState<'global' | 'home'>('home');
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
  eventsRef.current = events;
  pendingRef.current = pendingEvents;

  // Read a cached feed, dropping future-dated spam that older versions
  // may have persisted
  const readCachedFeed = (type: 'global' | 'home'): NostrEventSigned[] => {
    const cached = PersistentCache.get<NostrEventSigned[]>(`feed_${type}`) || [];
    const maxTimestamp = Math.floor(Date.now() / 1000) + 300;
    return cached.filter(e => (e.created_at || 0) <= maxTimestamp);
  };

  useEffect(() => {
    if (relaysConnected) {
      fetchFeed();
    } else {
      // Relays not ready yet — show the cached feed instantly if we have one
      const cached = readCachedFeed(feedType);
      if (cached && cached.length > 0) {
        setEvents(cached);
        setLoading(false);
      } else {
        setLoading(true);
      }
    }
  }, [feedType, relaysConnected]);

  // Discard pending new posts when switching feeds
  useEffect(() => {
    setPendingEvents([]);
  }, [feedType]);

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
  }, [relaysConnected, feedType]);

  const showPendingPosts = () => {
    const pending = pendingRef.current;
    if (pending.length === 0) return;
    setEvents(prev => {
      const ids = new Set(pending.map(e => e.id));
      const merged = [...pending, ...prev.filter(e => !ids.has(e.id))];
      PersistentCache.set(`feed_${feedType}`, merged.slice(0, 100));
      return merged;
    });
    setPendingEvents([]);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const fetchFeed = async () => {
    // Stale-while-revalidate: render the cached feed immediately, then
    // fetch fresh events and silently replace it
    const cached = readCachedFeed(feedType);
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
      } else {
        console.log('Fetching home feed from followed accounts...');
        // First try to get followed accounts
        const followedAccounts = await (NostrCore as any).fetchFollowedAccounts();
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
          fetchedEvents = await (NostrCore as any).fetchHomeFeed(followedAccounts, 100);
        }
      }

      console.log('Fetched events:', fetchedEvents.length);

      // Merge fresh events with the cached feed instead of replacing it —
      // a thin fresh result (slow relays skipped) must not regress the feed
      const cachedNow = readCachedFeed(feedType);
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
      PersistentCache.set(`feed_${feedType}`, merged);
    } catch (error) {
      console.error('Failed to fetch feed:', error);
      // Keep showing the cached feed (if any) on fetch failure
    } finally {
      setLoading(false);
    }
  };

  const handleNotePublished = (event: NostrEventSigned) => {
    setEvents([event, ...events]);
  };

  // A kind-1 note referencing another event is a reply
  const isReply = (e: NostrEventSigned) => e.tags.some(t => t[0] === 'e');
  const visibleEvents = events.filter(e => (contentTab === 'replies' ? isReply(e) : !isReply(e)));

  return (
    <div className="home-page">
      <div className="home-container">
        <aside className="home-sidebar">
          <div className="sidebar-card">
            <h3>Feed Options</h3>
            <button 
              className={`option-btn ${feedType === 'global' ? 'active' : ''}`}
              onClick={() => setFeedType('global')}
            >
              Global Feed
            </button>
            <button 
              className={`option-btn ${feedType === 'home' ? 'active' : ''}`}
              onClick={() => setFeedType('home')}
            >
              Home Feed
            </button>
          </div>
        </aside>

        <main className="home-main">
          <ComposeNote onPublished={handleNotePublished} />

          <div className="feed-header">
            <h2>
              {feedType === 'global'
                ? 'Global Feed'
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
