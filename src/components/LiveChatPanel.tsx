import React, { useEffect, useRef, useState } from 'react';
import { NostrEventSigned, UserProfile, EVENT_KINDS } from '../types';
import { NostrCore } from '../nostr/core';
import { CredentialManager } from '../nostr/crypto';
import RichText from './RichText';
import { formatAddress } from '../utils/helpers';
import { resolveMentionHandles, handleFromName, detectMentionTrigger } from '../utils/mentions';
import { EventCache } from '../nostr/core';
import EmojiPicker from './EmojiPicker';
import ZapButton from './ZapButton';
import { ZapIcon } from './Icons';
import { useAnchoredPopup } from '../hooks/useAnchoredPopup';
import LiveChatReactions, { ReactionTally } from './LiveChatReactions';
import EmojiText from './EmojiText';
import ProfileHoverCard from './ProfileHoverCard';

/**
 * NIP-25 reactions carry '+' for a like and '-' for a dislike rather than an
 * emoji, and an empty content is treated as a like too — so all of those pile
 * up under one 👍 instead of sitting apart. Anything else is shown as sent.
 */
const normalizeReaction = (content: string): string => {
  const trimmed = content.trim();
  if (trimmed === '' || trimmed === '+') return '👍';
  if (trimmed === '-') return '👎';
  return trimmed.slice(0, 20);
};

/**
 * NIP-30: a reaction may be a `:shortcode:` whose picture is named by an
 * `emoji` tag on the same event. Without this the chip reads ":blobDance:".
 */
const customEmojiUrl = (reaction: NostrEventSigned, shortcode: string): string | undefined => {
  const name = shortcode.replace(/^:|:$/g, '');
  return reaction.tags.find(t => t[0] === 'emoji' && t[1] === name)?.[2];
};

export interface PresentPerson {
  pubkey: string;
  name: string;
  picture?: string;
}

interface TimelineEntry {
  kind: 'message' | 'zap';
  event: NostrEventSigned;
  /** For a zap this is the payer, not the event's signer */
  author: string | null;
  /** Zaps only: who was paid */
  recipient: string | null;
  sats: number;
}

interface LiveChatPanelProps {
  address: string;
  relayHint?: string;
  disabled?: boolean;
  onNavigateToProfile: (pubkey: string) => void;
  onNavigateToNote: (noteId: string) => void;
  onNavigateToTopic?: (topic: string) => void;
  /** Loading before the relays are up finds nothing and never retries */
  relaysConnected?: boolean;
  /** Given only where a second window makes sense — not in that window itself */
  onPopOut?: () => void;
  /** Who runs this stream: they can mute someone for everyone watching here */
  owners?: string[];
  /** The stream's `d` tag, which names its mute list */
  identifier?: string;
  /** Drop the message box: nobody can type into a stream overlay */
  hideComposer?: boolean;
  /** Offer this address for copying — the chat as an OBS browser source */
  obsLink?: string;
  /**
   * Who is present, most recently heard from first. Nobody publishes a
   * viewer list — a live event carries one 'p' tag, the host — so the people
   * in the chat are the only ones a client can actually show.
   */
  onPeoplePresent?: (people: PresentPerson[]) => void;
  /** Overlay preview: given only where the choice is the viewer's to make */
  transparent?: boolean;
  bold?: boolean;
  onDisplayChange?: (opts: { transparent: boolean; bold: boolean }) => void;
}

const LiveChatPanel: React.FC<LiveChatPanelProps> = ({ address, relayHint, disabled, onNavigateToProfile, onNavigateToNote, onNavigateToTopic, relaysConnected = true, onPopOut, onPeoplePresent, hideComposer, obsLink, owners = [], identifier, transparent, bold, onDisplayChange }) => {
  const [messages, setMessages] = useState<NostrEventSigned[]>([]);
  const [zaps, setZaps] = useState<NostrEventSigned[]>([]);
  const [reactions, setReactions] = useState<NostrEventSigned[]>([]);
  const [profiles, setProfiles] = useState<Map<string, UserProfile>>(new Map());
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [obsLinkCopied, setObsLinkCopied] = useState(false);
  // The mute list this account already keeps (NIP-51), which the chat was
  // the one place that ignored — someone muted everywhere else went on
  // talking here
  const [muted, setMuted] = useState<Set<string>>(() => new Set(NostrCore.getBlockedPubkeys()));
  // Whoever the stream's owner has thrown out — hidden for everyone watching
  // through this client, not only for whoever muted them
  const [streamMuted, setStreamMuted] = useState<Set<string>>(new Set());
  // The owner's own view of that list: muting someone hides their messages,
  // which is also the only place their name was to click on
  const [showStreamMuted, setShowStreamMuted] = useState(false);
  const [streamMutedProfiles, setStreamMutedProfiles] = useState<Map<string, UserProfile>>(new Map());
  // Handles typed into the box stand in for pubkeys until the message is
  // sent, the same way the compose box does it — the chat shows "@Name",
  // the published message carries the reference
  const mentions = useRef<Map<string, string>>(new Map());
  // Typing "@" offers people to tag, the same as the compose box
  const [mentionStart, setMentionStart] = useState<number | null>(null);
  const [mentionQuery, setMentionQuery] = useState('');
  const [suggestions, setSuggestions] = useState<UserProfile[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const profilesRef = useRef<Map<string, UserProfile>>(new Map());
  const isLoggedIn = CredentialManager.isLoggedIn();
  profilesRef.current = profiles;

  // The panel clips anything that reaches outside it, and the picker is wider
  // than the button it hangs off — anchored in CSS it was cut to a strip
  const emoji = useAnchoredPopup(showEmojiPicker, () => setShowEmojiPicker(false));
  const myPubkey = CredentialManager.getPublicKey();
  const iRunThisStream = !!myPubkey && owners.includes(myPubkey);

  // Historical messages, then a live subscription for new ones — same
  // pattern as the home feed: a REQ with `since` replays what's stored and
  // keeps streaming new matches as they're published, no polling needed.
  useEffect(() => {
    // In a popped-out window the relays start from scratch, so loading on
    // mount asked before anything was connected and came back empty — with
    // no reason to ever ask again
    if (!relaysConnected) return;

    let cancelled = false;
    let subId: string | null = null;

    (async () => {
      const [history, zapHistory] = await Promise.all([
        NostrCore.fetchLiveChatMessages(address),
        NostrCore.fetchLiveZaps(address)
      ]);
      if (cancelled) return;
      setMessages(history);
      setZaps(zapHistory);

      const zapParties = zapHistory
        .flatMap(zap => [NostrCore.zapSenderPubkey(zap), NostrCore.zapRecipientPubkey(zap)])
        .filter((pubkey): pubkey is string => !!pubkey);
      const profileMap = await NostrCore.fetchProfiles([
        ...history.map(m => m.pubkey),
        ...zapParties
      ]);
      if (!cancelled) setProfiles(profileMap);

      const since = Math.floor(Date.now() / 1000);
      subId = NostrCore.subscribeLive(
        [{
          kinds: [EVENT_KINDS.LIVE_CHAT_MESSAGE, EVENT_KINDS.ZAP_RECEIPT],
          '#a': [address],
          since
        }],
        async (event) => {
          // A zap receipt is signed by the wallet, so the person to name
          // and to look up is the one inside the zap request it carries
          const isZap = event.kind === EVENT_KINDS.ZAP_RECEIPT;
          // A receipt with no invoice and no request behind it has nothing
          // to say — see NostrCore.zapIsShowable
          if (isZap && !NostrCore.zapIsShowable(event)) return;

          const author = isZap ? NostrCore.zapSenderPubkey(event) : event.pubkey;
          const recipient = isZap ? NostrCore.zapRecipientPubkey(event) : null;

          const add = isZap ? setZaps : setMessages;
          add(prev => (prev.some(e => e.id === event.id) ? prev : [...prev, event]));

          const unknown = [author, recipient]
            .filter((pubkey): pubkey is string => !!pubkey && !profilesRef.current.has(pubkey));
          if (unknown.length) {
            const fetched = await NostrCore.fetchProfiles(unknown);
            setProfiles(prev => new Map([...prev, ...fetched]));
          }
        }
      );
    })();

    return () => {
      cancelled = true;
      if (subId) NostrCore.unsubscribeLive(subId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, relaysConnected]);

  useEffect(() => {
    if (!relaysConnected || !identifier || owners.length === 0) return;
    let cancelled = false;
    NostrCore.fetchStreamMuteList(owners, identifier).then(list => {
      if (!cancelled) setStreamMuted(list);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relaysConnected, identifier, owners.join(',')]);

  // Names for the list, once there is one to show
  useEffect(() => {
    if (!showStreamMuted || streamMuted.size === 0) return;
    let cancelled = false;
    NostrCore.fetchProfiles([...streamMuted]).then(found => {
      if (!cancelled) setStreamMutedProfiles(found);
    });
    return () => { cancelled = true; };
  }, [showStreamMuted, streamMuted]);

  const unmuteForEveryone = async (target: string) => {
    if (!identifier) return;
    try {
      const updated = await NostrCore.setStreamMuted(address, identifier, target, false);
      setStreamMuted(updated);
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Could not update the stream mute list');
    }
  };

  const setMutedForEveryone = async (author: string, name: string) => {
    if (!identifier) return;
    if (!window.confirm(`Mute ${name} for everyone watching this stream here?`)) return;
    try {
      const updated = await NostrCore.setStreamMuted(address, identifier, author, true);
      setStreamMuted(updated);
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Could not update the stream mute list');
    }
  };

  // Reactions are tagged with the message they are about, not with the
  // stream, so they need a subscription of their own. Re-subscribing every
  // few messages keeps newly arrived ones covered without a fresh query per
  // message; with no `since`, one subscription brings both the existing
  // reactions and the ones that follow.
  const reactionBatch = Math.ceil(messages.length / 5);
  useEffect(() => {
    if (!relaysConnected || messages.length === 0) return;

    const ids = messages.slice(-60).map(m => m.id);
    const subId = NostrCore.subscribeLive(
      [{ kinds: [EVENT_KINDS.REACTION], '#e': ids }],
      (event) => setReactions(prev => (prev.some(r => r.id === event.id) ? prev : [...prev, event]))
    );
    return () => NostrCore.unsubscribeLive(subId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, relaysConnected, reactionBatch]);

  // Grouped per message and per emoji, so a message can show "😂 3"
  const talliesByMessage = new Map<string, ReactionTally[]>();
  for (const reaction of reactions) {
    // NIP-25: the last 'e' tag is the event being reacted to
    const target = [...reaction.tags].reverse().find(t => t[0] === 'e')?.[1];
    if (!target) continue;
    const emojiUsed = normalizeReaction(reaction.content);
    if (!emojiUsed) continue;

    const tallies = talliesByMessage.get(target) || [];
    const existing = tallies.find(t => t.emoji === emojiUsed);
    if (existing) {
      existing.count += 1;
      existing.mine = existing.mine || reaction.pubkey === myPubkey;
      existing.image = existing.image || customEmojiUrl(reaction, emojiUsed);
    } else {
      tallies.push({
        emoji: emojiUsed,
        count: 1,
        mine: reaction.pubkey === myPubkey,
        image: customEmojiUrl(reaction, emojiUsed)
      });
    }
    talliesByMessage.set(target, tallies);
  }

  // Busiest first, and alphabetical among equals — otherwise the row is in
  // whatever order the relays happened to answer in, and reshuffles on reload
  for (const tallies of talliesByMessage.values()) {
    tallies.sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));
  }

  const react = async (messageId: string, authorPubkey: string, emojiUsed: string) => {
    const sent = await NostrCore.addReaction(messageId, emojiUsed, authorPubkey);
    if (sent) {
      // Shown at once: the relays would echo it back, but not always quickly
      setReactions(prev => (prev.some(r => r.id === sent.id) ? prev : [...prev, sent]));
    } else {
      alert('Reaction was not accepted by any relay');
    }
  };

  // Stick to the bottom as new messages come in
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages.length, zaps.length]);


  const insertEmoji = (emoji: string) => {
    const inputEl = inputRef.current;
    if (!inputEl) {
      setInput(current => current + emoji);
      return;
    }

    const start = inputEl.selectionStart ?? input.length;
    const end = inputEl.selectionEnd ?? input.length;
    const next = input.slice(0, start) + emoji + input.slice(end);
    setInput(next);

    requestAnimationFrame(() => {
      inputEl.focus();
      const cursor = start + emoji.length;
      inputEl.setSelectionRange(cursor, cursor);
    });
  };

  // Whoever is in this chat first — they are who you are most likely
  // answering — then anyone else the client knows, then the relays
  useEffect(() => {
    if (mentionStart === null) return;

    const query = mentionQuery.toLowerCase();
    const matches = (profile: UserProfile) =>
      [profile.name, profile.display_name, profile.nip05]
        .filter(Boolean).join(' ').toLowerCase().includes(query);

    const here = Array.from(profiles.values()).filter(matches);
    const known = EventCache.getAllProfiles().filter(
      p => matches(p) && !here.some(inChat => inChat.pubkey === p.pubkey)
    );
    setSuggestions([...here, ...known].slice(0, 5));

    if (!mentionQuery.trim()) return;
    const timer = setTimeout(async () => {
      try {
        const results = await NostrCore.searchProfiles(mentionQuery.trim(), 5);
        if (results.length) setSuggestions(current => (current.length ? current : results));
      } catch (error) {
        console.error('Failed to load mention suggestions:', error);
      }
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mentionQuery, mentionStart]);

  const closeSuggestions = () => {
    setMentionStart(null);
    setMentionQuery('');
    setSuggestions([]);
  };

  const chooseSuggestion = (profile: UserProfile) => {
    if (mentionStart === null) return;
    const cursor = inputRef.current?.selectionStart ?? input.length;
    const handle = handleFromName(
      profile.name || profile.display_name || profile.nip05 || '',
      formatAddress(profile.pubkey)
    );
    const text = `@${handle} `;
    setInput(input.slice(0, mentionStart) + text + input.slice(cursor));
    mentions.current.set(handle, profile.pubkey);
    closeSuggestions();

    requestAnimationFrame(() => {
      inputRef.current?.focus();
      const at = mentionStart + text.length;
      inputRef.current?.setSelectionRange(at, at);
    });
  };

  const mute = async (author: string, name: string) => {
    if (!window.confirm(`Mute ${name}? Their messages disappear from the chat, here and in your feed.`)) return;
    try {
      await NostrCore.blockUser(author);
      setMuted(current => new Set(current).add(author));
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Could not mute this account');
    }
  };

  const tagAuthor = (author: string, name: string) => {
    const handle = handleFromName(name, formatAddress(author));
    mentions.current.set(handle, author);
    setInput(current => {
      const spaced = current && !current.endsWith(' ') ? `${current} ` : current;
      return `${spaced}@${handle} `;
    });
    inputRef.current?.focus();
  };


  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const content = input.trim();
    if (!content || sending) return;

    setSending(true);
    try {
      const { content: resolved, mentioned } = resolveMentionHandles(content, mentions.current);
      const sent = await NostrCore.publishLiveChatMessage(address, relayHint, resolved, mentioned);
      if (sent) {
        setInput('');
        mentions.current.clear();
        closeSuggestions();
        setMessages(prev => (prev.some(m => m.id === sent.id) ? prev : [...prev, sent]));
      } else {
        alert('Message was not accepted by any relay — check your connection');
      }
    } catch (error) {
      console.error('Failed to send chat message:', error);
      alert(error instanceof Error ? error.message : 'Failed to send message');
    } finally {
      setSending(false);
    }
  };


  // Anyone who has spoken or zapped, newest first — the panel already holds
  // both, so presence costs nothing extra to work out
  const present: PresentPerson[] = (() => {
    const seen = new Map<string, PresentPerson>();
    const speakers = [
      ...messages.map(m => m.pubkey),
      ...zaps.map(z => NostrCore.zapSenderPubkey(z))
    ];
    for (const pubkey of [...messages].reverse().map(m => m.pubkey).concat(
      speakers.filter((p): p is string => !!p)
    )) {
      if (!pubkey || seen.has(pubkey)) continue;
      const profile = profiles.get(pubkey);
      seen.set(pubkey, {
        pubkey,
        name: profile?.display_name || profile?.name || formatAddress(pubkey),
        picture: profile?.picture
      });
    }
    return [...seen.values()];
  })();

  const presenceKey = present.map(p => p.pubkey).join(',');
  useEffect(() => {
    onPeoplePresent?.(present);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presenceKey, profiles]);

  // Messages and zaps are two separate subscriptions but one conversation,
  // so they are interleaved by time the way the room actually experienced them
  const timeline: TimelineEntry[] = [
    ...messages.map((event): TimelineEntry => ({
      kind: 'message',
      event,
      author: event.pubkey,
      recipient: null,
      sats: 0
    })),
    ...zaps.map((event): TimelineEntry => ({
      kind: 'zap',
      event,
      author: NostrCore.zapSenderPubkey(event),
      recipient: NostrCore.zapRecipientPubkey(event),
      sats: NostrCore.parseZapAmountSats(event)
    }))
  ]
    .filter(entry => !entry.author || (!muted.has(entry.author) && !streamMuted.has(entry.author)))
    .sort((a, b) => (a.event.created_at || 0) - (b.event.created_at || 0));

  return (
    <div className="live-chat-panel">
      <div className="live-chat-header">
        <span>Stream Chat</span>
        {/* Shows what an OBS source would look like, and decides what the
            copied address says */}
        {iRunThisStream && streamMuted.size > 0 && (
          <button
            type="button"
            className="live-chat-obs-btn"
            title="Everyone you have muted in this chat"
            onClick={() => setShowStreamMuted(open => !open)}
          >
            🚫 {streamMuted.size}
          </button>
        )}

        {onDisplayChange && (
          <span className="live-chat-display-toggles">
            <label title="Preview the chat with no background, for laying over the video">
              <input
                type="checkbox"
                checked={!!transparent}
                onChange={(e) => onDisplayChange({ transparent: e.target.checked, bold: !!bold })}
              />
              Transparent
            </label>
            <label title="Heavier text, which carries better over a picture">
              <input
                type="checkbox"
                checked={!!bold}
                onChange={(e) => onDisplayChange({ transparent: !!transparent, bold: e.target.checked })}
              />
              Bold
            </label>
          </span>
        )}

        {/* The address for OBS is this window's own, plus whichever
            background was chosen — nowhere else to read it off */}
        {obsLink && (
          <button
            type="button"
            className="live-chat-obs-btn"
            title="Copy this window's address — with the options chosen here — for an OBS browser source"
            onClick={async () => {
              await navigator.clipboard.writeText(obsLink);
              setObsLinkCopied(true);
              setTimeout(() => setObsLinkCopied(false), 2000);
            }}
          >
            {obsLinkCopied ? '✓ Copied' : '🔗 Copy link'}
          </button>
        )}
        {onPopOut && (
          <button
            type="button"
            className="live-chat-popout"
            title="Open the chat in its own window"
            onClick={onPopOut}
          >
            ⧉ Pop out
          </button>
        )}
      </div>
      {showStreamMuted && iRunThisStream && (
        <div className="live-chat-muted-list">
          {[...streamMuted].map(target => {
            const profile = streamMutedProfiles.get(target);
            const label = profile?.display_name || profile?.name || formatAddress(target);
            return (
              <div key={target} className="live-chat-muted-row">
                {/* The same card as on a name in the feed — who they are and
                    what can be done about them, without leaving the stream */}
                <ProfileHoverCard
                  pubkey={target}
                  profile={profile}
                  openOnClick
                  escapesClipping
                  extraAction={{ label: 'Unmute', onClick: () => unmuteForEveryone(target) }}
                  onNavigateToProfile={onNavigateToProfile}
                >
                  <button type="button" className="live-chat-author">
                    <EmojiText text={label} emojis={profile?.emojis} />
                  </button>
                </ProfileHoverCard>
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  onClick={() => unmuteForEveryone(target)}
                >
                  Unmute
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="live-chat-messages" ref={listRef}>
        {timeline.length === 0 && (
          <div className="live-chat-empty">No messages yet — say hello!</div>
        )}
        {timeline.map(entry => {
          const event = entry.event;
          const author = entry.author;
          const profile = author ? profiles.get(author) : undefined;
          const name = profile?.display_name || profile?.name
            || (author ? formatAddress(author) : 'Someone');

          const avatar = profile?.picture ? (
            <img src={profile.picture} alt="" className="live-chat-avatar" />
          ) : (
            <div className="live-chat-avatar-placeholder">{name.charAt(0).toUpperCase()}</div>
          );

          // A zap is an event in the room, not a message: who paid whom, how
          // much, and whatever the sender said with it
          if (entry.kind === 'zap') {
            const comment = NostrCore.zapComment(event);
            const recipient = entry.recipient;
            const recipientProfile = recipient ? profiles.get(recipient) : undefined;
            const recipientName = recipientProfile?.display_name || recipientProfile?.name
              || (recipient ? formatAddress(recipient) : '');
            return (
              <div key={event.id} className="live-chat-zap">
                {avatar}
                <div className="live-chat-message-body">
                  <span className="live-chat-zap-line">
                    <ProfileHoverCard
                      pubkey={author || ''}
                      profile={profile}
                      escapesClipping
                      onNavigateToProfile={onNavigateToProfile}
                    >
                      <button className="live-chat-author" onClick={() => author && onNavigateToProfile(author)}>
                        <EmojiText text={name} emojis={profile?.emojis} />
                      </button>
                    </ProfileHoverCard>
                    {' zapped '}
                    {/* Not always the streamer — anyone in the chat can be
                        zapped, so say who was actually paid */}
                    {recipient && recipient !== author && (
                      <>
                        <ProfileHoverCard
                          pubkey={recipient}
                          profile={recipientProfile}
                          escapesClipping
                          onNavigateToProfile={onNavigateToProfile}
                        >
                          <button className="live-chat-author" onClick={() => onNavigateToProfile(recipient)}>
                            <EmojiText text={recipientName} emojis={recipientProfile?.emojis} />
                          </button>
                        </ProfileHoverCard>
                        {' '}
                      </>
                    )}
                    <strong>⚡ {entry.sats.toLocaleString()} sats</strong>
                  </span>
                  {comment && (
                    <span className="live-chat-text">
                      <RichText
                        inlineImages
                        content={comment}
                        onNavigateToProfile={onNavigateToProfile}
                        onNavigateToNote={onNavigateToNote}
                        onNavigateToTopic={onNavigateToTopic}
                      />
                    </span>
                  )}
                </div>
              </div>
            );
          }

          return (
            <div key={event.id} className="live-chat-message">
              {avatar}
              <div className="live-chat-message-body">
                <span className="live-chat-message-head">
                  {/* The same card as on a name in the feed: who they are,
                      and follow or block, without leaving the stream */}
                  <ProfileHoverCard
                    pubkey={author || ''}
                    profile={profile}
                    escapesClipping
                    onNavigateToProfile={onNavigateToProfile}
                  >
                    <button className="live-chat-author" onClick={() => author && onNavigateToProfile(author)}>
                      <EmojiText text={name} emojis={profile?.emojis} />
                    </button>
                  </ProfileHoverCard>
                  {/* The stream's own list, offered only to whoever runs it */}
                  {iRunThisStream && author && author !== myPubkey && (
                    <button
                      type="button"
                      className="live-chat-mute-btn"
                      title={`Mute ${name} for everyone watching here`}
                      onClick={() => setMutedForEveryone(author, name)}
                    >
                      🚫
                    </button>
                  )}

                  {/* Muting from here, since this is where you meet someone
                      worth muting */}
                  {isLoggedIn && author && author !== myPubkey && (
                    <button
                      type="button"
                      className="live-chat-mute-btn"
                      title={`Mute ${name}`}
                      onClick={() => mute(author, name)}
                    >
                      🔇
                    </button>
                  )}

                  {/* Answering someone by name, without hunting for it */}
                  {isLoggedIn && !disabled && author && (
                    <button
                      type="button"
                      className="live-chat-tag-btn"
                      title={`Tag ${name}`}
                      onClick={() => tagAuthor(author, name)}
                    >
                      @
                    </button>
                  )}

                  {/* Tipping whoever said something, not just the host.
                      Only offered when they publish a Lightning address. */}
                  {profile?.lud16 && (
                    <ZapButton
                      lud16={profile.lud16}
                      recipientPubkey={author || undefined}
                      recipientName={name}
                      recipientEmojis={profile.emojis}
                      recipientPicture={profile.picture}
                      eventId={event.id}
                      eventAddress={address}
                      triggerClassName="live-chat-zap-btn"
                      triggerTitle={`Zap ${name}`}
                    >
                      <ZapIcon />
                    </ZapButton>
                  )}
                </span>
                <span className="live-chat-text">
                  <RichText
                    inlineImages
                    content={event.content}
                    eventTags={event.tags}
                    onNavigateToProfile={onNavigateToProfile}
                    onNavigateToNote={onNavigateToNote}
                    onNavigateToTopic={onNavigateToTopic}
                  />
                </span>
                <LiveChatReactions
                  tallies={talliesByMessage.get(event.id) || []}
                  canReact={isLoggedIn && !disabled}
                  onReact={(chosen) => author && react(event.id, author, chosen)}
                />
              </div>
            </div>
          );
        })}
      </div>

      {mentionStart !== null && suggestions.length > 0 && (
        <div className="live-chat-suggestions">
          {suggestions.map(profile => (
            <button
              key={profile.pubkey}
              type="button"
              className="suggestion-item"
              onClick={() => chooseSuggestion(profile)}
            >
              {profile.picture ? (
                <img src={profile.picture} alt="" className="suggestion-avatar" />
              ) : (
                <span className="suggestion-avatar-placeholder">
                  {(profile.display_name || profile.name || '?').charAt(0).toUpperCase()}
                </span>
              )}
              <span>
                <EmojiText
                  text={profile.display_name || profile.name || formatAddress(profile.pubkey)}
                  emojis={profile.emojis}
                />
              </span>
            </button>
          ))}
        </div>
      )}

      {!hideComposer && <form className="live-chat-input-row" onSubmit={handleSend}>
        <div className="live-chat-emoji-wrapper" ref={emoji.containerRef}>
          <button
            ref={emoji.triggerRef}
            type="button"
            className="live-chat-emoji-btn"
            onClick={() => {
              if (showEmojiPicker) {
                setShowEmojiPicker(false);
                return;
              }
              emoji.openPopup();
              setShowEmojiPicker(true);
            }}
            disabled={!isLoggedIn || disabled || sending}
            title="Add emoji"
          >
            😊
          </button>
          {showEmojiPicker && (
            <div className="live-chat-emoji-popup" ref={emoji.popupRef} style={emoji.style}>
              <EmojiPicker onSelect={insertEmoji} />
            </div>
          )}
        </div>
        <input
          ref={inputRef}
          type="text"
          className="live-chat-input"
          placeholder={isLoggedIn ? 'Send a message…' : 'Log in to chat'}
          value={input}
          onChange={(e) => {
            const value = e.target.value;
            setInput(value);
            const trigger = detectMentionTrigger(value, e.target.selectionStart ?? value.length);
            if (trigger) {
              setMentionStart(trigger.start);
              setMentionQuery(trigger.query);
            } else {
              closeSuggestions();
            }
          }}
          onKeyDown={(e) => { if (e.key === 'Escape') closeSuggestions(); }}
          onFocus={() => setShowEmojiPicker(false)}
          disabled={!isLoggedIn || disabled || sending}
          maxLength={500}
        />
        <button
          type="submit"
          className="btn btn-primary live-chat-send-btn"
          disabled={!isLoggedIn || disabled || sending || !input.trim()}
        >
          Send
        </button>
      </form>}
    </div>
  );
};

export default LiveChatPanel;
