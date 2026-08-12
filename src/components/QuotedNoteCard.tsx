import React, { useEffect, useState } from 'react';
import { NostrEventSigned, UserProfile } from '../types';
import { NostrCore, EventCache } from '../nostr/core';
import { formatDate, formatAddress } from '../utils/helpers';
import { extractImageUrls, extractVideoUrls, extractEmbeds, stripMediaUrls } from '../utils/media';
import MediaEmbed from './MediaEmbed';
import VideoPlayer from './VideoPlayer';

// A quote can itself quote something — allow one nested level (a quote
// inside the quote) rather than none, but stop there so a chain of many
// quotes can't recurse into an ever-growing wall of cards
const MAX_QUOTE_DEPTH = 1;

interface QuotedNoteCardProps {
  event: NostrEventSigned;
  // Set when the quoted reference resolved through a repost — the repost
  // itself is unwrapped down to this note, but who reposted it is still
  // worth crediting
  repostedBy?: string | null;
  depth?: number;
  onNavigateToProfile: (pubkey: string) => void;
  onNavigateToNote?: (noteId: string) => void;
}

/**
 * Compact, non-interactive preview of a quoted note — X-style quote card.
 * Unlike EventCard it has no action bar, and recursion into a further
 * nested quote is capped at MAX_QUOTE_DEPTH to keep it lightweight.
 */
const QuotedNoteCard: React.FC<QuotedNoteCardProps> = ({ event, repostedBy, depth = 0, onNavigateToProfile, onNavigateToNote }) => {
  const [profile, setProfile] = useState<UserProfile | null>(EventCache.getProfile(event.pubkey));
  const [reposterProfile, setReposterProfile] = useState<UserProfile | null>(
    repostedBy ? EventCache.getProfile(repostedBy) : null
  );
  const [nested, setNested] = useState<{ note: NostrEventSigned; repostedBy?: string } | null>(null);

  useEffect(() => {
    if (!repostedBy || reposterProfile) return;
    let cancelled = false;
    NostrCore.fetchUserProfile(repostedBy).then(p => {
      if (!cancelled && p) setReposterProfile(p);
    });
    return () => { cancelled = true; };
  }, [repostedBy, reposterProfile]);

  useEffect(() => {
    if (profile) return;
    let cancelled = false;
    NostrCore.fetchUserProfile(event.pubkey).then(p => {
      if (!cancelled && p) setProfile(p);
    });
    return () => { cancelled = true; };
  }, [event.pubkey]);

  useEffect(() => {
    setNested(null);
    if (depth >= MAX_QUOTE_DEPTH) return;
    if (!/nostr:(?:note1|nevent1|naddr1)[a-z0-9]+/i.test(event.content)) return;
    let cancelled = false;
    NostrCore.resolveQuoteReference(event.content).then(resolved => {
      if (!cancelled && resolved) setNested(resolved);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event.id, depth]);

  const displayName = profile?.display_name || profile?.name || formatAddress(event.pubkey);
  const handle = profile?.nip05 || formatAddress(event.pubkey);
  // Strip the embedded nostr: reference itself out of the displayed text —
  // otherwise the raw "nostr:nevent1qqs…" string shows up as garbage at
  // the end of the quote, on top of (or instead of) the nested card below
  const text = stripMediaUrls(event.content).replace(/nostr:(?:note1|nevent1|naddr1)[a-z0-9]+/gi, '').trim();
  const images = extractImageUrls(event.content);
  const videos = extractVideoUrls(event.content);
  const embeds = extractEmbeds(event.content);

  const reposterName = reposterProfile?.display_name || reposterProfile?.name || (repostedBy ? formatAddress(repostedBy) : '');

  return (
    <div className="quoted-note-card" onClick={() => onNavigateToNote?.(event.id)}>
      {repostedBy && (
        <button
          className="quoted-note-reposted-by"
          onClick={(e) => { e.stopPropagation(); onNavigateToProfile(repostedBy); }}
        >
          🔁 Reposted by {reposterName}
        </button>
      )}
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

      {images.length === 0 && videos.length === 0 && embeds.length > 0 && (
        <div onClick={(e) => e.stopPropagation()}>
          <MediaEmbed embed={embeds[0]} className="quoted-note-media" />
        </div>
      )}

      {nested && (
        <div className="quoted-note-nested" onClick={(e) => e.stopPropagation()}>
          <QuotedNoteCard
            event={nested.note}
            repostedBy={nested.repostedBy}
            depth={depth + 1}
            onNavigateToProfile={onNavigateToProfile}
            onNavigateToNote={onNavigateToNote}
          />
        </div>
      )}
    </div>
  );
};

export default QuotedNoteCard;
