import React, { useEffect, useRef, useState } from 'react';
import { NostrEventSigned, UserProfile, EVENT_KINDS } from '../types';
import { NostrCore } from '../nostr/core';
import { CredentialManager } from '../nostr/crypto';
import RichText from './RichText';
import { formatAddress } from '../utils/helpers';
import EmojiPicker from './EmojiPicker';
import ZapButton from './ZapButton';
import { ZapIcon } from './Icons';

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
}

const LiveChatPanel: React.FC<LiveChatPanelProps> = ({ address, relayHint, disabled, onNavigateToProfile, onNavigateToNote, onNavigateToTopic, relaysConnected = true, onPopOut }) => {
  const [messages, setMessages] = useState<NostrEventSigned[]>([]);
  const [zaps, setZaps] = useState<NostrEventSigned[]>([]);
  const [profiles, setProfiles] = useState<Map<string, UserProfile>>(new Map());
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const profilesRef = useRef<Map<string, UserProfile>>(new Map());
  const isLoggedIn = CredentialManager.isLoggedIn();
  profilesRef.current = profiles;

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

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const content = input.trim();
    if (!content || sending) return;

    setSending(true);
    try {
      const sent = await NostrCore.publishLiveChatMessage(address, relayHint, content);
      if (sent) {
        setInput('');
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
  ].sort((a, b) => (a.event.created_at || 0) - (b.event.created_at || 0));

  return (
    <div className="live-chat-panel">
      <div className="live-chat-header">
        <span>Stream Chat</span>
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
                    <button className="live-chat-author" onClick={() => author && onNavigateToProfile(author)}>
                      {name}
                    </button>
                    {' zapped '}
                    {/* Not always the streamer — anyone in the chat can be
                        zapped, so say who was actually paid */}
                    {recipient && recipient !== author && (
                      <>
                        <button className="live-chat-author" onClick={() => onNavigateToProfile(recipient)}>
                          {recipientName}
                        </button>
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
                  <button className="live-chat-author" onClick={() => author && onNavigateToProfile(author)}>
                    {name}
                  </button>
                  {/* Tipping whoever said something, not just the host.
                      Only offered when they publish a Lightning address. */}
                  {profile?.lud16 && (
                    <ZapButton
                      lud16={profile.lud16}
                      recipientPubkey={author || undefined}
                      recipientName={name}
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
                    onNavigateToProfile={onNavigateToProfile}
                    onNavigateToNote={onNavigateToNote}
                    onNavigateToTopic={onNavigateToTopic}
                  />
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <form className="live-chat-input-row" onSubmit={handleSend}>
        <div className="live-chat-emoji-wrapper">
          <button
            type="button"
            className="live-chat-emoji-btn"
            onClick={() => setShowEmojiPicker(show => !show)}
            disabled={!isLoggedIn || disabled || sending}
            title="Add emoji"
          >
            😊
          </button>
          {showEmojiPicker && (
            <div className="live-chat-emoji-popup">
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
          onChange={(e) => setInput(e.target.value)}
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
      </form>
    </div>
  );
};

export default LiveChatPanel;
