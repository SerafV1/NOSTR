import React, { useState, useEffect, useRef } from 'react';
import { NostrEventSigned, UserProfile } from '../types';
import { NostrCore, EventCache } from '../nostr/core';
import { CredentialManager } from '../nostr/crypto';
import { formatAddress } from '../utils/helpers';
import { extractImageUrls, extractVideoUrls, extractEmbeds } from '../utils/media';
import { loadCustomFeeds, addCustomFeed } from '../utils/customFeeds';
import EventCard from './EventCard';

const MAX_RECENT_SEARCHES = 8;

// Per-pubkey so switching identities on the same browser never shows one
// account's search history to another, while still caching for speed
const recentSearchesKey = (): string => {
  const pubkey = CredentialManager.getPublicKey();
  return pubkey ? `nostr_recent_searches_${pubkey}` : 'nostr_recent_searches';
};

const loadRecentSearches = (): string[] => {
  try {
    const raw = localStorage.getItem(recentSearchesKey());
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};

const saveRecentSearch = (term: string): string[] => {
  const existing = loadRecentSearches().filter(t => t.toLowerCase() !== term.toLowerCase());
  const updated = [term, ...existing].slice(0, MAX_RECENT_SEARCHES);
  try {
    localStorage.setItem(recentSearchesKey(), JSON.stringify(updated));
  } catch {
    // storage full or unavailable — recent searches are best-effort
  }
  return updated;
};

interface SearchPageProps {
  relaysConnected: boolean;
  onNavigateToProfile: (pubkey: string) => void;
  onNavigateToNote?: (noteId: string) => void;
  /** Preset topic to search (e.g. from clicking a #hashtag elsewhere) */
  initialTopic?: string | null;
  /** Bumped by the caller to force a re-search even if initialTopic is unchanged */
  topicNavKey?: number;
}

type TabKey = 'feeds' | 'people' | 'media' | 'zaps' | 'topics';

const TABS: { key: TabKey; label: string; icon: string }[] = [
  { key: 'feeds', label: 'Feeds', icon: '📰' },
  { key: 'people', label: 'People', icon: '👤' },
  { key: 'media', label: 'Media', icon: '🖼️' },
  { key: 'zaps', label: 'Zaps', icon: '⚡' },
  { key: 'topics', label: 'Topics', icon: '#' }
];

type ZappedNote = NostrEventSigned & { zapSats: number };

const hasMedia = (content: string) =>
  extractImageUrls(content).length > 0 ||
  extractVideoUrls(content).length > 0 ||
  extractEmbeds(content).length > 0;

const SearchPage: React.FC<SearchPageProps> = ({ relaysConnected, onNavigateToProfile, onNavigateToNote, initialTopic, topicNavKey }) => {
  const [query, setQuery] = useState('');
  const [searchedQuery, setSearchedQuery] = useState('');
  const [activeTab, setActiveTab] = useState<TabKey>('feeds');
  const [loadingTab, setLoadingTab] = useState<TabKey | null>(null);
  const [loadedKeys, setLoadedKeys] = useState<Set<string>>(new Set());

  const [feedResults, setFeedResults] = useState<NostrEventSigned[]>([]);
  const [peopleResults, setPeopleResults] = useState<UserProfile[]>([]);
  const [mediaResults, setMediaResults] = useState<NostrEventSigned[]>([]);
  const [zapResults, setZapResults] = useState<ZappedNote[]>([]);
  const [topicResults, setTopicResults] = useState<NostrEventSigned[]>([]);
  const [customFeeds, setCustomFeeds] = useState<string[]>(() => loadCustomFeeds());

  // As-you-type suggestions dropdown
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>(() => loadRecentSearches());
  const [suggestedPeople, setSuggestedPeople] = useState<UserProfile[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const suggestionRequestId = useRef(0);

  // Close the dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Debounced people suggestions while typing: instant from local cache,
  // then refined by a single relay query once typing pauses
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setSuggestedPeople([]);
      return;
    }

    const queryLower = trimmed.toLowerCase();
    const fromCache = EventCache.getAllProfiles()
      .filter(p => [p.name, p.display_name, p.nip05].filter(Boolean).join(' ').toLowerCase().includes(queryLower))
      .slice(0, 5);
    setSuggestedPeople(fromCache);

    const requestId = ++suggestionRequestId.current;
    const timer = setTimeout(async () => {
      try {
        const results = await NostrCore.searchProfiles(trimmed, 5);
        if (suggestionRequestId.current === requestId) {
          setSuggestedPeople(results);
        }
      } catch (error) {
        console.error('Failed to load search suggestions:', error);
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [query]);

  const fetchTab = async (tab: TabKey, q: string) => {
    const key = `${tab}:${q}`;
    if (loadedKeys.has(key)) return;

    setLoadingTab(tab);
    try {
      if (tab === 'feeds') {
        setFeedResults(await NostrCore.searchEvents(q, 100));
      } else if (tab === 'people') {
        setPeopleResults(await NostrCore.searchProfiles(q, 30));
      } else if (tab === 'media') {
        const notes = await NostrCore.searchEvents(q, 200);
        setMediaResults(notes.filter(n => hasMedia(n.content)).slice(0, 60));
      } else if (tab === 'zaps') {
        const notes = await NostrCore.searchEvents(q, 60);
        const totals = await NostrCore.fetchZapTotals(notes.map(n => n.id));
        const zapped = notes
          .map(n => ({ ...n, zapSats: totals.get(n.id) || 0 }))
          .filter(n => n.zapSats > 0)
          .sort((a, b) => b.zapSats - a.zapSats);
        setZapResults(zapped);
      } else if (tab === 'topics') {
        const tag = q.replace(/^#/, '').toLowerCase();
        setTopicResults(await NostrCore.fetchEventsByTag(tag, 100));
      }
      setLoadedKeys(prev => new Set(prev).add(key));
    } catch (error) {
      console.error(`Failed to search ${tab}:`, error);
    } finally {
      setLoadingTab(null);
    }
  };

  const performSearch = async (term: string, tab: TabKey) => {
    const trimmed = term.trim();
    if (!trimmed) return;

    setShowSuggestions(false);
    setActiveTab(tab);

    if (trimmed !== searchedQuery) {
      // New query — old tab results are stale, drop them
      setLoadedKeys(new Set());
      setFeedResults([]);
      setPeopleResults([]);
      setMediaResults([]);
      setZapResults([]);
      setTopicResults([]);
      setSearchedQuery(trimmed);
    }

    setQuery(trimmed);
    setRecentSearches(saveRecentSearch(trimmed));
    await fetchTab(tab, trimmed);
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    // A pasted npub/nprofile/hex key can only mean one thing — go straight
    // to People rather than searching whichever tab happened to be open
    const tab = NostrCore.pubkeyFromIdentifier(query) ? 'people' : activeTab;
    performSearch(query, tab);
  };

  // A #hashtag or the topic search input elsewhere in the app requested
  // this specific topic — jump straight to the Topics tab for it. Landing
  // here straight from a refresh, wait for relays to (re)connect first —
  // searching too early would find nothing and mark the topic as "loaded"
  // with an empty result, blocking any later retry.
  useEffect(() => {
    if (initialTopic && relaysConnected) {
      performSearch(initialTopic, 'topics');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicNavKey, relaysConnected]);

  const handleTabClick = (tab: TabKey) => {
    setActiveTab(tab);
    if (searchedQuery) {
      fetchTab(tab, searchedQuery);
    }
  };

  const selectPersonSuggestion = (profile: UserProfile) => {
    setShowSuggestions(false);
    setRecentSearches(saveRecentSearch(query.trim() || profile.name || ''));
    onNavigateToProfile(profile.pubkey);
  };

  const selectTopicSuggestion = (topic: string) => {
    performSearch(topic, 'topics');
  };

  const currentTopicTag = searchedQuery.replace(/^#/, '').toLowerCase();
  const isTopicSaved = customFeeds.includes(currentTopicTag);

  const handleAddTopicFeed = () => {
    setCustomFeeds(addCustomFeed(currentTopicTag));
  };

  const selectRecentSearch = (term: string) => {
    performSearch(term, 'feeds');
  };

  const formatSats = (sats: number): string => {
    if (sats >= 1_000_000) return `${(sats / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    if (sats >= 1_000) return `${(sats / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
    return String(sats);
  };

  const isLoading = loadingTab === activeTab;
  const hasSearched = !!searchedQuery;
  const currentCount =
    activeTab === 'feeds' ? feedResults.length :
    activeTab === 'people' ? peopleResults.length :
    activeTab === 'media' ? mediaResults.length :
    activeTab === 'zaps' ? zapResults.length :
    topicResults.length;

  return (
    <div className="search-page">
      <div className="search-container">
        <form className="search-form" onSubmit={handleSearch}>
          <div className="search-header">
            <h1>Search NOSTR</h1>
          </div>

          <div className="search-input-wrapper" ref={containerRef}>
            <div className="search-input-group">
              <input
                type="text"
                className="search-input"
                placeholder="Search feeds, people, media, zaps, topics..."
                value={query}
                onChange={(e) => { setQuery(e.target.value); setShowSuggestions(true); }}
                onFocus={() => setShowSuggestions(true)}
                autoComplete="off"
              />
              <button
                type="submit"
                className="btn btn-primary"
                disabled={!query.trim() || isLoading}
              >
                {isLoading ? '⟳ Searching...' : 'Search'}
              </button>
            </div>

            {showSuggestions && (query.trim().length > 0 || recentSearches.length > 0) && (
              <div className="search-suggestions">
                {query.trim().length === 0 && recentSearches.length > 0 && (
                  <div className="suggestions-section">
                    <div className="suggestions-section-label">Recent</div>
                    {recentSearches.map(term => (
                      <button
                        key={term}
                        type="button"
                        className="suggestion-item"
                        onClick={() => selectRecentSearch(term)}
                      >
                        <span className="suggestion-icon">🕘</span>
                        <span>{term}</span>
                      </button>
                    ))}
                  </div>
                )}

                {query.trim().length > 0 && suggestedPeople.length > 0 && (
                  <div className="suggestions-section">
                    <div className="suggestions-section-label">People</div>
                    {suggestedPeople.map(profile => (
                      <button
                        key={profile.pubkey}
                        type="button"
                        className="suggestion-item"
                        onClick={() => selectPersonSuggestion(profile)}
                      >
                        {profile.picture ? (
                          <img src={profile.picture} alt="" className="suggestion-avatar"  loading="lazy" decoding="async" />
                        ) : (
                          <span className="suggestion-avatar-placeholder">
                            {(profile.display_name || profile.name || '?').charAt(0).toUpperCase()}
                          </span>
                        )}
                        <span>{profile.display_name || profile.name || formatAddress(profile.pubkey)}</span>
                      </button>
                    ))}
                  </div>
                )}

                {query.trim().length > 0 && !query.trim().includes(' ') && (
                  <div className="suggestions-section">
                    <div className="suggestions-section-label">Topic</div>
                    <button
                      type="button"
                      className="suggestion-item"
                      onClick={() => selectTopicSuggestion(query.trim())}
                    >
                      <span className="suggestion-icon">#</span>
                      <span>{query.trim().replace(/^#/, '')}</span>
                    </button>
                  </div>
                )}

                {query.trim().length > 0 && (
                  <button
                    type="button"
                    className="suggestion-item suggestion-item-search"
                    onClick={() => performSearch(query, 'feeds')}
                  >
                    <span className="suggestion-icon">🔍</span>
                    <span>Search for "{query.trim()}"</span>
                  </button>
                )}
              </div>
            )}
          </div>
        </form>

        <div className="search-tabs">
          {TABS.map(tab => (
            <button
              key={tab.key}
              className={`search-tab ${activeTab === tab.key ? 'active' : ''}`}
              onClick={() => handleTabClick(tab.key)}
            >
              <span>{tab.icon}</span> {tab.label}
            </button>
          ))}
        </div>

        <div className="search-results">
          {!hasSearched && (
            <div className="empty-state">
              <p>
                {activeTab === 'topics'
                  ? 'Enter a hashtag to browse a topic'
                  : 'Enter a search query to get started'}
              </p>
            </div>
          )}

          {hasSearched && isLoading && (
            <div className="loading">Searching {TABS.find(t => t.key === activeTab)?.label.toLowerCase()}...</div>
          )}

          {hasSearched && !isLoading && (
            <div className="results-info">
              <h2>{currentCount} result{currentCount === 1 ? '' : 's'} for "{searchedQuery}"</h2>
              {activeTab === 'topics' && (
                <button
                  type="button"
                  className={`btn btn-small ${isTopicSaved ? 'btn-outline' : 'btn-primary'}`}
                  onClick={handleAddTopicFeed}
                  disabled={isTopicSaved}
                >
                  {isTopicSaved ? '✓ Feed added' : '+ Add Feed'}
                </button>
              )}
            </div>
          )}

          {hasSearched && !isLoading && activeTab === 'feeds' && (
            feedResults.length === 0 ? (
              <div className="empty-state"><p>No notes found for "{searchedQuery}"</p></div>
            ) : (
              <div className="events-list">
                {feedResults.map(event => (
                  <EventCard
                    key={event.id}
                    event={event}
                    onNavigateToProfile={onNavigateToProfile}
                    onNavigateToNote={onNavigateToNote}
                    onNavigateToTopic={selectTopicSuggestion}
                  />
                ))}
              </div>
            )
          )}

          {hasSearched && !isLoading && activeTab === 'people' && (
            peopleResults.length === 0 ? (
              <div className="empty-state"><p>No people found for "{searchedQuery}"</p></div>
            ) : (
              <div className="people-results">
                {peopleResults.map(profile => (
                  <button
                    key={profile.pubkey}
                    className="person-card"
                    onClick={() => onNavigateToProfile(profile.pubkey)}
                  >
                    {profile.picture ? (
                      <img src={profile.picture} alt="" className="person-avatar"  loading="lazy" decoding="async" />
                    ) : (
                      <div className="person-avatar-placeholder">
                        {(profile.display_name || profile.name || '?').charAt(0).toUpperCase()}
                      </div>
                    )}
                    <div className="person-info">
                      <div className="person-name">
                        {profile.display_name || profile.name || formatAddress(profile.pubkey)}
                      </div>
                      <div className="person-handle">{profile.nip05 || formatAddress(profile.pubkey)}</div>
                      {profile.about && <div className="person-bio">{profile.about}</div>}
                    </div>
                  </button>
                ))}
              </div>
            )
          )}

          {hasSearched && !isLoading && activeTab === 'media' && (
            mediaResults.length === 0 ? (
              <div className="empty-state"><p>No media posts found for "{searchedQuery}"</p></div>
            ) : (
              <div className="events-list">
                {mediaResults.map(event => (
                  <EventCard
                    key={event.id}
                    event={event}
                    onNavigateToProfile={onNavigateToProfile}
                    onNavigateToNote={onNavigateToNote}
                    onNavigateToTopic={selectTopicSuggestion}
                  />
                ))}
              </div>
            )
          )}

          {hasSearched && !isLoading && activeTab === 'zaps' && (
            zapResults.length === 0 ? (
              <div className="empty-state"><p>No zapped posts found for "{searchedQuery}"</p></div>
            ) : (
              <div className="events-list">
                {zapResults.map(event => (
                  <div key={event.id} className="zap-result-item">
                    <div className="zap-result-amount">⚡ {formatSats(event.zapSats)} sats</div>
                    <EventCard
                      event={event}
                      onNavigateToProfile={onNavigateToProfile}
                      onNavigateToNote={onNavigateToNote}
                      onNavigateToTopic={selectTopicSuggestion}
                    />
                  </div>
                ))}
              </div>
            )
          )}

          {hasSearched && !isLoading && activeTab === 'topics' && (
            topicResults.length === 0 ? (
              <div className="empty-state"><p>No posts found for #{searchedQuery.replace(/^#/, '')}</p></div>
            ) : (
              <div className="events-list">
                {topicResults.map(event => (
                  <EventCard
                    key={event.id}
                    event={event}
                    onNavigateToProfile={onNavigateToProfile}
                    onNavigateToNote={onNavigateToNote}
                    onNavigateToTopic={selectTopicSuggestion}
                  />
                ))}
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
};

export default SearchPage;
