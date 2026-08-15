import React, { useEffect, useState } from 'react';
import { nip19 } from 'nostr-tools';
import { UserProfile } from '../types';
import { NostrCore, EventCache } from '../nostr/core';
import { formatAddress } from '../utils/helpers';
import { splitContentTokens } from '../utils/media';

interface RichTextProps {
  content: string;
  onNavigateToProfile?: (pubkey: string) => void;
  onNavigateToNote?: (noteId: string) => void;
  onNavigateToTopic?: (topic: string) => void;
  className?: string;
}

// nostr: references worth turning into something clickable
const REF_REGEX = /nostr:(?:note1|nevent1|naddr1|nprofile1|npub1)[a-z0-9]+/gi;

const decodeProfileRef = (ref: string): string | null => {
  try {
    const decoded = nip19.decode(ref.replace(/^nostr:/i, ''));
    if (decoded.type === 'npub' && typeof decoded.data === 'string') return decoded.data;
    if (decoded.type === 'nprofile') return (decoded.data as { pubkey: string }).pubkey;
  } catch {
    // Malformed bech32 — leave it as text
  }
  return null;
};

const decodeNoteRef = (ref: string): string | null => {
  try {
    const decoded = nip19.decode(ref.replace(/^nostr:/i, ''));
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
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const regex = new RegExp(REF_REGEX);

  // Plain stretches still need links and hashtags picked out of them
  const pushPlain = (text: string) => {
    for (const token of splitContentTokens(text)) {
      if (token.type === 'link') {
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
        parts.push(token.value);
      }
    }
  };

  while ((match = regex.exec(content)) !== null) {
    if (match.index > lastIndex) pushPlain(content.slice(lastIndex, match.index));

    const ref = match[0];
    const lower = ref.toLowerCase();
    const pubkey = lower.includes('npub1') || lower.includes('nprofile1') ? decodeProfileRef(ref) : null;
    const noteId = lower.includes('note1') || lower.includes('nevent1') ? decodeNoteRef(ref) : null;

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
      parts.push(
        <button
          key={key++}
          type="button"
          className="mention-link"
          onClick={(e) => { e.stopPropagation(); onNavigateToNote?.(noteId); }}
        >
          📝 View note
        </button>
      );
    } else {
      parts.push(ref);
    }

    lastIndex = match.index + ref.length;
  }

  if (lastIndex < content.length) pushPlain(content.slice(lastIndex));

  return <span className={className}>{parts}</span>;
};

export default RichText;
