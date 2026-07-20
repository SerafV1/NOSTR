import React, { useState, useEffect, useRef } from 'react';
import { NostrEventSigned, UserProfile } from '../types';
import { NostrCore, PersistentCache } from '../nostr/core';
import { NotificationCore, NotificationStore, NostrNotification, NotificationType } from '../nostr/notifications';
import { formatDate, formatAddress } from '../utils/helpers';

interface NotificationsPageProps {
  pubkey: string;
  relaysConnected: boolean;
  onNavigateToProfile: (pubkey: string) => void;
  onNavigateToNote: (noteId: string) => void;
  onMarkRead?: () => void;
}

const TYPE_META: Record<NotificationType, { icon: string; verb: string }> = {
  reply: { icon: '💬', verb: 'replied to your note' },
  mention: { icon: '📣', verb: 'mentioned you' },
  reaction: { icon: '❤️', verb: 'reacted to your note' },
  repost: { icon: '🔄', verb: 'reposted your note' },
  zap: { icon: '⚡', verb: 'zapped you' }
};

const NotificationsPage: React.FC<NotificationsPageProps> = ({
  pubkey,
  relaysConnected,
  onNavigateToProfile,
  onNavigateToNote,
  onMarkRead
}) => {
  const [notifications, setNotifications] = useState<NostrNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [profiles, setProfiles] = useState<Record<string, UserProfile>>({});
  const [targetNotes, setTargetNotes] = useState<Record<string, NostrEventSigned>>({});
  // Captured once on mount so items stay highlighted as "new" for this
  // viewing even after the seen marker below advances past them
  const initialLastSeenRef = useRef(NotificationStore.getLastSeen(pubkey));

  const loadNotifications = async () => {
    const cached = PersistentCache.get<NostrNotification[]>(`notifications_${pubkey}`);
    if (cached && cached.length > 0) {
      setNotifications(cached);
      setLoading(false);
    } else {
      setLoading(true);
    }

    try {
      const fetched = await NotificationCore.fetchNotifications(pubkey, 100);

      const actorProfiles = await NostrCore.fetchProfiles(fetched.map(n => n.event.pubkey));
      setProfiles(prev => ({ ...prev, ...Object.fromEntries(actorProfiles) }));

      const targetIds = fetched
        .filter(n => n.type === 'reaction' || n.type === 'repost' || n.type === 'zap')
        .map(n => n.event.tags.find(t => t[0] === 'e')?.[1])
        .filter((id): id is string => !!id);
      if (targetIds.length > 0) {
        const targets = await NostrCore.fetchEventsByIds(targetIds);
        setTargetNotes(prev => ({ ...prev, ...Object.fromEntries(targets) }));
      }

      setNotifications(fetched);
      PersistentCache.set(`notifications_${pubkey}`, fetched);
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
      const cached = PersistentCache.get<NostrNotification[]>(`notifications_${pubkey}`);
      if (cached && cached.length > 0) {
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
    onMarkRead?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notifications, pubkey]);

  const handleClick = (notification: NostrNotification) => {
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

  const renderPreview = (notification: NostrNotification): string | null => {
    if (notification.type === 'reply' || notification.type === 'mention') {
      return notification.event.content || null;
    }
    const targetId = notification.event.tags.find(t => t[0] === 'e')?.[1];
    if (!targetId) return null;
    return targetNotes[targetId]?.content || null;
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
          const profile = profiles[notification.event.pubkey];
          const displayName = profile?.display_name || profile?.name || formatAddress(notification.event.pubkey);
          const meta = TYPE_META[notification.type];
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
              <span className="notification-icon">{meta.icon}</span>
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
