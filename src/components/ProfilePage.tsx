import React, { useState, useEffect } from 'react';
import { UserProfile, NostrEventSigned } from '../types';
import { NostrCore, EventCache, PersistentCache, ZapActivity } from '../nostr/core';
import { NostrCrypto } from '../nostr/crypto';
import { formatAddress, formatDate, copyToClipboard } from '../utils/helpers';
import { extractImageUrls, extractVideoUrls, extractYouTubeIds } from '../utils/media';
import EventCard from './EventCard';
import QuotedNoteCard from './QuotedNoteCard';
import EditProfileForm from './EditProfileForm';
import ZapButton from './ZapButton';
import { ZapIcon, MessageIcon, CopyIcon, CheckIcon } from './Icons';

interface MediaThumbnail {
  noteId: string;
  type: 'image' | 'video' | 'youtube';
  url: string;
}

const firstMediaThumbnail = (note: NostrEventSigned): MediaThumbnail | null => {
  const images = extractImageUrls(note.content);
  if (images.length > 0) return { noteId: note.id, type: 'image', url: images[0] };
  const youtubeIds = extractYouTubeIds(note.content);
  if (youtubeIds.length > 0) {
    return { noteId: note.id, type: 'youtube', url: `https://img.youtube.com/vi/${youtubeIds[0]}/hqdefault.jpg` };
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
  const [contentTab, setContentTab] = useState<'posts' | 'replies' | 'media' | 'zaps'>('posts');
  const [isFollowing, setIsFollowing] = useState<boolean | null>(null);
  const [followLoading, setFollowLoading] = useState(false);
  const [npubCopied, setNpubCopied] = useState(false);
  const [followingCount, setFollowingCount] = useState<number | null>(null);
  const [followersCount, setFollowersCount] = useState<number | null>(null);
  const [joinedDate, setJoinedDate] = useState<string | null>(null);
  const [zapActivity, setZapActivity] = useState<ZapActivity[]>([]);
  const [zapActivityLoaded, setZapActivityLoaded] = useState(false);
  const [zapProfiles, setZapProfiles] = useState<Record<string, UserProfile>>({});
  const [zapNotes, setZapNotes] = useState<Record<string, NostrEventSigned>>({});

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
      if (!cancelled) setFollowingCount(list.length);
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
    setFollowingCount(null);
    setFollowersCount(null);
    setJoinedDate(null);
  }, [pubkey]);

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
                {followingCount !== null && (
                  <div className="stat">
                    <span className="stat-value">{followingCount}</span>
                    <span className="stat-label">Following</span>
                  </div>
                )}
                {followersCount !== null && (
                  <div className="stat">
                    <span className="stat-value">{followersCount}</span>
                    <span className="stat-label">Followers</span>
                  </div>
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
            </div>

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
          </div>
        </div>
      </div>
    </div>
  );
};

export default ProfilePage;
