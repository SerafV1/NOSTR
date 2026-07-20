import React, { useEffect, useState } from 'react';
import { NostrEventSigned, UserProfile } from '../types';
import { NostrCore, EventCache } from '../nostr/core';
import { formatDate, formatAddress } from '../utils/helpers';
import { extractImageUrls, extractVideoUrls, extractYouTubeIds, stripMediaUrls } from '../utils/media';
import VideoPlayer from './VideoPlayer';

interface QuotedNoteCardProps {
  event: NostrEventSigned;
  onNavigateToProfile: (pubkey: string) => void;
  onNavigateToNote?: (noteId: string) => void;
}

/**
 * Compact, non-interactive preview of a quoted note — X-style quote card.
 * Unlike EventCard it has no action bar and doesn't recurse into further
 * quotes, keeping nested quotes lightweight and bounded to one level.
 */
const QuotedNoteCard: React.FC<QuotedNoteCardProps> = ({ event, onNavigateToProfile, onNavigateToNote }) => {
  const [profile, setProfile] = useState<UserProfile | null>(EventCache.getProfile(event.pubkey));

  useEffect(() => {
    if (profile) return;
    let cancelled = false;
    NostrCore.fetchUserProfile(event.pubkey).then(p => {
      if (!cancelled && p) setProfile(p);
    });
    return () => { cancelled = true; };
  }, [event.pubkey]);

  const displayName = profile?.display_name || profile?.name || formatAddress(event.pubkey);
  const handle = profile?.nip05 || formatAddress(event.pubkey);
  const text = stripMediaUrls(event.content);
  const images = extractImageUrls(event.content);
  const videos = extractVideoUrls(event.content);
  const youtubeIds = extractYouTubeIds(event.content);

  return (
    <div className="quoted-note-card" onClick={() => onNavigateToNote?.(event.id)}>
      <div className="quoted-note-header">
        <button
          className="quoted-note-avatar"
          onClick={(e) => { e.stopPropagation(); onNavigateToProfile(event.pubkey); }}
        >
          {profile?.picture ? (
            <img src={profile.picture} alt="" />
          ) : (
            <span className="quoted-note-avatar-placeholder">{displayName.charAt(0).toUpperCase()}</span>
          )}
        </button>
        <button
          className="quoted-note-name"
          onClick={(e) => { e.stopPropagation(); onNavigateToProfile(event.pubkey); }}
        >
          {displayName}
        </button>
        <span className="quoted-note-handle">@{handle}</span>
        <span className="quoted-note-dot">·</span>
        <span className="quoted-note-time">{formatDate(new Date(event.created_at * 1000))}</span>
      </div>

      {text && <p className="quoted-note-text">{text}</p>}

      {images.length > 0 && (
        <div className="quoted-note-media">
          <img src={images[0]} alt="" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
        </div>
      )}

      {images.length === 0 && videos.length > 0 && (
        <div className="quoted-note-media" onClick={(e) => e.stopPropagation()}>
          <VideoPlayer src={videos[0]} className="quoted-note-video" />
        </div>
      )}

      {images.length === 0 && videos.length === 0 && youtubeIds.length > 0 && (
        <div className="quoted-note-media event-video-embed" onClick={(e) => e.stopPropagation()}>
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${youtubeIds[0]}`}
            title="YouTube video"
            allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        </div>
      )}
    </div>
  );
};

export default QuotedNoteCard;
