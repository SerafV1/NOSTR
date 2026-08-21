import React, { useState, useEffect, useRef } from 'react';
import { NostrEventSigned, UserProfile } from '../types';
import { NostrCore, EventCache } from '../nostr/core';
import {
  NotificationCore,
  NotificationStore,
  NostrNotification,
  NotificationType,
  cacheNotifications,
  readCachedNotifications,
  cacheTargets,
  readCachedTargets,
  dropMuted
} from '../nostr/notifications';
import { formatDate, formatAddress } from '../utils/helpers';
import RichText from './RichText';
import { stripMediaUrls } from '../utils/media';

interface NotificationsPageProps {
  pubkey: string;
  relaysConnected: boolean;
  onNavigateToProfile: (pubkey: string) => void;
  onNavigateToNote: (noteId: string) => void;
  /** Live chat mentions belong to a stream, not to a note */
  onNavigateToStream?: (kind: number, pubkey: string, identifier: string) => void;
  onMarkRead?: () => void;
}

const TYPE_META: Record<NotificationType, { icon: string; verb: string }> = {
  reply: { icon: '💬', verb: 'replied to your note' },
  mention: { icon: '📣', verb: 'mentioned you' },
  reaction: { icon: '❤️', verb: 'reacted to your note' },
  repost: { icon: '🔄', verb: 'reposted your note' },
  zap: { icon: '⚡', verb: 'zapped you' },
  livechat: { icon: '📺', verb: 'tagged you in a stream chat' },
  follow: { icon: '👤', verb: 'started following you' },
  unfollow: { icon: '👋', verb: 'stopped following you' }
};

// NIP-25: reaction content is '+' or empty for a plain "like" (shown as a
// heart), '-' for a dislike, or any other string for a custom emoji
// reaction — that emoji should actually be shown, not always a heart
const reactionIcon = (content: string): string => {
  if (content === '' || content === '+') return '❤️';
  if (content === '-') return '👎';
  return content;
};

const NotificationsPage: React.FC<NotificationsPageProps> = ({
  pubkey,
  relaysConnected,
  onNavigateToProfile,
  onNavigateToNote,
  onNavigateToStream,
  onMarkRead
}) => {
  const [notifications, setNotifications] = useState<NostrNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [profiles, setProfiles] = useState<Record<string, UserProfile>>({});
  // Seeded so previews are on screen with the list, not a beat later
  const [targetNotes, setTargetNotes] = useState<Record<string, NostrEventSigned>>(
    () => readCachedTargets(pubkey)
  );
  // Captured once on mount so items stay highlighted as "new" for this
  // viewing even after the seen marker below advances past them
  const initialLastSeenRef = useRef(NotificationStore.getLastSeen(pubkey));

  const loadNotifications = async () => {
    const cached = readCachedNotifications(pubkey);
    if (cached.length > 0) {
      setNotifications(dropMuted(cached));
      setLoading(false);
    } else {
      setLoading(true);
    }

    try {
      // Unfollows are a separate question — no filter can ask a relay for
      // lists that no longer name you, so they are worked out by checking
      // the lists of everyone known to follow you
      const [fetched, unfollows] = await Promise.all([
        NotificationCore.fetchNotifications(pubkey, 100),
        NotificationCore.fetchUnfollows(pubkey)
      ]);
      fetched.push(...unfollows);

      // Merged, not replaced: a partial answer from the relays must not
      // take away notifications that were already on screen
      // Filtered on the way to the screen rather than out of the cache, so
      // unmuting brings someone's notifications back rather than losing them
      const shown = cacheNotifications(pubkey, fetched);
      setNotifications(dropMuted(shown));

      // Every name on the page, not only the ones this fetch returned. A
      // follow is announced once — by whichever poll saw it first, often the
      // background one — and never appears in a later fetch, so asking only
      // about `fetched` left those rows showing a shortened key and a blank
      // avatar until something else happened to load that profile.
      const actorProfiles = await NostrCore.fetchProfiles(shown.map(n => n.event.pubkey));
      setProfiles(prev => ({ ...prev, ...Object.fromEntries(actorProfiles) }));

      const targetIds = fetched
        .filter(n => n.type === 'reaction' || n.type === 'repost' || n.type === 'zap')
        .map(n => n.event.tags.find(t => t[0] === 'e')?.[1])
        .filter((id): id is string => !!id);
      if (targetIds.length > 0) {
        const targets = await NostrCore.fetchEventsByIds(targetIds);
        setTargetNotes(cacheTargets(pubkey, Object.fromEntries(targets)));
      }

    } catch (error) {
      console.error('Failed to load notifications:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (relaysConnected) {
      loadNotifications();
    } else {
      const cached = readCachedNotifications(pubkey);
      if (cached.length > 0) {
        setNotifications(cached);
        setLoading(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relaysConnected, pubkey]);

  // Refresh while the page stays open so new notifications show up without
  // a manual reload
  useEffect(() => {
    if (!relaysConnected) return;
    const interval = setInterval(loadNotifications, 30000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relaysConnected, pubkey]);

  // Advance the "seen" marker once notifications are loaded, clearing the
  // header badge while initialLastSeenRef keeps this view's items highlighted
  useEffect(() => {
    if (notifications.length === 0) return;
    const newest = Math.max(...notifications.map(n => n.event.created_at || 0));
    NotificationStore.setLastSeen(pubkey, newest);
    NotificationStore.markSeen(pubkey, notifications.map(n => n.id));
    onMarkRead?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notifications, pubkey]);

  const handleClick = (notification: NostrNotification) => {
    if (notification.type === 'follow' || notification.type === 'unfollow') {
      onNavigateToProfile(notification.event.pubkey);
      return;
    }
    if (notification.type === 'livechat') {
      // A chat message belongs to its stream, not to a note page
      const address = notification.event.tags.find(t => t[0] === 'a')?.[1];
      const [kind, pubkey, identifier] = (address || '').split(':');
      if (kind && pubkey) {
        onNavigateToStream?.(Number(kind), pubkey, identifier || '');
      }
      return;
    }
    if (notification.type === 'reply' || notification.type === 'mention') {
      onNavigateToNote(notification.event.id);
      return;
    }
    const targetId = notification.event.tags.find(t => t[0] === 'e')?.[1];
    if (targetId) {
      onNavigateToNote(targetId);
    } else {
      onNavigateToProfile(notification.event.pubkey);
    }
  };

  const renderPreview = (notification: NostrNotification): React.ReactNode => {
    let rawContent: string | undefined;
    // Whichever event the text comes from also carries its emoji definitions
    let sourceTags: string[][] | undefined;
    if (
      notification.type === 'reply'
      || notification.type === 'mention'
      || notification.type === 'livechat'
    ) {
      rawContent = notification.event.content;
      sourceTags = notification.event.tags;
    } else {
      const targetId = notification.event.tags.find(t => t[0] === 'e')?.[1];
      // The note this is about is often already in memory — from the feed,
      // or from an earlier visit — so read it straight out rather than
      // showing an empty preview until the network answers
      const target = targetId ? (targetNotes[targetId] || EventCache.getEvent(targetId)) : undefined;
      rawContent = target?.content;
      sourceTags = target?.tags;
    }
    if (!rawContent) return null;

    // Raw content can be just a "nostr:nevent1..."/"note1..." quote
    // reference with no other text — strip it like EventCard does instead
    // of showing that literal string, falling back to a plain label when
    // stripping leaves nothing else to preview
    const stripped = stripMediaUrls(rawContent);
    if (!stripped) return '🔁 Quoted a post';

    // Mentions, hashtags and links were showing as raw "nostr:npub1…" text
    return (
      <RichText
        content={stripped}
        eventTags={sourceTags}
        onNavigateToProfile={onNavigateToProfile}
        onNavigateToNote={onNavigateToNote}
      />
    );
  };

  return (
    <div className="notifications-page">
      <div className="notifications-header">
        <h2>Notifications</h2>
      </div>

      {loading && <div className="loading">Loading notifications...</div>}

      {!loading && notifications.length === 0 && (
        <div className="empty-state">
          <p>No notifications yet — replies, mentions, reactions, reposts and zaps will show up here</p>
        </div>
      )}

      <div className="notification-list">
        {notifications.map((notification) => {
          // Profiles persist locally, so the name and avatar are usually
          // known before any request goes out — reading them here stops the
          // list rendering as anonymous placeholders on every visit
          const profile = profiles[notification.event.pubkey]
            || EventCache.getProfile(notification.event.pubkey);
          const displayName = profile?.display_name || profile?.name || formatAddress(notification.event.pubkey);
          const meta = TYPE_META[notification.type];
          const icon = notification.type === 'reaction'
            ? reactionIcon(notification.event.content)
            : meta.icon;
          const preview = renderPreview(notification);
          const isNew = (notification.event.created_at || 0) > initialLastSeenRef.current;
          const amountSats = notification.type === 'zap'
            ? NostrCore.getZapAmountSats(notification.event)
            : 0;

          return (
            <div
              key={notification.id}
              className={`notification-item ${isNew ? 'unread' : ''}`}
              onClick={() => handleClick(notification)}
            >
              <span className="notification-icon">{icon}</span>
              {profile?.picture ? (
                <img
                  src={profile.picture}
                  alt={displayName}
                  className="notification-avatar"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              ) : (
                <div className="notification-avatar-placeholder">
                  {displayName.charAt(0).toUpperCase()}
                </div>
              )}
              <div className="notification-body">
                <div className="notification-text">
                  <button
                    className="notification-actor"
                    onClick={(e) => { e.stopPropagation(); onNavigateToProfile(notification.event.pubkey); }}
                  >
                    {displayName}
                  </button>{' '}
                  {meta.verb}
                  {notification.type === 'zap' && amountSats > 0 ? ` (${amountSats.toLocaleString()} sats)` : ''}
                </div>
                {preview && <div className="notification-preview">{preview}</div>}
              </div>
              <div className="notification-time">
                {formatDate(new Date((notification.event.created_at || 0) * 1000))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default NotificationsPage;
