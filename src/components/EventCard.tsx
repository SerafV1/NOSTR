import React, { useState, useEffect } from 'react';
import { nip19 } from 'nostr-tools';
import { NostrEventSigned, UserProfile } from '../types';
import { NostrCore, EventCache } from '../nostr/core';
import { formatDate, formatAddress } from '../utils/helpers';
import {
  extractImageUrls,
  extractVideoUrls,
  extractYouTubeIds,
  extractPreviewLinkUrl,
  stripMediaUrls,
  splitContentTokens
} from '../utils/media';
import ComposeModal from './ComposeModal';
import VideoPlayer from './VideoPlayer';
import QuotedNoteCard from './QuotedNoteCard';
import LinkPreviewCard from './LinkPreviewCard';
import EmojiPicker from './EmojiPicker';
import ZapButton from './ZapButton';
import { ReplyIcon, RepostIcon, HeartIcon, ZapIcon } from './Icons';

interface EventCardProps {
  event: NostrEventSigned;
  onNavigateToProfile: (pubkey: string) => void;
  onNavigateToNote?: (noteId: string) => void;
  onNavigateToTopic?: (topic: string) => void;
  onRefresh?: () => void;
}

const EventCard: React.FC<EventCardProps> = ({
  event,
  onNavigateToProfile,
  onNavigateToNote,
  onNavigateToTopic,
  onRefresh
}) => {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [replyCount, setReplyCount] = useState(0);
  const [repostCount, setRepostCount] = useState(0);
  const [reposted, setReposted] = useState(false);
  const [likeCount, setLikeCount] = useState(0);
  const [zapSats, setZapSats] = useState(0);
  const [showRepostOptions, setShowRepostOptions] = useState(false);
  const [composeMode, setComposeMode] = useState<'reply' | 'quote' | null>(null);
  const [reposting, setReposting] = useState(false);
  const [reactionEmoji, setReactionEmoji] = useState('');
  const [showReactions, setShowReactions] = useState(false);
  const [mentionedProfiles, setMentionedProfiles] = useState<Record<string, UserProfile>>({});
  const [enlargedImage, setEnlargedImage] = useState<string | null>(null);
  const [quotedNote, setQuotedNote] = useState<NostrEventSigned | null>(null);

  useEffect(() => {
    loadProfile();
    loadEngagement();
    loadMentionedProfiles();
    loadQuotedNote();
  }, [event]);

  const loadEngagement = async () => {
    try {
      const engagement = await NostrCore.fetchEngagement(event.id);
      setReplyCount(engagement.replies);
      setRepostCount(engagement.reposts);
      setReposted(engagement.myRepost);
      setLikeCount(engagement.likes);
      setZapSats(engagement.zapSats);
      if (engagement.myReaction) {
        setReactionEmoji(engagement.myReaction);
      }
    } catch (error) {
      console.error('Failed to load engagement:', error);
    }
  };

  const loadMentionedProfiles = async () => {
    try {
      const mentions = extractMentions(event.content);
      const profiles: Record<string, UserProfile> = {};

      for (const mention of mentions) {
        const normalizedMention = mention.toLowerCase();
        try {
          let profile = EventCache.getProfile(normalizedMention);
          if (!profile) {
            profile = await NostrCore.fetchUserProfile(normalizedMention);
            if (profile) {
              EventCache.addProfile(profile);
            }
          }
          if (profile) {
            profiles[normalizedMention] = profile;
          }
        } catch (error) {
          console.error(`Failed to fetch profile for mention ${normalizedMention}:`, error);
        }
      }

      setMentionedProfiles(profiles);
    } catch (error) {
      console.error('Failed to load mentioned profiles:', error);
    }
  };

  const loadQuotedNote = async () => {
    try {
      // Look for a nostr:note1..., nostr:nevent1... or nostr:naddr1... reference
      const matches = event.content.match(/nostr:(?:note1|nevent1|naddr1)[a-z0-9]+/gi);

      if (matches && matches.length > 0) {
        const link = matches[0];
        const linkLower = link.toLowerCase();

        if (linkLower.includes('naddr1')) {
          const address = decodeNaddr(link);
          if (address) {
            const note = await NostrCore.fetchEventByAddress(address.kind, address.pubkey, address.identifier);
            if (note) setQuotedNote(note);
          }
          return;
        }

        const decodedId = linkLower.includes('nevent1') ? decodeNevent(link) : decodeNote(link);
        if (decodedId) {
          const note = await NostrCore.fetchEventById(decodedId);
          if (note) {
            setQuotedNote(note);
          }
        }
      }
    } catch (error) {
      console.error('Failed to load quoted note:', error);
    }
  };

  const decodeNote = (noteLink: string): string | null => {
    try {
      const decoded = nip19.decode(noteLink.replace(/^nostr:/, ''));
      return decoded.type === 'note' && typeof decoded.data === 'string' ? decoded.data : null;
    } catch (error) {
      console.error('Failed to decode note:', error);
      return null;
    }
  };

  const decodeNevent = (neventLink: string): string | null => {
    try {
      const decoded = nip19.decode(neventLink.replace(/^nostr:/, ''));
      return decoded.type === 'nevent' ? (decoded.data as { id: string }).id : null;
    } catch (error) {
      console.error('Failed to decode nevent:', error);
      return null;
    }
  };

  const decodeNaddr = (naddrLink: string): { kind: number; pubkey: string; identifier: string } | null => {
    try {
      const decoded = nip19.decode(naddrLink.replace(/^nostr:/, ''));
      if (decoded.type !== 'naddr') return null;
      const { kind, pubkey, identifier } = decoded.data as { kind: number; pubkey: string; identifier: string };
      return { kind, pubkey, identifier };
    } catch (error) {
      console.error('Failed to decode naddr:', error);
      return null;
    }
  };

  const decodeNpub = (npubLink: string): string | null => {
    try {
      const decoded = nip19.decode(npubLink.replace(/^nostr:/, ''));
      return decoded.type === 'npub' && typeof decoded.data === 'string' ? decoded.data : null;
    } catch (error) {
      console.error('Failed to decode npub:', error);
      return null;
    }
  };

  const extractMentions = (content: string): string[] => {
    const mentions = new Set<string>();

    // Match hex pubkeys (64 hex characters, case-insensitive)
    const pubkeyRegex = /[a-fA-F0-9]{64}/g;
    const hexMatches = content.match(pubkeyRegex) || [];
    hexMatches.forEach(m => mentions.add(m.toLowerCase()));

    // Match nostr:nprofile and nostr:npub links and extract the pubkey
    const nprofileMatches = content.match(/nostr:nprofile1[a-z0-9]+/gi) || [];
    nprofileMatches.forEach(link => {
      const pubkey = decodeNprofile(link);
      if (pubkey) mentions.add(pubkey.toLowerCase());
    });

    const npubMatches = content.match(/nostr:npub1[a-z0-9]+/gi) || [];
    npubMatches.forEach(link => {
      const pubkey = decodeNpub(link);
      if (pubkey) mentions.add(pubkey.toLowerCase());
    });

    return Array.from(mentions);
  };

  const decodeNprofile = (nprofileLink: string): string | null => {
    try {
      const decoded = nip19.decode(nprofileLink.replace(/^nostr:/, ''));
      return decoded.type === 'nprofile' ? (decoded.data as { pubkey: string }).pubkey : null;
    } catch (error) {
      console.error('Failed to decode nprofile:', error);
      return null;
    }
  };

  const renderContentWithMentions = (content: string) => {
    const parts: (string | React.ReactNode)[] = [];
    let lastIndex = 0;
    let keyIndex = 0;

    // Combine nprofile, npub and raw hex pubkey mention patterns
    const combinedRegex = /(?:(nostr:nprofile1[a-z0-9]+)|(nostr:npub1[a-z0-9]+)|([a-fA-F0-9]{64}))/gi;
    let match;

    while ((match = combinedRegex.exec(content)) !== null) {
      let pubkey: string | null = null;

      if (match[1]) {
        // This is an nprofile link
        pubkey = decodeNprofile(match[1]);
      } else if (match[2]) {
        // This is an npub link
        pubkey = decodeNpub(match[2]);
      } else if (match[3]) {
        // This is a raw hex pubkey
        pubkey = match[3].toLowerCase();
      }

      if (!pubkey) continue;

      const mentionProfile = mentionedProfiles[pubkey];

      // Add text before mention
      if (match.index > lastIndex) {
        parts.push(content.substring(lastIndex, match.index));
      }

      // Add mention as link — prefer the NIP-05 handle, like @user@domain
      if (mentionProfile) {
        const handle = mentionProfile.name || mentionProfile.display_name || mentionProfile.nip05 || formatAddress(pubkey);
        parts.push(
          <button
            key={`mention-${keyIndex}-${pubkey}`}
            onClick={(e) => { e.stopPropagation(); onNavigateToProfile(pubkey); }}
            className="mention-link"
            title={`@${handle}`}
          >
            @{handle}
          </button>
        );
      } else {
        parts.push(
          <button
            key={`mention-${keyIndex}-${pubkey}`}
            onClick={(e) => { e.stopPropagation(); onNavigateToProfile(pubkey); }}
            className="mention-link"
            title={formatAddress(pubkey)}
          >
            @{formatAddress(pubkey)}
          </button>
        );
      }

      lastIndex = match.index + match[0].length;
      keyIndex++;
    }

    // Add remaining text
    if (lastIndex < content.length) {
      parts.push(content.substring(lastIndex));
    }

    // Render plain URLs and #hashtags in text parts as clickable elements
    const withLinks: (string | React.ReactNode)[] = [];
    parts.forEach((part, partIndex) => {
      if (typeof part !== 'string') {
        withLinks.push(part);
        return;
      }
      splitContentTokens(part).forEach((piece, pieceIndex) => {
        if (piece.type === 'text') {
          withLinks.push(piece.value);
        } else if (piece.type === 'hashtag') {
          withLinks.push(
            <button
              key={`hashtag-${partIndex}-${pieceIndex}`}
              className="hashtag-link"
              onClick={(e) => { e.stopPropagation(); onNavigateToTopic?.(piece.value); }}
            >
              #{piece.value}
            </button>
          );
        } else {
          const label = piece.value.replace(/^https?:\/\//, '');
          withLinks.push(
            <a
              key={`link-${partIndex}-${pieceIndex}`}
              href={piece.value}
              target="_blank"
              rel="noopener noreferrer"
              className="content-link"
              onClick={(e) => e.stopPropagation()}
            >
              {label.length > 42 ? `${label.slice(0, 42)}…` : label}
            </a>
          );
        }
      });
    });

    return withLinks.length > 0 ? withLinks : content;
  };

  const loadProfile = async () => {
    try {
      let cachedProfile = EventCache.getProfile(event.pubkey);
      
      if (!cachedProfile) {
        cachedProfile = await NostrCore.fetchUserProfile(event.pubkey);
        if (cachedProfile) {
          EventCache.addProfile(cachedProfile);
        }
      }

      setProfile(cachedProfile);
    } catch (error) {
      console.error('Failed to load profile:', error);
    }
  };



  const handleReaction = async (emoji: string) => {
    setShowReactions(false);
    try {
      const published = await NostrCore.addReaction(event.id, emoji, event.pubkey);
      if (published) {
        if (!reactionEmoji) setLikeCount(count => count + 1);
        setReactionEmoji(emoji);
      } else {
        alert('Reaction was not accepted by any relay — check your connection');
      }
    } catch (error) {
      console.error('Failed to add reaction:', error);
      alert('Failed to publish reaction');
    }
  };

  const handleRepost = async () => {
    setShowRepostOptions(false);
    if (reposted || reposting) return;

    setReposting(true);
    try {
      const published = await NostrCore.repostEvent(event);
      if (published) {
        setReposted(true);
        setRepostCount(count => count + 1);
      } else {
        alert('Repost was not accepted by any relay — check your connection');
      }
    } catch (error) {
      console.error('Failed to repost:', error);
      alert('Failed to repost');
    } finally {
      setReposting(false);
    }
  };

  const handleComposePublished = () => {
    if (composeMode === 'reply') {
      setReplyCount(count => count + 1);
      onRefresh?.();
    }
    setComposeMode(null);
  };

  const openCompose = (mode: 'reply' | 'quote') => {
    setShowRepostOptions(false);
    setComposeMode(current => (current === mode ? null : mode));
  };

  // 1234 → "1.2k", 2500000 → "2.5M"
  const formatSats = (sats: number): string => {
    if (sats >= 1_000_000) return `${(sats / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    if (sats >= 1_000) return `${(sats / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
    return String(sats);
  };

  const displayName = profile?.display_name || profile?.name || formatAddress(event.pubkey);
  const displayPicture = profile?.picture || '';

  return (
    <div className="event-card">
      <div className="event-header">
        <div className="event-author-info">
          {displayPicture ? (
            <img 
              src={displayPicture} 
              alt={displayName}
              className="author-avatar"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
              }}
            />
          ) : (
            <div className="author-avatar-placeholder">
              {displayName.charAt(0).toUpperCase()}
            </div>
          )}
          <div className="author-details">
            <button 
              className="author-name"
              onClick={() => onNavigateToProfile(event.pubkey)}
            >
              {displayName}
            </button>
            <div className="author-handle">
              {profile?.nip05 || formatAddress(event.pubkey)}
            </div>
          </div>
        </div>
        <div className="event-timestamp">
          {formatDate(new Date(event.created_at * 1000))}
        </div>
      </div>

      <div className="event-content" onClick={() => onNavigateToNote?.(event.id)} style={{ cursor: 'pointer' }}>
        {stripMediaUrls(event.content) && (
          <p>{renderContentWithMentions(stripMediaUrls(event.content))}</p>
        )}
        {event.tags.filter(t => t[0] === 't').length > 0 && (
          <div className="event-hashtags">
            {event.tags
              .filter(t => t[0] === 't')
              .map((tag, index) => (
                <button
                  key={index}
                  className="event-hashtag"
                  onClick={(e) => { e.stopPropagation(); onNavigateToTopic?.(tag[1]); }}
                >
                  #{tag[1]}
                </button>
              ))}
          </div>
        )}
        {extractImageUrls(event.content).length > 0 && (
          <div className="event-images">
            {extractImageUrls(event.content).map((imageUrl, index) => (
              <button
                key={index}
                className="event-image-preview"
                onClick={(e) => { e.stopPropagation(); setEnlargedImage(imageUrl); }}
                style={{ border: 'none', padding: 0, background: 'none', cursor: 'pointer' }}
              >
                <img
                  src={imageUrl}
                  alt={`Note image ${index + 1}`}
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
              </button>
            ))}
          </div>
        )}
        {extractVideoUrls(event.content).length > 0 && (
          <div className="event-videos" onClick={(e) => e.stopPropagation()}>
            {extractVideoUrls(event.content).map((videoUrl) => (
              <VideoPlayer key={videoUrl} src={videoUrl} className="event-video" />
            ))}
          </div>
        )}
        {extractYouTubeIds(event.content).length > 0 && (
          <div className="event-videos" onClick={(e) => e.stopPropagation()}>
            {extractYouTubeIds(event.content).map((videoId) => (
              <div key={videoId} className="event-video-embed">
                <iframe
                  src={`https://www.youtube-nocookie.com/embed/${videoId}`}
                  title="YouTube video"
                  allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              </div>
            ))}
          </div>
        )}
        {extractImageUrls(event.content).length === 0 &&
          extractVideoUrls(event.content).length === 0 &&
          extractYouTubeIds(event.content).length === 0 &&
          extractPreviewLinkUrl(event.content) && (
            <div onClick={(e) => e.stopPropagation()}>
              <LinkPreviewCard url={extractPreviewLinkUrl(event.content)!} />
            </div>
        )}
      </div>

      {quotedNote && (
        <QuotedNoteCard
          event={quotedNote}
          onNavigateToProfile={onNavigateToProfile}
          onNavigateToNote={onNavigateToNote}
        />
      )}

      <div className="event-actions">
        <button
          className="action-btn"
          onClick={() => openCompose('reply')}
          title="Reply"
        >
          <ReplyIcon className="action-icon" />
          <span className="action-count">{replyCount}</span>
        </button>

        <div className="reaction-container">
          <button
            className={`action-btn ${reposted ? 'reposted' : ''}`}
            onClick={() => setShowRepostOptions(!showRepostOptions)}
            disabled={reposting}
            title={reposted ? 'You reposted this' : 'Repost or quote'}
          >
            <RepostIcon className="action-icon" filled={reposted} />
            <span className="action-count">{repostCount}</span>
          </button>
          {showRepostOptions && (
            <div className="reply-options-menu">
              <button
                className="reply-option"
                onClick={handleRepost}
              >
                <RepostIcon className="reply-option-icon" /> Repost
              </button>
              <button
                className="reply-option"
                onClick={() => openCompose('quote')}
              >
                ❝ Quote
              </button>
            </div>
          )}
        </div>

        <div className="reaction-container">
          <button
            className={`action-btn ${reactionEmoji ? 'liked' : ''}`}
            onClick={() => setShowReactions(!showReactions)}
            title={reactionEmoji ? `You reacted with ${reactionEmoji}` : 'React'}
          >
            {reactionEmoji ? (
              <span className="action-icon">{reactionEmoji}</span>
            ) : (
              <HeartIcon className="action-icon" />
            )}
            <span className="action-count">{likeCount}</span>
          </button>
          {showReactions && (
            <div className="reactions-menu">
              <EmojiPicker onSelect={(emoji) => { handleReaction(emoji); setShowReactions(false); }} />
            </div>
          )}
        </div>

        <ZapButton lud16={profile?.lud16} triggerClassName="action-btn" triggerTitle="Zap with lightning">
          <ZapIcon className="action-icon" filled={zapSats > 0} />
          <span className="action-count">{formatSats(zapSats)}</span>
        </ZapButton>
      </div>

      {composeMode && (
        <ComposeModal
          title={composeMode === 'reply' ? 'Reply' : 'Quote'}
          replyTo={composeMode === 'reply' ? event.id : undefined}
          quoteNoteId={composeMode === 'quote' ? event.id : undefined}
          context={{ authorName: displayName, authorPicture: displayPicture, content: event.content }}
          onClose={() => setComposeMode(null)}
          onPublished={handleComposePublished}
        />
      )}

      {enlargedImage && (
        <div className="image-modal" onClick={() => setEnlargedImage(null)}>
          <div className="image-modal-content" onClick={(e) => e.stopPropagation()}>
            <button className="image-modal-close" onClick={() => setEnlargedImage(null)}>
              ✕
            </button>
            <img src={enlargedImage} alt="Enlarged" className="image-modal-img" />
          </div>
        </div>
      )}
    </div>
  );
};

export default EventCard;
