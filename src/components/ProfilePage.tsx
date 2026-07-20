import React, { useState, useEffect } from 'react';
import { UserProfile, NostrEventSigned } from '../types';
import { NostrCore, EventCache, PersistentCache } from '../nostr/core';
import { NostrCrypto } from '../nostr/crypto';
import { formatAddress } from '../utils/helpers';
import EventCard from './EventCard';
import EditProfileForm from './EditProfileForm';
import ZapButton from './ZapButton';

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
  const [contentTab, setContentTab] = useState<'posts' | 'replies'>('posts');

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
        NostrCore.fetchUserReposts(pubkey, 50)
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

            <div className="profile-info">
              <h1 className="profile-name">{displayName}</h1>
              <p className="profile-handle">
                {profile.nip05 || formatAddress(npubHandle)}
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
              </div>
            </div>

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
                {profile.lud16 && (
                  <ZapButton lud16={profile.lud16} triggerClassName="btn btn-secondary btn-small">
                    ⚡ Zap
                  </ZapButton>
                )}
                {onNavigateToMessages && (
                  <button
                    className="btn btn-secondary btn-small"
                    onClick={() => onNavigateToMessages(pubkey)}
                  >
                    ✉️ Message
                  </button>
                )}
              </div>
            )}
          </div>

          {editing && isOwnProfile && (
            <EditProfileForm 
              profile={profile}
              onSave={handleProfileUpdated}
            />
          )}

          <div className="profile-notes">
            <h2>Notes ({notes.length})</h2>

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

            {timelineItems.length === 0 ? (
              <div className="empty-state">
                <p>{contentTab === 'replies' ? 'No replies yet' : 'No notes yet'}</p>
              </div>
            ) : (
              <div className="events-list">
                {timelineItems.map((item) => item.type === 'repost' ? (
                  <div key={item.key} className="reposted-item">
                    <div className="reposted-label">🔄 {displayName} Reposted</div>
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
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ProfilePage;
