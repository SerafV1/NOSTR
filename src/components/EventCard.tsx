import React, { useState, useRef, useEffect } from 'react';
import { nip19 } from 'nostr-tools';
import { NostrEventSigned, UserProfile, EVENT_KINDS } from '../types';
import { NostrCore, EventCache } from '../nostr/core';
import { CredentialManager } from '../nostr/crypto';
import { formatDate, formatAddress } from '../utils/helpers';
import {
  extractImageUrls,
  extractVideoUrls,
  extractStreamUrls,
  extractEmbeds,
  extractPreviewLinkUrl,
  stripMediaUrls,
  splitContentTokens,
  quoteRefRegex
} from '../utils/media';
import ComposeModal from './ComposeModal';
import RelayBadges from './RelayBadges';
import MediaEmbed from './MediaEmbed';
import Nip05Handle from './Nip05Handle';
import ProfileHoverCard from './ProfileHoverCard';
import Markdown from './Markdown';
import { useNavigate } from 'react-router-dom';
import VideoPlayer from './VideoPlayer';
import InlineStreamPlayer from './InlineStreamPlayer';
import InlineLiveStream from './InlineLiveStream';
import { foldNostrWebLinks } from '../utils/nostrLinks';
import { extractStreamRefs } from '../utils/liveStream';
import QuotedNoteCard from './QuotedNoteCard';
import LinkPreviewCard from './LinkPreviewCard';
import EmojiPicker from './EmojiPicker';
import ZapButton from './ZapButton';
import EmojiText from './EmojiText';
import { useAnchoredPopup } from '../hooks/useAnchoredPopup';
import { customEmojiMap, splitCustomEmoji } from '../utils/customEmoji';
import { ReplyIcon, RepostIcon, HeartIcon, ZapIcon, PersonIcon, BookmarkIcon } from './Icons';

interface EventCardProps {
  event: NostrEventSigned;
  onNavigateToProfile: (pubkey: string) => void;
  onNavigateToNote?: (noteId: string) => void;
  onNavigateToTopic?: (topic: string) => void;
  onRefresh?: () => void;
  /**
   * The post being read, rather than one card among many. Its counts are
   * gathered from every relay instead of from whichever answers first —
   * slower, but a post opened to read its replies must not say there are
   * none because one relay was a second late.
   */
  focused?: boolean;
}

const EventCard: React.FC<EventCardProps> = ({
  event,
  onNavigateToProfile,
  onNavigateToNote,
  onNavigateToTopic,
  onRefresh,
  focused = false
}) => {
  // A note pointed at through njump, primal, snort — anyone's web page —
  // carries its nostr address inside the link. Read as that address, it shows
  // as the note itself rather than as a line of URL nobody can follow here.
  const noteContent = foldNostrWebLinks(event.content);

  // NIP-23: the article's own furniture lives in tags, not in the content
  const isArticle = event.kind === EVENT_KINDS.LONG_FORM;
  const tag = (name: string) => event.tags.find(t => t[0] === name)?.[1];
  /**
   * An article's own address. Its author can publish a corrected version at
   * the same one, so that — not this copy's event id — is where a link to it
   * should lead.
   */
  const articleNaddr = isArticle
    ? (() => {
        try {
          return nip19.naddrEncode({
            kind: event.kind,
            pubkey: event.pubkey,
            identifier: tag('d') || ''
          });
        } catch {
          return '';
        }
      })()
    : '';
  const article = {
    title: tag('title') || '',
    summary: tag('summary') || '',
    image: tag('image') || ''
  };

  const [profile, setProfile] = useState<UserProfile | null>(null);
  // What these numbers were the last time this post was read. Starting at
  // nought meant a feed of noughts until the relays answered, which on a busy
  // page is several seconds of a post looking as if nobody had touched it.
  const cardRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const remembered = NostrCore.rememberedEngagement(event.id);
  /**
   * What this reader has just done, which the relays do not know yet.
   *
   * The authoritative count waits for every relay, so it can land seconds
   * after a tap — carrying the numbers as they were before it. Applied
   * blindly it undid the reaction that had just been published: the emoji
   * went back to nothing and the count to zero, and the button read as
   * broken while the reaction sat on the relays.
   */
  const mineRef = useRef<{
    reaction: string | null;
    reposted: boolean;
    /** Sats paid from here, and the total before they were */
    zapped: number;
    zapBaseline: number;
  }>({ reaction: null, reposted: false, zapped: 0, zapBaseline: 0 });
  const [replyCount, setReplyCount] = useState(remembered?.replies ?? 0);
  const [repostCount, setRepostCount] = useState(remembered?.reposts ?? 0);
  const [reposted, setReposted] = useState(false);
  const [likeCount, setLikeCount] = useState(remembered?.likes ?? 0);
  const [zapSats, setZapSats] = useState(remembered?.zapSats ?? 0);
  // Marked the way a like and a repost are: this is a note I zapped
  const [zapped, setZapped] = useState(() => NostrCore.ownZapSats(event.id) > 0);
  const [showRepostOptions, setShowRepostOptions] = useState(false);
  const [composeMode, setComposeMode] = useState<'reply' | 'quote' | null>(null);
  const [reposting, setReposting] = useState(false);
  const [reactionEmoji, setReactionEmoji] = useState('');
  const [showReactions, setShowReactions] = useState(false);
  // Read from the list already held locally, so a feed of cards does not ask
  // the relays once per card
  const [bookmarked, setBookmarked] = useState(() => NostrCore.isBookmarked(event.id));
  const [bookmarking, setBookmarking] = useState(false);
  // Closes on a click anywhere outside it, on Escape, and when another one
  // opens — a picker that only the same icon could dismiss stayed up while
  // you read the rest of the feed
  const reactionPicker = useAnchoredPopup(showReactions, () => setShowReactions(false));
  const repostMenu = useAnchoredPopup(showRepostOptions, () => setShowRepostOptions(false));
  const [mentionedProfiles, setMentionedProfiles] = useState<Record<string, UserProfile>>({});
  const [enlargedIndex, setEnlargedIndex] = useState<number | null>(null);
  const [quotedNote, setQuotedNote] = useState<NostrEventSigned | null>(null);
  const [quotedNoteStatus, setQuotedNoteStatus] = useState<'none' | 'loading' | 'loaded' | 'failed'>('none');
  // Set when the quoted reference resolves to a repost rather than a
  // plain note — the repost gets unwrapped down to the actual content,
  // but who reposted it is still worth showing
  const [quotedNoteRepostedBy, setQuotedNoteRepostedBy] = useState<string | null>(null);
  const [pollResponses, setPollResponses] = useState<NostrEventSigned[]>([]);
  const [votingOption, setVotingOption] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [showAllImages, setShowAllImages] = useState(false);
  const [mediaRevealed, setMediaRevealed] = useState(false);

  // NIP-36 content-warning tag, plus the common #nsfw hashtag convention
  // some clients use instead/as well
  const contentWarningTag = event.tags.find(t => t[0] === 'content-warning');
  const isSensitive = !!contentWarningTag || event.tags.some(t => t[0] === 't' && t[1]?.toLowerCase() === 'nsfw');

  // Long posts get truncated with a "Show more" toggle instead of
  // stretching the card indefinitely
  const CONTENT_TRUNCATE_LENGTH = 500;
  const IMAGE_PREVIEW_LIMIT = 4;

  // The numbers are asked for when the card comes near the screen, not when
  // it is created. A hundred cards asking at once had them all queuing behind
  // each other, and the ones being read waited on the ninety nobody had
  // scrolled to yet.
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    let asked = false;
    const ask = () => {
      if (asked) return;
      asked = true;
      loadEngagement();
    };

    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { ask(); observer.disconnect(); } },
      { rootMargin: '400px' }
    );
    observer.observe(card);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event.id]);

  useEffect(() => {
    loadProfile();
    loadMentionedProfiles();
    loadQuotedNote();
    if (event.kind === EVENT_KINDS.POLL) loadPollResponses();
    // Nostr events are immutable once signed, so event.id alone is the
    // right dependency — depending on the whole `event` object instead
    // meant a parent re-render handing down a new-but-equal object
    // reference (e.g. a fresh .map() array) re-triggered every loader
    // here, including a second, redundant loadQuotedNote() call. If that
    // second call happened to resolve after (and fail where) the first
    // one succeeded, its setQuotedNoteStatus('failed') stuck around
    // without clearing the quotedNote the first call had already set —
    // showing both the loaded quote and the "unavailable" message at once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event.id]);

  // Arrow keys step through the enlarged-image modal like a standard lightbox
  useEffect(() => {
    if (enlargedIndex === null) return;
    const images = extractImageUrls(noteContent);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEnlargedIndex(null);
      else if (e.key === 'ArrowLeft') setEnlargedIndex(i => (i !== null && i > 0 ? i - 1 : i));
      else if (e.key === 'ArrowRight') setEnlargedIndex(i => (i !== null && i < images.length - 1 ? i + 1 : i));
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [enlargedIndex, noteContent]);

  const loadPollResponses = async () => {
    try {
      const responses = await NostrCore.fetchPollResponses(event.id);
      setPollResponses(responses);
    } catch (error) {
      console.error('Failed to load poll responses:', error);
    }
  };

  // Tally by the latest response per voter — a later vote overrides an
  // earlier one, so re-voting just supersedes your previous choice
  const tallyPollVotes = (responses: NostrEventSigned[]): { counts: Record<string, number>; total: number; myVote: string | null } => {
    const latestByVoter = new Map<string, NostrEventSigned>();
    responses.forEach(r => {
      const existing = latestByVoter.get(r.pubkey);
      if (!existing || (r.created_at || 0) > (existing.created_at || 0)) {
        latestByVoter.set(r.pubkey, r);
      }
    });

    const counts: Record<string, number> = {};
    let myVote: string | null = null;
    const myPubkey = CredentialManager.getPublicKey();
    latestByVoter.forEach(r => {
      const optionId = r.tags.find(t => t[0] === 'response')?.[1];
      if (!optionId) return;
      counts[optionId] = (counts[optionId] || 0) + 1;
      if (myPubkey && r.pubkey === myPubkey) myVote = optionId;
    });

    return { counts, total: latestByVoter.size, myVote };
  };

  const handleVote = async (optionId: string) => {
    if (votingOption) return;
    setVotingOption(optionId);
    try {
      const responseEvent = await NostrCore.publishPollResponse(event.id, optionId);
      if (responseEvent) {
        setPollResponses(prev => [...prev, responseEvent]);
      } else {
        alert('Vote was not accepted by any relay — check your connection');
      }
    } catch (error) {
      console.error('Failed to vote:', error);
      alert('Failed to publish vote');
    } finally {
      setVotingOption(null);
    }
  };

  const loadEngagement = async () => {
    try {
      // The post being read gets both: the quick answer that comes with the
      // rest of the page, then the thorough one that waits for every relay.
      // Waiting only for the thorough one left the numbers blank for as long
      // as the slowest relay took.
      if (focused) {
        const quick = await NostrCore.fetchEngagement(event.id);
        applyEngagement(quick);
      }
      const engagement = await NostrCore.fetchEngagement(event.id, focused);
      applyEngagement(engagement);
    } catch (error) {
      console.error('Failed to load engagement:', error);
    }
  };

  const applyEngagement = (engagement: {
    replies: number;
    reposts: number;
    likes: number;
    zapSats: number;
    myReaction: string | null;
    myRepost: boolean;
    myZapSats: number;
  }) => {
    const mine = mineRef.current;
    // Anything done here counts, whether or not the answer knows about it yet
    const myReactionMissing = Boolean(mine.reaction) && !engagement.myReaction;
    const myRepostMissing = mine.reposted && !engagement.myRepost;
    // A zap is counted from the receipt the recipient's provider publishes,
    // which arrives seconds after the money does — or never, from a provider
    // that publishes none. Until the total has grown by at least what was
    // paid from here, it is added on.
    const myZapMissing = mine.zapped > 0 && engagement.zapSats < mine.zapBaseline + mine.zapped;

    setReplyCount(engagement.replies);
    setRepostCount(engagement.reposts + (myRepostMissing ? 1 : 0));
    setReposted(engagement.myRepost || mine.reposted);
    setLikeCount(engagement.likes + (myReactionMissing ? 1 : 0));
    setZapSats(engagement.zapSats + (myZapMissing ? mine.zapped : 0));
    if (engagement.myZapSats > 0 || mine.zapped > 0) setZapped(true);
    const reaction = engagement.myReaction || mine.reaction;
    if (reaction) setReactionEmoji(reaction);
  };

  const loadMentionedProfiles = async () => {
    try {
      const mentions = extractMentions(noteContent);
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
    // A stream's address is a quotable reference like any other, and used to
    // be quoted as well as drawn: the card, and under it the live event
    // itself as a note — whose author is whatever service the stream runs
    // through. One stream, shown twice, the second time as a stranger.
    const withoutStreams = extractStreamRefs(noteContent).reduce(
      (text, { naddr }) => text.replace(new RegExp(`(?:nostr:)?${naddr}`, 'gi'), ''),
      noteContent
    );

    if (!quoteRefRegex('i').test(withoutStreams)) {
      setQuotedNoteStatus('none');
      return;
    }

    setQuotedNoteStatus('loading');
    setQuotedNoteRepostedBy(null);
    try {
      const resolved = await NostrCore.resolveQuoteReference(withoutStreams);
      if (resolved) {
        setQuotedNote(resolved.note);
        setQuotedNoteRepostedBy(resolved.repostedBy || null);
        setQuotedNoteStatus('loaded');
      } else {
        setQuotedNoteStatus('failed');
      }
    } catch (error) {
      console.error('Failed to load quoted note:', error);
      setQuotedNoteStatus('failed');
    }
  };

  const decodeNpub = (npubLink: string): string | null => {
    try {
      const decoded = nip19.decode(npubLink.replace(/^@/, '').replace(/^nostr:/i, ''));
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

    // The nostr: prefix is optional: many clients publish a bare "npub1…"
    // or write the mention as "@nprofile1…", and those were left as raw text
    const nprofileMatches = content.match(/@?(?:nostr:)?nprofile1[a-z0-9]{20,}/gi) || [];
    nprofileMatches.forEach(link => {
      const pubkey = decodeNprofile(link);
      if (pubkey) mentions.add(pubkey.toLowerCase());
    });

    const npubMatches = content.match(/@?(?:nostr:)?npub1[a-z0-9]{20,}/gi) || [];
    npubMatches.forEach(link => {
      const pubkey = decodeNpub(link);
      if (pubkey) mentions.add(pubkey.toLowerCase());
    });

    return Array.from(mentions);
  };

  const decodeNoteRef = (link: string): string | null => {
    try {
      const decoded = nip19.decode(link.replace(/^nostr:/i, ''));
      if (decoded.type === 'note' && typeof decoded.data === 'string') return decoded.data;
      if (decoded.type === 'nevent') return (decoded.data as { id: string }).id;
      return null;
    } catch {
      // Malformed bech32 — leave it as text
      return null;
    }
  };

  const decodeNprofile = (nprofileLink: string): string | null => {
    try {
      const decoded = nip19.decode(nprofileLink.replace(/^@/, '').replace(/^nostr:/i, ''));
      return decoded.type === 'nprofile' ? (decoded.data as { pubkey: string }).pubkey : null;
    } catch (error) {
      console.error('Failed to decode nprofile:', error);
      return null;
    }
  };

  const renderContentWithMentions = (content: string) => {
    // The note may define its own emoji (NIP-30), written as :shortcode:
    const emojis = customEmojiMap(event.tags);
    const asEmojiParts = (text: string, keyBase: string): React.ReactNode[] =>
      splitCustomEmoji(text, emojis).map((piece, index) => (
        piece.type === 'emoji'
          ? <img key={`${keyBase}-${index}`} src={piece.url} alt={`:${piece.value}:`} className="custom-emoji"  loading="lazy" decoding="async" />
          : <React.Fragment key={`${keyBase}-${index}`}>{piece.value}</React.Fragment>
      ));

    const parts: (string | React.ReactNode)[] = [];
    let lastIndex = 0;
    let keyIndex = 0;

    // nprofile, npub, raw hex pubkey — and note/nevent references, which
    // stayed as a wall of bech32 whenever they were not the one lifted out
    // into the quote card
    const combinedRegex = /(?:(@?(?:nostr:)?nprofile1[a-z0-9]{20,})|(@?(?:nostr:)?npub1[a-z0-9]{20,})|([a-fA-F0-9]{64})|((?:nostr:)?(?:note1|nevent1)[a-z0-9]{20,}))/gi;
    let match;

    while ((match = combinedRegex.exec(content)) !== null) {
      let pubkey: string | null = null;
      let noteId: string | null = null;

      if (match[1]) {
        // This is an nprofile link
        pubkey = decodeNprofile(match[1]);
      } else if (match[2]) {
        // This is an npub link
        pubkey = decodeNpub(match[2]);
      } else if (match[3]) {
        // This is a raw hex pubkey
        pubkey = match[3].toLowerCase();
      } else if (match[4]) {
        noteId = decodeNoteRef(match[4]);
      }

      if (noteId) {
        if (match.index > lastIndex) {
          parts.push(...asEmojiParts(content.substring(lastIndex, match.index), `pre-${keyIndex}`));
        }
        parts.push(
          <button
            key={`note-${keyIndex}-${noteId}`}
            onClick={(e) => { e.stopPropagation(); onNavigateToNote?.(noteId!); }}
            className="mention-link"
            title="Open the note this points at"
          >
            📝 View note
          </button>
        );
        lastIndex = match.index + match[0].length;
        keyIndex++;
        continue;
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
          withLinks.push(...asEmojiParts(piece.value, `text-${partIndex}-${pieceIndex}`));
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



  /**
   * A key kept in an extension or in a signer app answers when the person
   * says so, and sometimes never — the popup was missed, the app is asleep,
   * the pairing has lapsed. Nothing here can hurry that, but a button that
   * simply does nothing reads as broken, so it says what it is waiting for.
   */
  const beforeItIsSilly = async <T,>(work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout>;
    const patience = new Promise<never>((_, refuse) => {
      timer = setTimeout(
        () => refuse(new Error(
          'No answer from whatever holds your key. If it is a browser extension or a signer app, ' +
          'it may be waiting for you to approve this there.'
        )),
        20000
      );
    });
    try {
      return await Promise.race([work, patience]);
    } finally {
      clearTimeout(timer!);
    }
  };

  /**
   * Shown at once, then published.
   *
   * A publish waits on every relay it writes to, and a slow one holds the
   * whole thing for its five seconds — so a tap that only changed the screen
   * afterwards looked like it had missed. What is shown here is undone only
   * if the message genuinely landed nowhere, which is rare and worth saying
   * out loud when it happens.
   */
  const handleReaction = async (emoji: string) => {
    setShowReactions(false);

    const had = reactionEmoji;
    if (!had) setLikeCount(count => count + 1);
    mineRef.current.reaction = emoji;
    setReactionEmoji(emoji);

    try {
      const published = await beforeItIsSilly(NostrCore.addReaction(event.id, emoji, event.pubkey));
      if (!published) throw new Error('Reaction was not accepted by any relay — check your connection');
    } catch (error) {
      console.error('Failed to add reaction:', error);
      mineRef.current.reaction = had || null;
      setReactionEmoji(had);
      if (!had) setLikeCount(count => Math.max(0, count - 1));
      alert(error instanceof Error ? error.message : 'Failed to publish reaction');
    }
  };

  const handleRepost = async () => {
    setShowRepostOptions(false);
    if (reposted || reposting) return;

    // Same as a reaction: on screen now, taken back only if it landed nowhere
    setReposting(true);
    mineRef.current.reposted = true;
    setReposted(true);
    setRepostCount(count => count + 1);

    try {
      const published = await beforeItIsSilly(NostrCore.repostEvent(event));
      if (!published) throw new Error('Repost was not accepted by any relay — check your connection');
    } catch (error) {
      console.error('Failed to repost:', error);
      mineRef.current.reposted = false;
      setReposted(false);
      setRepostCount(count => Math.max(0, count - 1));
      alert(error instanceof Error ? error.message : 'Failed to repost');
    } finally {
      setReposting(false);
    }
  };

  const toggleBookmark = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (bookmarking) return;
    setBookmarking(true);
    // Shown as done straight away; put back if the relays refuse it
    const wanted = !bookmarked;
    setBookmarked(wanted);
    try {
      if (wanted) await NostrCore.addBookmark(event.id);
      else await NostrCore.removeBookmark(event.id);
    } catch (error) {
      setBookmarked(!wanted);
      alert(error instanceof Error ? error.message : 'Could not update your bookmarks');
    } finally {
      setBookmarking(false);
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
    <div className="event-card" ref={cardRef}>
      <div className="event-header">
        <div className="event-author-info">
          <ProfileHoverCard
            pubkey={event.pubkey}
            profile={profile}
            onNavigateToProfile={onNavigateToProfile}
            onBlocked={() => onRefresh?.()}
          >
            {displayPicture ? (
              <img
                src={displayPicture}
                alt={displayName}
                className="author-avatar"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
                              loading="lazy"
                decoding="async"
              />
            ) : (
              <div className="author-avatar-placeholder">
                {displayName.charAt(0).toUpperCase()}
              </div>
            )}
          </ProfileHoverCard>
          <div className="author-details">
            <ProfileHoverCard
              pubkey={event.pubkey}
              profile={profile}
              onNavigateToProfile={onNavigateToProfile}
              onBlocked={() => onRefresh?.()}
            >
              <button
                className="author-name"
                onClick={() => onNavigateToProfile(event.pubkey)}
              >
                <EmojiText text={displayName} emojis={profile?.emojis} />
              </button>
            </ProfileHoverCard>
            <div className="author-handle">
              {profile?.nip05
                ? <Nip05Handle nip05={profile.nip05} pubkey={event.pubkey} />
                : formatAddress(event.pubkey)}
            </div>
          </div>
        </div>
        <div className="event-timestamp">
          {formatDate(new Date(event.created_at * 1000))}
        </div>
      </div>

      <div
        className="event-content"
        onClick={() => {
          if (isArticle && articleNaddr) navigate(`/a/${articleNaddr}`);
          else onNavigateToNote?.(event.id);
        }}
        style={{ cursor: 'pointer' }}
      >
        {/* A long-form article (NIP-23) is a different shape of thing: a
            title, a picture, a summary and a body written in markdown. Opened
            it is read in full; in a feed it is a card with the summary, since
            an article inlined whole would be the whole feed. */}
        {isArticle && (
          <div className="event-article">
            {article.image && (
              <img className="event-article-image" src={article.image} alt="" loading="lazy" decoding="async" />
            )}
            {article.title && <h2 className="event-article-title">{article.title}</h2>}
            {focused ? (
              <Markdown
                content={event.content}
                emojis={profile?.emojis}
                onNavigateToProfile={onNavigateToProfile}
                onNavigateToNote={onNavigateToNote}
                onNavigateToTopic={onNavigateToTopic}
              />
            ) : (
              <p className="event-article-summary">
                {article.summary || `${event.content.replace(/[#*>`_[\]]/g, '').slice(0, 240).trim()}…`}
              </p>
            )}
          </div>
        )}
        {!isArticle && (() => {
          const stripped = stripMediaUrls(noteContent);
          if (!stripped) return null;
          const isLong = stripped.length > CONTENT_TRUNCATE_LENGTH;
          const displayText = isLong && !expanded
            ? `${stripped.slice(0, CONTENT_TRUNCATE_LENGTH).trimEnd()}…`
            : stripped;
          return (
            <>
              <p>{renderContentWithMentions(displayText)}</p>
              {isLong && (
                <button
                  type="button"
                  className="content-toggle-btn"
                  onClick={(e) => { e.stopPropagation(); setExpanded(v => !v); }}
                >
                  {expanded ? 'Show less' : 'Show more'}
                </button>
              )}
            </>
          );
        })()}
        {event.kind === EVENT_KINDS.POLL && (() => {
          const isZapPoll = event.tags.find(t => t[0] === 'polltype')?.[1] === 'zap';
          const endsAtTag = event.tags.find(t => t[0] === 'endsAt')?.[1];
          const isClosed = !!endsAtTag && Number(endsAtTag) * 1000 <= Date.now();
          const { counts, total, myVote } = tallyPollVotes(pollResponses);
          // Zap-weighted voting isn't implemented yet — those polls just
          // show the static option list. Otherwise, reveal result bars
          // once you've voted or the poll has closed; before that, options
          // are clickable buttons.
          const showResults = isZapPoll || isClosed || myVote !== null;

          return (
            <div className="poll-display">
              <div className="poll-display-options">
                {event.tags.filter(t => t[0] === 'option').map((t) => {
                  const optionId = t[1];
                  const label = t[2];

                  if (showResults) {
                    const count = counts[optionId] || 0;
                    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
                    const isMine = myVote === optionId;
                    return (
                      <div
                        className={`poll-display-option poll-result ${isMine ? 'poll-result-mine' : ''}`}
                        key={optionId}
                      >
                        <div className="poll-result-bar" style={{ width: `${pct}%` }} />
                        <span className="poll-result-label">{label}{isMine && ' ✓'}</span>
                        <span className="poll-result-pct">{pct}%</span>
                      </div>
                    );
                  }

                  return (
                    <button
                      type="button"
                      className="poll-display-option poll-option-vote"
                      key={optionId}
                      disabled={votingOption !== null}
                      onClick={(e) => { e.stopPropagation(); handleVote(optionId); }}
                    >
                      {votingOption === optionId ? 'Voting…' : label}
                    </button>
                  );
                })}
              </div>
              <div className="poll-display-meta">
                {isZapPoll ? (
                  <span><ZapIcon className="poll-display-meta-icon" /> Zap Poll (voting coming soon)</span>
                ) : (
                  <span><PersonIcon className="poll-display-meta-icon" /> {total} {total === 1 ? 'vote' : 'votes'}</span>
                )}
                {endsAtTag && (
                  <span className="poll-display-ends">
                    {' · '}{isClosed ? 'Poll ended' : `Ends ${formatDate(new Date(Number(endsAtTag) * 1000))}`}
                  </span>
                )}
              </div>
            </div>
          );
        })()}
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
        {(extractImageUrls(noteContent).length > 0 ||
          extractVideoUrls(noteContent).length > 0 ||
          extractStreamUrls(noteContent).length > 0 ||
          extractStreamRefs(noteContent).length > 0 ||
          extractEmbeds(noteContent).length > 0) && (
          <div className={`sensitive-media-wrapper ${isSensitive && !mediaRevealed ? 'blurred' : ''}`}>
            {isSensitive && !mediaRevealed && (
              <button
                type="button"
                className="sensitive-media-overlay"
                onClick={(e) => { e.stopPropagation(); setMediaRevealed(true); }}
              >
                <span className="sensitive-media-icon">⚠️</span>
                <span>
                  Sensitive content{contentWarningTag?.[1] ? `: ${contentWarningTag[1]}` : ''}
                </span>
                <span className="sensitive-media-hint">Click to view</span>
              </button>
            )}

            {extractImageUrls(noteContent).length > 0 && (() => {
              const images = extractImageUrls(noteContent);
              const hasMore = images.length > IMAGE_PREVIEW_LIMIT;
              const visibleImages = showAllImages ? images : images.slice(0, IMAGE_PREVIEW_LIMIT);
              return (
                <>
                  {/* The count decides the arrangement, and CSS cannot count
                      its own children without :has(), which the browser OBS
                      embeds may be too old for */}
                  <div className="event-images" data-count={Math.min(visibleImages.length, 4)}>
                    {visibleImages.map((imageUrl, index) => {
                      // One picture is the post's body and takes the width of
                      // the card, leaving barely a line of text to open the
                      // post with — so clicking it opens the post, and the
                      // corner button enlarges. Several are a set to choose
                      // from, where picking one is the point.
                      const single = visibleImages.length === 1;
                      return (
                        <button
                          key={index}
                          className="event-image-preview"
                          onClick={(e) => {
                            if (isSensitive && !mediaRevealed) {
                              e.stopPropagation();
                              return;
                            }
                            if (single) return; // the card's own click opens the post
                            e.stopPropagation();
                            setEnlargedIndex(index);
                          }}
                          style={{ border: 'none', padding: 0, background: 'none', cursor: 'pointer' }}
                        >
                          <img
                            src={imageUrl}
                            alt={`Note image ${index + 1}`}
                            onError={(e) => {
                              (e.target as HTMLImageElement).style.display = 'none';
                            }}
                                                      loading="lazy"
                            decoding="async"
                          />
                          {single && (!isSensitive || mediaRevealed) && (
                            <span
                              className="event-image-zoom"
                              title="Enlarge the picture"
                              onClick={(e) => { e.stopPropagation(); setEnlargedIndex(index); }}
                            >
                              ⤢
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  {hasMore && (!isSensitive || mediaRevealed) && (
                    <button
                      type="button"
                      className="content-toggle-btn"
                      onClick={(e) => { e.stopPropagation(); setShowAllImages(v => !v); }}
                    >
                      {showAllImages ? 'Show fewer images' : `Show ${images.length - IMAGE_PREVIEW_LIMIT} more images`}
                    </button>
                  )}
                </>
              );
            })()}
            {extractVideoUrls(noteContent).length > 0 && (
              <div className="event-videos" onClick={(e) => e.stopPropagation()}>
                {extractVideoUrls(noteContent).map((videoUrl) => (
                  <VideoPlayer key={videoUrl} src={videoUrl} className="event-video" />
                ))}
              </div>
            )}
            {extractStreamUrls(noteContent).length > 0 && (
              <div className="event-videos" onClick={(e) => e.stopPropagation()}>
                {extractStreamUrls(noteContent).map((streamUrl) => (
                  <InlineStreamPlayer key={streamUrl} src={streamUrl} className="event-video" />
                ))}
              </div>
            )}
            {extractStreamRefs(noteContent).length > 0 && (
              <div className="event-videos" onClick={(e) => e.stopPropagation()}>
                {extractStreamRefs(noteContent).map(({ url, naddr }) => (
                  <InlineLiveStream key={naddr} naddr={naddr} href={url} />
                ))}
              </div>
            )}
            {extractEmbeds(noteContent).length > 0 && (
              <div className="event-videos" onClick={(e) => e.stopPropagation()}>
                {extractEmbeds(noteContent).map((embed) => (
                  <MediaEmbed key={`${embed.kind}:${embed.id}`} embed={embed} />
                ))}
              </div>
            )}
          </div>
        )}
        {extractImageUrls(noteContent).length === 0 &&
          extractVideoUrls(noteContent).length === 0 &&
          extractEmbeds(noteContent).length === 0 &&
          extractPreviewLinkUrl(noteContent) && (
            <div onClick={(e) => e.stopPropagation()}>
              <LinkPreviewCard url={extractPreviewLinkUrl(noteContent)!} />
            </div>
        )}
      </div>

      {quotedNoteStatus === 'loading' && (
        <div className="quoted-note-status">Loading quoted post…</div>
      )}

      {quotedNoteStatus === 'failed' && (
        <div className="quoted-note-status">⚠️ Quoted post unavailable</div>
      )}

      {quotedNote && (
        <QuotedNoteCard
          event={quotedNote}
          repostedBy={quotedNoteRepostedBy}
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

        <div className="reaction-container repost-container" ref={repostMenu.containerRef}>
          <button
            ref={repostMenu.triggerRef}
            className={`action-btn ${reposted ? 'reposted' : ''}`}
            onClick={() => {
              if (showRepostOptions) {
                setShowRepostOptions(false);
                return;
              }
              repostMenu.openPopup();
              setShowRepostOptions(true);
            }}
            disabled={reposting}
            title={reposted ? 'You reposted this' : 'Repost or quote'}
          >
            <RepostIcon className="action-icon" filled={reposted} />
            <span className="action-count">{repostCount}</span>
          </button>
          {showRepostOptions && (
            <div className="reply-options-menu" ref={repostMenu.popupRef} style={repostMenu.style}>
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

        <div className="reaction-container" ref={reactionPicker.containerRef}>
          <button
            ref={reactionPicker.triggerRef}
            className={`action-btn ${reactionEmoji ? 'liked' : ''}`}
            onClick={() => {
              if (showReactions) {
                setShowReactions(false);
                return;
              }
              reactionPicker.openPopup();
              setShowReactions(true);
            }}
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
            <div className="reactions-menu" ref={reactionPicker.popupRef} style={reactionPicker.style}>
              <EmojiPicker onSelect={(emoji) => { handleReaction(emoji); setShowReactions(false); }} />
            </div>
          )}
        </div>

        <ZapButton
          lud16={profile?.lud16}
          recipientPubkey={event.pubkey}
          recipientName={displayName}
          recipientEmojis={profile?.emojis}
          recipientPicture={profile?.picture}
          eventId={event.id}
          triggerClassName={`action-btn ${zapped ? 'zapped' : ''}`}
          triggerTitle={zapped ? 'You zapped this — zap again' : 'Zap with lightning'}
          onPaid={(sats) => {
            const mine = mineRef.current;
            if (mine.zapped === 0) mine.zapBaseline = zapSats;
            mine.zapped += sats;
            setZapSats(total => total + sats);
            setZapped(true);
            // Kept for the next time this note is drawn, receipt or no receipt
            NostrCore.rememberOwnZap(event.id, sats);
            // And ask again shortly, for the receipt itself: once it lands,
            // the count above stops being a local guess
            window.setTimeout(() => { void loadEngagement(); }, 6000);
            window.setTimeout(() => { void loadEngagement(); }, 20000);
          }}
        >
          <ZapIcon className="action-icon" filled={zapped || zapSats > 0} />
          <span className="action-count">{formatSats(zapSats)}</span>
        </ZapButton>

        {/* Only for someone with a list to keep it in */}
        {CredentialManager.isLoggedIn() && (
          <button
            className={`action-btn ${bookmarked ? 'bookmarked' : ''}`}
            onClick={toggleBookmark}
            disabled={bookmarking}
            title={bookmarked ? 'Remove from bookmarks' : 'Bookmark'}
          >
            <BookmarkIcon className="action-icon" filled={bookmarked} />
          </button>
        )}
      </div>

      {/* Under the actions: where the note actually lives. A note is on
          whichever relays happen to carry it, which is worth seeing rather
          than guessing — and for one written here, this is where it landed. */}
      <RelayBadges eventId={event.id} refreshKey={replyCount} />

      {composeMode && (
        <ComposeModal
          title={composeMode === 'reply' ? 'Reply' : 'Quote'}
          replyTo={composeMode === 'reply' ? event.id : undefined}
          quoteNoteId={composeMode === 'quote' ? event.id : undefined}
          context={{ authorName: displayName, authorPicture: displayPicture, content: noteContent }}
          onClose={() => setComposeMode(null)}
          onPublished={handleComposePublished}
        />
      )}

      {enlargedIndex !== null && (() => {
        const images = extractImageUrls(noteContent);
        const currentUrl = images[enlargedIndex];
        const hasPrev = enlargedIndex > 0;
        const hasNext = enlargedIndex < images.length - 1;

        return (
          <div className="image-modal" onClick={() => setEnlargedIndex(null)}>
            {hasPrev && (
              <button
                className="image-modal-nav image-modal-prev"
                onClick={(e) => { e.stopPropagation(); setEnlargedIndex(i => (i ?? 0) - 1); }}
                title="Previous image"
              >
                ‹
              </button>
            )}
            <div className="image-modal-content" onClick={(e) => e.stopPropagation()}>
              <button className="image-modal-close" onClick={() => setEnlargedIndex(null)}>
                ✕
              </button>
              <img src={currentUrl} alt="Enlarged" className="image-modal-img"  loading="lazy" decoding="async" />
              {images.length > 1 && (
                <div className="image-modal-counter">{enlargedIndex + 1} / {images.length}</div>
              )}
            </div>
            {hasNext && (
              <button
                className="image-modal-nav image-modal-next"
                onClick={(e) => { e.stopPropagation(); setEnlargedIndex(i => (i ?? 0) + 1); }}
                title="Next image"
              >
                ›
              </button>
            )}
          </div>
        );
      })()}
    </div>
  );
};

export default EventCard;
