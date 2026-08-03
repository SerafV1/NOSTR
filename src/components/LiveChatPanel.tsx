import React, { useEffect, useRef, useState } from 'react';
import { nip19 } from 'nostr-tools';
import { NostrEventSigned, UserProfile, EVENT_KINDS } from '../types';
import { NostrCore } from '../nostr/core';
import { CredentialManager } from '../nostr/crypto';
import { formatAddress } from '../utils/helpers';
import EmojiPicker from './EmojiPicker';

interface LiveChatPanelProps {
  address: string;
  relayHint?: string;
  disabled?: boolean;
  onNavigateToProfile: (pubkey: string) => void;
  onNavigateToNote: (noteId: string) => void;
}

// nostr:note1.../nevent1... refer to a specific event, nostr:nprofile1.../npub1...
// to a user — decode whichever one a chat message links to
const decodeNoteRef = (link: string): string | null => {
  try {
    const decoded = nip19.decode(link.replace(/^nostr:/, ''));
    if (decoded.type === 'note' && typeof decoded.data === 'string') return decoded.data;
    if (decoded.type === 'nevent') return (decoded.data as { id: string }).id;
    return null;
  } catch {
    return null;
  }
};

const decodeProfileRef = (link: string): string | null => {
  try {
    const decoded = nip19.decode(link.replace(/^nostr:/, ''));
    if (decoded.type === 'npub' && typeof decoded.data === 'string') return decoded.data;
    if (decoded.type === 'nprofile') return (decoded.data as { pubkey: string }).pubkey;
    return null;
  } catch {
    return null;
  }
};

const LiveChatPanel: React.FC<LiveChatPanelProps> = ({ address, relayHint, disabled, onNavigateToProfile, onNavigateToNote }) => {
  const [messages, setMessages] = useState<NostrEventSigned[]>([]);
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
    let cancelled = false;
    let subId: string | null = null;

    (async () => {
      const history = await NostrCore.fetchLiveChatMessages(address);
      if (cancelled) return;
      setMessages(history);

      const profileMap = await NostrCore.fetchProfiles(history.map(m => m.pubkey));
      if (!cancelled) setProfiles(profileMap);

      const since = Math.floor(Date.now() / 1000);
      subId = NostrCore.subscribeLive(
        [{ kinds: [EVENT_KINDS.LIVE_CHAT_MESSAGE], '#a': [address], since }],
        async (event) => {
          setMessages(prev => (prev.some(m => m.id === event.id) ? prev : [...prev, event]));
          if (!profilesRef.current.has(event.pubkey)) {
            const fetched = await NostrCore.fetchProfiles([event.pubkey]);
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
  }, [address]);

  // Stick to the bottom as new messages come in
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages.length]);

  // Chat messages were showing raw "nostr:nevent1…" text — turn those refs
  // into clickable links instead, same as notes/notifications already do
  const renderChatContent = (content: string, keyPrefix: string): (string | React.ReactNode)[] => {
    const regex = /nostr:(?:note1|nevent1|naddr1|nprofile1|npub1)[a-z0-9]+/gi;
    const parts: (string | React.ReactNode)[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let idx = 0;

    while ((match = regex.exec(content)) !== null) {
      if (match.index > lastIndex) {
        parts.push(content.slice(lastIndex, match.index));
      }

      const link = match[0];
      const lower = link.toLowerCase();

      if (lower.includes('note1') || lower.includes('nevent1')) {
        const noteId = decodeNoteRef(link);
        if (noteId) {
          parts.push(
            <button
              key={`${keyPrefix}-note-${idx}`}
              className="live-chat-mention-link"
              onClick={(e) => { e.stopPropagation(); onNavigateToNote(noteId); }}
            >
              📝 View note
            </button>
          );
        } else {
          parts.push(link);
        }
      } else if (lower.includes('nprofile1') || lower.includes('npub1')) {
        const pubkey = decodeProfileRef(link);
        if (pubkey) {
          parts.push(
            <button
              key={`${keyPrefix}-profile-${idx}`}
              className="live-chat-mention-link"
              onClick={(e) => { e.stopPropagation(); onNavigateToProfile(pubkey); }}
            >
              @{formatAddress(pubkey)}
            </button>
          );
        } else {
          parts.push(link);
        }
      } else {
        parts.push(link);
      }

      lastIndex = match.index + match[0].length;
      idx++;
    }

    if (lastIndex < content.length) {
      parts.push(content.slice(lastIndex));
    }

    return parts.length > 0 ? parts : [content];
  };

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

  return (
    <div className="live-chat-panel">
      <div className="live-chat-header">Stream Chat</div>
      <div className="live-chat-messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="live-chat-empty">No messages yet — say hello!</div>
        )}
        {messages.map(message => {
          const profile = profiles.get(message.pubkey);
          const name = profile?.display_name || profile?.name || formatAddress(message.pubkey);
          return (
            <div key={message.id} className="live-chat-message">
              {profile?.picture ? (
                <img src={profile.picture} alt="" className="live-chat-avatar" />
              ) : (
                <div className="live-chat-avatar-placeholder">{name.charAt(0).toUpperCase()}</div>
              )}
              <div className="live-chat-message-body">
                <button className="live-chat-author" onClick={() => onNavigateToProfile(message.pubkey)}>
                  {name}
                </button>
                <span className="live-chat-text">{renderChatContent(message.content, message.id)}</span>
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
