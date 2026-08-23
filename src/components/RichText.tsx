import React, { useEffect, useState } from 'react';
import { nip19 } from 'nostr-tools';
import { UserProfile } from '../types';
import { NostrCore, EventCache } from '../nostr/core';
import { formatAddress } from '../utils/helpers';
import { splitContentTokens, extractImageUrls, extractVideoUrls } from '../utils/media';
import { customEmojiMap, splitCustomEmoji } from '../utils/customEmoji';
import InlineQuotedNote from './InlineQuotedNote';

interface RichTextProps {
  content: string;
  onNavigateToProfile?: (pubkey: string) => void;
  onNavigateToNote?: (noteId: string) => void;
  onNavigateToTopic?: (topic: string) => void;
  /** Draw picture links as pictures — chat messages are mostly images */
  inlineImages?: boolean;
  /** Show a referenced note as the note, not as a link to it */
  inlineQuotes?: boolean;
  /** The event's tags, for the NIP-30 emoji its text may refer to */
  eventTags?: string[][];
  className?: string;
}

// References worth turning into something clickable. The `nostr:` prefix is
// optional because plenty of clients publish a bare "npub1…" or write the
// mention as "@nprofile1…", and requiring the prefix left those as raw
// text. The length floor keeps a word like "note1" from matching.
const REF_REGEX = /@?(?:nostr:)?(?:note1|nevent1|naddr1|nprofile1|npub1)[a-z0-9]{20,}/gi;

/** Strip the decorations the text may carry before bech32 decoding */
const bareRef = (ref: string): string => ref.replace(/^@/, '').replace(/^nostr:/i, '');

const decodeProfileRef = (ref: string): string | null => {
  try {
    const decoded = nip19.decode(bareRef(ref));
    if (decoded.type === 'npub' && typeof decoded.data === 'string') return decoded.data;
    if (decoded.type === 'nprofile') return (decoded.data as { pubkey: string }).pubkey;
  } catch {
    // Malformed bech32 — leave it as text
  }
  return null;
};

const decodeNoteRef = (ref: string): string | null => {
  try {
    const decoded = nip19.decode(bareRef(ref));
    if (decoded.type === 'note' && typeof decoded.data === 'string') return decoded.data;
    if (decoded.type === 'nevent') return (decoded.data as { id: string }).id;
  } catch {
    // Malformed bech32 — leave it as text
  }
  return null;
};

/**
 * Renders note-like text the way the feed does: URLs become links,
 * #hashtags open the topic, and nostr: references to people and notes
 * become clickable — mentions by name once the profile resolves, rather
 * than as a raw "nostr:nprofile1…" string.
 */
const RichText: React.FC<RichTextProps> = ({
  content,
  onNavigateToProfile,
  onNavigateToNote,
  onNavigateToTopic,
  inlineImages = false,
  inlineQuotes = false,
  eventTags,
  className
}) => {
  const [profiles, setProfiles] = useState<Record<string, UserProfile>>({});

  // Resolve the people mentioned here, so they read as names. Whatever is
  // already cached renders on the first pass, without a round trip.
  useEffect(() => {
    const pubkeys = Array.from(
      new Set(
        (content.match(REF_REGEX) || [])
          .map(decodeProfileRef)
          .filter((pk): pk is string => !!pk)
      )
    );
    if (pubkeys.length === 0) return;

    const cached: Record<string, UserProfile> = {};
    const missing: string[] = [];
    for (const pk of pubkeys) {
      const known = EventCache.getProfile(pk);
      if (known) cached[pk] = known;
      else missing.push(pk);
    }
    if (Object.keys(cached).length > 0) setProfiles(prev => ({ ...prev, ...cached }));
    if (missing.length === 0) return;

    let cancelled = false;
    NostrCore.fetchProfiles(missing).then(fetched => {
      if (!cancelled && fetched.size > 0) {
        setProfiles(prev => ({ ...prev, ...Object.fromEntries(fetched) }));
      }
    });
    return () => { cancelled = true; };
  }, [content]);

  const parts: React.ReactNode[] = [];
  let key = 0;
  const emojis = customEmojiMap(eventTags);

  /** Plain text, with any :shortcode: the event defines drawn as a picture */
  const pushText = (text: string) => {
    for (const piece of splitCustomEmoji(text, emojis)) {
      if (piece.type === 'emoji') {
        parts.push(
          <img key={key++} src={piece.url} alt={`:${piece.value}:`} className="custom-emoji" />
        );
      } else {
        parts.push(piece.value);
      }
    }
  };

  // Links come first, and references are only looked for in what is left
  // over. A bech32 reference can sit inside a URL's path — a link to a live
  // stream on this very app ends in an naddr — and scanning for references
  // first tore such a link in half: the start stayed a link, the naddr
  // onwards became plain text.
  const pushLinksAndHashtags = (text: string) => {
    for (const token of splitContentTokens(text)) {
      if (token.type === 'link') {
        // A link to a picture is more useful as the picture — otherwise a
        // chat full of images reads as a wall of URLs
        if (inlineImages && extractImageUrls(token.value).length > 0) {
          parts.push(
            <a
              key={key++}
              href={token.value}
              target="_blank"
              rel="noopener noreferrer"
              className="rich-image-link"
              onClick={(e) => e.stopPropagation()}
            >
              <img
                src={token.value}
                alt=""
                className="rich-image"
                loading="lazy"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            </a>
          );
          continue;
        }

        // Same reasoning for a video someone drops in the chat: it was left
        // as a link, so the one thing worth seeing needed a trip to another
        // tab. Muted and not preloaded, so a busy chat does not start
        // downloading every clip in it at once.
        if (inlineImages && extractVideoUrls(token.value).length > 0) {
          parts.push(
            <video
              key={key++}
              src={token.value}
              className="rich-video"
              controls
              muted
              playsInline
              preload="none"
              onClick={(e) => e.stopPropagation()}
            />
          );
          continue;
        }

        parts.push(
          <a
            key={key++}
            href={token.value}
            target="_blank"
            rel="noopener noreferrer"
            className="content-link"
            onClick={(e) => e.stopPropagation()}
          >
            {token.value}
          </a>
        );
      } else if (token.type === 'hashtag') {
        parts.push(
          <button
            key={key++}
            type="button"
            className="hashtag-link"
            onClick={(e) => { e.stopPropagation(); onNavigateToTopic?.(token.value); }}
          >
            #{token.value}
          </button>
        );
      } else {
        pushRefs(token.value);
      }
    }
  };

  // Mentions and note references in ordinary text
  function pushRefs(text: string) {
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    const regex = new RegExp(REF_REGEX);

    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) pushText(text.slice(lastIndex, match.index));

      const ref = match[0];
      const lower = bareRef(ref).toLowerCase();
      const pubkey = lower.startsWith('npub1') || lower.startsWith('nprofile1') ? decodeProfileRef(ref) : null;
      const noteId = lower.startsWith('note1') || lower.startsWith('nevent1') ? decodeNoteRef(ref) : null;

      if (pubkey) {
        const profile = profiles[pubkey];
        const name = profile?.display_name || profile?.name || formatAddress(pubkey);
        parts.push(
          <button
            key={key++}
            type="button"
            className="mention-link"
            onClick={(e) => { e.stopPropagation(); onNavigateToProfile?.(pubkey); }}
          >
            @{name}
          </button>
        );
      } else if (noteId) {
        parts.push(inlineQuotes ? (
          <InlineQuotedNote
            key={key++}
            noteId={noteId}
            onNavigateToProfile={(pubkey) => onNavigateToProfile?.(pubkey)}
            onNavigateToNote={onNavigateToNote}
          />
        ) : (
          <button
            key={key++}
            type="button"
            className="mention-link"
            onClick={(e) => { e.stopPropagation(); onNavigateToNote?.(noteId); }}
          >
            📝 View note
          </button>
        ));
      } else {
        parts.push(ref);
      }

      lastIndex = match.index + ref.length;
    }

    if (lastIndex < text.length) pushText(text.slice(lastIndex));
  }

  pushLinksAndHashtags(content);

  return <span className={className}>{parts}</span>;
};

export default RichText;
