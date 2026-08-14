import React, { useState, useEffect, useRef } from 'react';
import { UserProfile, NostrEventSigned, NostrFilter, EVENT_KINDS } from '../types';
import { NostrCore, EventCache, PersistentCache, ZapActivity } from '../nostr/core';
import { NostrCrypto } from '../nostr/crypto';
import { formatAddress, formatDate, copyToClipboard } from '../utils/helpers';
import { extractImageUrls, extractVideoUrls, extractEmbeds } from '../utils/media';
import EventCard from './EventCard';
import QuotedNoteCard from './QuotedNoteCard';
import EditProfileForm from './EditProfileForm';
import ZapButton from './ZapButton';
import { ZapIcon, MessageIcon, CopyIcon, CheckIcon } from './Icons';

interface MediaThumbnail {
  noteId: string;
  type: 'image' | 'video' | 'embed';
  url: string;
}

const firstMediaThumbnail = (note: NostrEventSigned): MediaThumbnail | null => {
  const images = extractImageUrls(note.content);
  if (images.length > 0) return { noteId: note.id, type: 'image', url: images[0] };
  // Only players that expose a poster from the URL alone can fill a grid
  // cell — an audio widget has nothing to show here
  const withThumbnail = extractEmbeds(note.content).find(embed => embed.thumbnail);
  if (withThumbnail) {
    return { noteId: note.id, type: 'embed', url: withThumbnail.thumbnail! };
  }
  const videos = extractVideoUrls(note.content);
  if (videos.length > 0) return { noteId: note.id, type: 'video', url: videos[0] };
  return null;
};

const formatSats = (sats: number): string => {
  if (sats >= 1_000_000) return `${(sats / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (sats >= 1_000) return `${(sats / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(sats);
};

interface ProfilePageProps {
  pubkey: string;
  isOwnProfile: boolean;
  relaysConnected: boolean;
  onNavigateToProfile: (pubkey: string) => void;
  onNavigateToNote?: (noteId: string) => void;
  onNavigateToTopic?: (topic: string) => void;
  onNavigateToMessages?: (pubkey: string) => void;
}

const ProfilePage: React.FC<ProfilePageProps> = ({
  pubkey,
  isOwnProfile,
  relaysConnected,
  onNavigateToProfile,
  onNavigateToNote,
  onNavigateToTopic,
  onNavigateToMessages
}) => {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [notes, setNotes] = useState<NostrEventSigned[]>([]);
  const [reposts, setReposts] = useState<{ repost: NostrEventSigned; original: NostrEventSigned }[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [contentTab, setContentTab] = useState<'posts' | 'replies' | 'media' | 'zaps' | 'following' | 'followers'>('posts');
  const [isFollowing, setIsFollowing] = useState<boolean | null>(null);
  const [followLoading, setFollowLoading] = useState(false);
  const [isBlocked, setIsBlocked] = useState(() => NostrCore.isBlocked(pubkey));
  const [blockLoading, setBlockLoading] = useState(false);
  const [npubCopied, setNpubCopied] = useState(false);
  // The following list doubles as the count in the header, so the Following
  // tab needs no second lookup. Followers are only fetched when that tab is
  // opened — it's a scan across every contact list the relays have indexed
  const [followingList, setFollowingList] = useState<string[] | null>(null);
  const [followersCount, setFollowersCount] = useState<number | null>(null);
  const [followersList, setFollowersList] = useState<string[] | null>(null);
  const [followersCapped, setFollowersCapped] = useState(false);
  const [peopleProfiles, setPeopleProfiles] = useState<Map<string, UserProfile>>(new Map());
  const [joinedDate, setJoinedDate] = useState<string | null>(null);
  const [zapActivity, setZapActivity] = useState<ZapActivity[]>([]);
  const [zapActivityLoaded, setZapActivityLoaded] = useState(false);
  const [zapProfiles, setZapProfiles] = useState<Record<string, UserProfile>>({});
  const [zapNotes, setZapNotes] = useState<Record<string, NostrEventSigned>>({});
  // New notes from this profile found by the live subscription below —
  // shown behind a "N new posts" button instead of jumping into the list
  const [pendingNotes, setPendingNotes] = useState<NostrEventSigned[]>([]);
  const notesRef = useRef<NostrEventSigned[]>([]);
  const pendingNotesRef = useRef<NostrEventSigned[]>([]);
  notesRef.current = notes;
  pendingNotesRef.current = pendingNotes;

  useEffect(() => {
    // Stale-while-revalidate: show cached profile + notes instantly,
    // then refresh from relays in the background once they're connected
    const cachedProfile = EventCache.getProfile(pubkey);
    const cachedNotes = PersistentCache.get<NostrEventSigned[]>(`notes_${pubkey}`);
    const cachedReposts = PersistentCache.get<{ repost: NostrEventSigned; original: NostrEventSigned }[]>(`reposts_${pubkey}`);
    const hasCache = !!cachedProfile || !!(cachedNotes && cachedNotes.length > 0);

    if (hasCache) {
      setProfile(cachedProfile || { pubkey });
      setNotes(cachedNotes || []);
      setReposts(cachedReposts || []);
      setLoading(false);
    } else {
      setLoading(true);
    }

    if (relaysConnected) {
      loadProfileData(hasCache);
    }
  }, [pubkey, relaysConnected]);

  const loadProfileData = async (background: boolean = false) => {
    if (!background) setLoading(true);
    try {
      const [userProfile, userNotes, userReposts] = await Promise.all([
        NostrCore.fetchUserProfile(pubkey),
        NostrCore.fetchUserNotes(pubkey, 50),
        NostrCore.fetchReposts([pubkey], 50)
      ]);

      // On background refresh keep showing cached data if relays return nothing
      if (userProfile) {
        setProfile(userProfile);
      } else if (!background) {
        setProfile({ pubkey });
      }
      if (userNotes.length > 0 || !background) {
        setNotes(userNotes);
        PersistentCache.set(`notes_${pubkey}`, userNotes.slice(0, 30));
        // The live subscription below can flag a note as "new" while this
        // fetch was still in flight and it already picked the same note up
        // — don't double-count/re-show it as pending
        setPendingNotes(prev => {
          const freshIds = new Set(userNotes.map(e => e.id));
          return prev.filter(e => !freshIds.has(e.id));
        });
      }
      if (userReposts.length > 0 || !background) {
        setReposts(userReposts);
        PersistentCache.set(`reposts_${pubkey}`, userReposts.slice(0, 30));
      }
    } catch (error) {
      console.error('Failed to load profile:', error);
      if (!background) setProfile({ pubkey });
    } finally {
      setLoading(false);
    }
  };

  const handleProfileUpdated = (updatedProfile: Partial<UserProfile>) => {
    setProfile(prev => prev ? { ...prev, ...updatedProfile } : updatedProfile as UserProfile);
    setEditing(false);
  };

  // Live feed for this profile's own notes — same reasoning as the home
  // feed's live subscription: a REQ with `since` keeps streaming new
  // matches as they're published, so new posts show up without polling
  useEffect(() => {
    if (!relaysConnected) return;

    const buildFilters = (since: number): NostrFilter[] => [
      { kinds: [EVENT_KINDS.TEXT_NOTE, EVENT_KINDS.POLL], authors: [pubkey], since }
    ];

    const handleEvent = (event: NostrEventSigned) => {
      const maxTimestamp = Math.floor(Date.now() / 1000) + 300; // 5 min clock-skew tolerance
      if ((event.created_at || 0) > maxTimestamp) return;

      // Don't trust the relay to have actually honored the authors filter
      // below — a relay that ignores/mishandles it would otherwise flood
      // this profile's feed with posts from accounts having nothing to do
      // with it (mirrors the same guard the home feed's live sub has)
      if (event.pubkey !== pubkey) return;

      const shown = [...pendingNotesRef.current, ...notesRef.current];
      if (shown.some(e => e.id === event.id)) return;

      setPendingNotes(prev => {
        if (prev.some(e => e.id === event.id)) return prev;
        // Re-check against notes too — loadProfileData's own refresh can
        // land between the check above and this callback running
        if (notesRef.current.some(e => e.id === event.id)) return prev;
        const merged = [event, ...prev];
        merged.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
        return merged.slice(0, 50);
      });
    };

    let subId: string | null = null;
    let cancelled = false;
    const resubscribe = () => {
      if (subId) NostrCore.unsubscribeLive(subId);
      const shown = [...pendingNotesRef.current, ...notesRef.current];
      // Clamp to now — a single future-dated note would otherwise push the
      // cursor into the future and the subscription would replay nothing
      const cursor = shown.length > 0
        ? Math.min(Math.max(...shown.map(e => e.created_at || 0)) + 1, Math.floor(Date.now() / 1000))
        : Math.floor(Date.now() / 1000);
      subId = NostrCore.subscribeLive(buildFilters(cursor), handleEvent);
    };

    resubscribe();

    // A backgrounded tab's socket can die silently — wait for the relay
    // reconnect to actually finish before resubscribing on tab focus
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      NostrCore.refreshRelayConnections().then(() => {
        if (!cancelled) resubscribe();
      });
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (subId) NostrCore.unsubscribeLive(subId);
    };
  }, [pubkey, relaysConnected]);

  const showPendingNotes = () => {
    const pending = pendingNotesRef.current;
    if (pending.length === 0) return;
    setNotes(prev => {
      const ids = new Set(pending.map(e => e.id));
      const merged = [...pending, ...prev.filter(e => !ids.has(e.id))];
      PersistentCache.set(`notes_${pubkey}`, merged.slice(0, 30));
      return merged;
    });
    setPendingNotes([]);
    document.querySelector('.app-main')?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  useEffect(() => {
    if (isOwnProfile || !relaysConnected) return;
    let cancelled = false;
    NostrCore.isFollowing(pubkey).then(result => {
      if (!cancelled) setIsFollowing(result);
    });
    return () => { cancelled = true; };
  }, [pubkey, isOwnProfile, relaysConnected]);

  // Following/followers/join-date are fetched once per profile view — not
  // tied to loadProfileData, so reactions/reposts elsewhere don't re-trigger them
  useEffect(() => {
    if (!relaysConnected) return;
    let cancelled = false;

    NostrCore.fetchFollowingList(pubkey).then(list => {
      if (!cancelled) setFollowingList(list);
    });
    NostrCore.fetchFollowersCount(pubkey).then(({ count }) => {
      if (!cancelled) setFollowersCount(count);
    });
    NostrCore.fetchAccountCreatedAt(pubkey).then(timestamp => {
      if (!cancelled && timestamp) {
        setJoinedDate(new Date(timestamp * 1000).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }));
      }
    });

    return () => { cancelled = true; };
  }, [pubkey, relaysConnected]);

  // Zap activity (sent + received) is only worth fetching once the Zaps
  // tab is actually opened
  useEffect(() => {
    if (contentTab !== 'zaps' || zapActivityLoaded || !relaysConnected) return;
    let cancelled = false;
    NostrCore.fetchZapActivity(pubkey).then(async activity => {
      if (cancelled) return;
      setZapActivity(activity);
      setZapActivityLoaded(true);

      const counterpartyProfiles = await NostrCore.fetchProfiles(activity.map(z => z.counterpartyPubkey));
      if (!cancelled) setZapProfiles(prev => ({ ...prev, ...Object.fromEntries(counterpartyProfiles) }));

      const noteIds = activity.map(z => z.noteId).filter((id): id is string => !!id);
      if (noteIds.length > 0) {
        const notesById = await NostrCore.fetchEventsByIds(noteIds);
        if (!cancelled) setZapNotes(prev => ({ ...prev, ...Object.fromEntries(notesById) }));
      }
    });
    return () => { cancelled = true; };
  }, [contentTab, zapActivityLoaded, relaysConnected, pubkey]);

  // Reset per-profile caches when switching to a different profile
  useEffect(() => {
    setZapActivity([]);
    setZapActivityLoaded(false);
    setZapProfiles({});
    setZapNotes({});
    setFollowingList(null);
    setFollowersCount(null);
    setFollowersList(null);
    setFollowersCapped(false);
    setPeopleProfiles(new Map());
    setJoinedDate(null);
    setIsBlocked(NostrCore.isBlocked(pubkey));
  }, [pubkey]);

  // Followers are only worth the relay scan once that tab is opened.
  // Profiles for both lists are fetched here too, so the cards show names
  // and avatars instead of a column of truncated keys.
  useEffect(() => {
    if (contentTab !== 'following' && contentTab !== 'followers') return;
    if (!relaysConnected) return;
    let cancelled = false;

    const loadNames = async (pubkeys: string[]) => {
      if (pubkeys.length === 0) return;
      const profiles = await NostrCore.fetchProfiles(pubkeys);
      if (!cancelled) {
        setPeopleProfiles(prev => new Map([...prev, ...profiles]));
      }
    };

    if (contentTab === 'following') {
      if (followingList) loadNames(followingList);
    } else if (followersList === null) {
      NostrCore.fetchFollowers(pubkey).then(({ pubkeys, capped }) => {
        if (cancelled) return;
        setFollowersList(pubkeys);
        setFollowersCapped(capped);
        // Both this and the header count are samples of whatever relays
        // answered in time, so two separate queries disagree. Once we have
        // names on screen, that list is the number to show.
        setFollowersCount(pubkeys.length);
        loadNames(pubkeys);
      });
    } else {
      loadNames(followersList);
    }

    return () => { cancelled = true; };
  }, [contentTab, relaysConnected, pubkey, followingList, followersList]);

  const handleFollowToggle = async () => {
    if (followLoading || isFollowing === null) return;
    setFollowLoading(true);
    try {
      if (isFollowing) {
        await NostrCore.unfollowUser(pubkey);
        setIsFollowing(false);
      } else {
        await NostrCore.followUser(pubkey);
        setIsFollowing(true);
      }
    } catch (error) {
      console.error('Failed to update follow list:', error);
      alert(error instanceof Error ? error.message : 'Failed to update follow list');
    } finally {
      setFollowLoading(false);
    }
  };

  const handleBlockToggle = async () => {
    if (blockLoading) return;
    const name = profile?.display_name || profile?.name || formatAddress(pubkey);
    if (!isBlocked && !window.confirm(`Block ${name}? Their posts disappear from your feeds.`)) return;
    setBlockLoading(true);
    try {
      if (isBlocked) {
        await NostrCore.unblockUser(pubkey);
        setIsBlocked(false);
      } else {
        await NostrCore.blockUser(pubkey);
        setIsBlocked(true);
      }
    } catch (error) {
      console.error('Failed to update block list:', error);
      alert(error instanceof Error ? error.message : 'Failed to update block list');
    } finally {
      setBlockLoading(false);
    }
  };

  const handleCopyNpub = async () => {
    const ok = await copyToClipboard(npubHandle);
    if (ok) {
      setNpubCopied(true);
      setTimeout(() => setNpubCopied(false), 1500);
    }
  };

  if (loading) {
    return <div className="profile-page"><div className="loading">{!relaysConnected ? 'Connecting to relays...' : 'Loading profile...'}</div></div>;
  }

  if (!profile) {
    return <div className="profile-page"><div className="error">Profile not found</div></div>;
  }

  // A kind-1 note referencing another event is a reply
  const isReply = (e: NostrEventSigned) => e.tags.some(t => t[0] === 'e');
  const visibleNotes = notes.filter(e => (contentTab === 'replies' ? isReply(e) : !isReply(e)));
  const visiblePendingNotes = pendingNotes.filter(e => (contentTab === 'replies' ? isReply(e) : !isReply(e)));

  // Posts tab interleaves this user's own notes with what they've
  // reposted, X-style, sorted newest first by whichever action is newer
  type TimelineItem =
    | { type: 'note'; key: string; createdAt: number; event: NostrEventSigned }
    | { type: 'repost'; key: string; createdAt: number; repost: NostrEventSigned; original: NostrEventSigned };

  const timelineItems: TimelineItem[] = contentTab === 'replies'
    ? visibleNotes.map(event => ({ type: 'note', key: event.id, createdAt: event.created_at || 0, event }))
    : [
        ...visibleNotes.map(event => ({ type: 'note' as const, key: event.id, createdAt: event.created_at || 0, event })),
        ...reposts.map(({ repost, original }) => ({
          type: 'repost' as const,
          key: repost.id,
          createdAt: repost.created_at || 0,
          repost,
          original
        }))
      ].sort((a, b) => b.createdAt - a.createdAt);

  const mediaThumbnails = notes
    .map(firstMediaThumbnail)
    .filter((thumb): thumb is MediaThumbnail => thumb !== null);

  const displayName = profile.display_name || profile.name || formatAddress(pubkey);
  const coverImage = profile.banner || 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
  const npubHandle = NostrCrypto.npubEncode(pubkey) || pubkey;

  return (
    <div className="profile-page">
      <div className="profile-container">
        <div 
          className="profile-banner"
          style={profile.banner ? { backgroundImage: `url(${profile.banner})` } : { background: coverImage }}
        />

        <div className="profile-content">
          <div className="profile-header">
            <div className="profile-header-top">
              {profile.picture ? (
                <img
                  src={profile.picture}
                  alt={displayName}
                  className="profile-avatar-large"
                />
              ) : (
                <div className="profile-avatar-large-placeholder">
                  {displayName.charAt(0).toUpperCase()}
                </div>
              )}

              {isOwnProfile && (
                <button
                  className="btn btn-primary btn-small"
                  onClick={() => setEditing(!editing)}
                >
                  {editing ? 'Cancel' : 'Edit Profile'}
                </button>
              )}
              {!isOwnProfile && (
                <div className="profile-header-actions">
                  {isFollowing !== null && (
                    <button
                      className={`btn btn-small ${isFollowing ? 'btn-secondary' : 'btn-primary'}`}
                      onClick={handleFollowToggle}
                      disabled={followLoading}
                    >
                      {followLoading ? '...' : isFollowing ? 'Unfollow' : 'Follow'}
                    </button>
                  )}
                  <button
                    className={`btn btn-small ${isBlocked ? 'btn-secondary' : 'btn-danger'}`}
                    onClick={handleBlockToggle}
                    disabled={blockLoading}
                  >
                    {blockLoading ? '...' : isBlocked ? 'Unblock' : 'Block'}
                  </button>
                  {profile.lud16 && (
                    <ZapButton lud16={profile.lud16} triggerClassName="btn btn-secondary btn-small btn-with-icon">
                      <ZapIcon /> Zap
                    </ZapButton>
                  )}
                  {onNavigateToMessages && (
                    <button
                      className="btn btn-secondary btn-small btn-with-icon"
                      onClick={() => onNavigateToMessages(pubkey)}
                    >
                      <MessageIcon /> Message
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="profile-info">
              <h1 className="profile-name">{displayName}</h1>
              {profile.nip05 && <p className="profile-nip05">{profile.nip05}</p>}
              <p className="profile-handle">
                {formatAddress(npubHandle)}
                <button
                  type="button"
                  className="copy-npub-btn"
                  onClick={handleCopyNpub}
                  title="Copy npub"
                >
                  {npubCopied ? <CheckIcon /> : <CopyIcon />}
                </button>
              </p>
              {profile.about && (
                <p className="profile-bio">{profile.about}</p>
              )}
              {profile.website && (
                <a href={profile.website} target="_blank" rel="noopener noreferrer" className="profile-website">
                  🔗 {new URL(profile.website).hostname}
                </a>
              )}
              {profile.lud16 && (
                <span className="profile-lightning">⚡ {profile.lud16}</span>
              )}
              <div className="profile-stats">
                <div className="stat">
                  <span className="stat-value">{notes.length}</span>
                  <span className="stat-label">Notes</span>
                </div>
                {followingList !== null && (
                  <button
                    type="button"
                    className="stat stat-clickable"
                    onClick={() => setContentTab('following')}
                  >
                    <span className="stat-value">{followingList.length}</span>
                    <span className="stat-label">Following</span>
                  </button>
                )}
                {followersCount !== null && (
                  <button
                    type="button"
                    className="stat stat-clickable"
                    onClick={() => setContentTab('followers')}
                  >
                    <span className="stat-value">{followersCount}</span>
                    <span className="stat-label">Followers</span>
                  </button>
                )}
              </div>
              {joinedDate && <p className="profile-joined">📅 Joined {joinedDate}</p>}
            </div>
          </div>

          {editing && isOwnProfile && (
            <EditProfileForm 
              profile={profile}
              onSave={handleProfileUpdated}
            />
          )}

          <div className="profile-notes">
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
              <button
                className={`feed-tab ${contentTab === 'media' ? 'active' : ''}`}
                onClick={() => setContentTab('media')}
              >
                Media
              </button>
              <button
                className={`feed-tab ${contentTab === 'zaps' ? 'active' : ''}`}
                onClick={() => setContentTab('zaps')}
              >
                Zaps
              </button>
              <button
                className={`feed-tab ${contentTab === 'following' ? 'active' : ''}`}
                onClick={() => setContentTab('following')}
              >
                Following
              </button>
              <button
                className={`feed-tab ${contentTab === 'followers' ? 'active' : ''}`}
                onClick={() => setContentTab('followers')}
              >
                Followers
              </button>
            </div>

            {(contentTab === 'posts' || contentTab === 'replies') && visiblePendingNotes.length > 0 && (
              <button className="new-posts-btn" onClick={showPendingNotes}>
                ↑ Show {visiblePendingNotes.length} new {visiblePendingNotes.length === 1 ? 'post' : 'posts'}
              </button>
            )}

            {(contentTab === 'posts' || contentTab === 'replies') && (
              timelineItems.length === 0 ? (
                <div className="empty-state">
                  <p>{contentTab === 'replies' ? 'No replies yet' : 'No notes yet'}</p>
                </div>
              ) : (
                <div className="events-list">
                  {timelineItems.map((item) => item.type === 'repost' ? (
                    <div key={item.key} className="reposted-item">
                      <div className="reposted-label">
                        {profile.picture && <img src={profile.picture} alt="" className="reposted-avatar" />}
                        {displayName} Reposted
                      </div>
                      <EventCard
                        event={item.original}
                        onNavigateToProfile={onNavigateToProfile}
                        onNavigateToNote={onNavigateToNote}
                        onNavigateToTopic={onNavigateToTopic}
                        onRefresh={loadProfileData}
                      />
                    </div>
                  ) : (
                    <EventCard
                      key={item.key}
                      event={item.event}
                      onNavigateToProfile={onNavigateToProfile}
                      onNavigateToNote={onNavigateToNote}
                      onNavigateToTopic={onNavigateToTopic}
                      onRefresh={loadProfileData}
                    />
                  ))}
                </div>
              )
            )}

            {contentTab === 'media' && (
              mediaThumbnails.length === 0 ? (
                <div className="empty-state">
                  <p>No media posts yet</p>
                </div>
              ) : (
                <div className="media-grid">
                  {mediaThumbnails.map(thumb => (
                    <button
                      key={thumb.noteId}
                      type="button"
                      className="media-grid-item"
                      onClick={() => onNavigateToNote?.(thumb.noteId)}
                    >
                      {thumb.type === 'video' ? (
                        <video src={thumb.url} muted playsInline />
                      ) : (
                        <img src={thumb.url} alt="" loading="lazy" />
                      )}
                      {thumb.type === 'video' && <span className="media-grid-play">▶</span>}
                    </button>
                  ))}
                </div>
              )
            )}

            {contentTab === 'zaps' && (
              zapActivity.length === 0 ? (
                <div className="empty-state">
                  <p>{zapActivityLoaded ? 'No zap activity yet' : 'Loading zaps...'}</p>
                </div>
              ) : (
                <div className="sent-zaps-list">
                  {zapActivity.map(zap => {
                    const counterpartyProfile = zapProfiles[zap.counterpartyPubkey];
                    const counterpartyName = counterpartyProfile?.display_name || counterpartyProfile?.name || formatAddress(zap.counterpartyPubkey);
                    const counterpartyHandle = counterpartyProfile?.nip05
                      || formatAddress(NostrCrypto.npubEncode(zap.counterpartyPubkey) || zap.counterpartyPubkey);
                    const zappedNote = zap.noteId ? zapNotes[zap.noteId] : undefined;
                    return (
                      <div key={zap.id} className="sent-zap-item">
                        <div className="sent-zap-header">
                          <span className={`zap-direction zap-direction-${zap.direction}`}>
                            {zap.direction === 'sent' ? 'Sent to' : 'Received from'}
                          </span>
                          <button
                            type="button"
                            className="sent-zap-recipient"
                            onClick={() => onNavigateToProfile(zap.counterpartyPubkey)}
                          >
                            {counterpartyProfile?.picture ? (
                              <img src={counterpartyProfile.picture} alt="" className="sent-zap-recipient-avatar" />
                            ) : (
                              <span className="sent-zap-recipient-avatar-placeholder">
                                {counterpartyName.charAt(0).toUpperCase()}
                              </span>
                            )}
                            <span className="sent-zap-recipient-info">
                              <span className="sent-zap-recipient-name">{counterpartyName}</span>
                              <span className="sent-zap-recipient-handle">{counterpartyHandle}</span>
                            </span>
                          </button>
                          <div className="sent-zap-meta">
                            <span className="sent-zap-amount">⚡ {formatSats(zap.sats)} sats</span>
                            <span className="sent-zap-time">{formatDate(new Date(zap.createdAt * 1000))}</span>
                          </div>
                        </div>
                        {zappedNote && (
                          <QuotedNoteCard
                            event={zappedNote}
                            onNavigateToProfile={onNavigateToProfile}
                            onNavigateToNote={onNavigateToNote}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )
            )}

            {(contentTab === 'following' || contentTab === 'followers') && (() => {
              const list = contentTab === 'following' ? followingList : followersList;

              if (list === null) {
                return (
                  <div className="empty-state">
                    <p>Loading {contentTab}...</p>
                  </div>
                );
              }
              if (list.length === 0) {
                return (
                  <div className="empty-state">
                    <p>
                      {contentTab === 'following'
                        ? 'Not following anyone yet'
                        : 'No followers found'}
                    </p>
                  </div>
                );
              }

              return (
                <>
                  <div className="people-results">
                    {list.map(personPubkey => {
                      const person = peopleProfiles.get(personPubkey);
                      const name = person?.display_name || person?.name || formatAddress(personPubkey);
                      const handle = person?.nip05
                        || formatAddress(NostrCrypto.npubEncode(personPubkey) || personPubkey);
                      return (
                        <button
                          key={personPubkey}
                          type="button"
                          className="person-card"
                          onClick={() => onNavigateToProfile(personPubkey)}
                        >
                          {person?.picture ? (
                            <img src={person.picture} alt="" className="person-avatar" />
                          ) : (
                            <div className="person-avatar-placeholder">{name.charAt(0).toUpperCase()}</div>
                          )}
                          <div className="person-info">
                            <div className="person-name">{name}</div>
                            <div className="person-handle">{handle}</div>
                            {person?.about && <div className="person-bio">{person.about}</div>}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                  {contentTab === 'followers' && followersCapped && (
                    <p className="profile-joined">
                      Showing the first {list.length} followers the connected relays have indexed — Nostr has no
                      authoritative follower list, so this is a sample, not a total.
                    </p>
                  )}
                </>
              );
            })()}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ProfilePage;
