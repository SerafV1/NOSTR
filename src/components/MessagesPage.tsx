import React, { useEffect, useRef, useState } from 'react';
import { UserProfile } from '../types';
import { NostrCore, PersistentCache } from '../nostr/core';
import { formatAddress, formatDate } from '../utils/helpers';
import {
  DirectMessageCore,
  DirectMessageStore,
  DirectMessage,
  Conversation,
  conversationKey
} from '../nostr/dm';
import RichText from './RichText';
import EmojiText from './EmojiText';

interface MessagesPageProps {
  pubkey: string;
  relaysConnected: boolean;
  onNavigateToProfile: (pubkey: string) => void;
  onNavigateToNote?: (noteId: string) => void;
  onNavigateToStream?: (naddr: string) => void;
  onMarkRead?: () => void;
  initialRecipient?: string | null;
}

/** The room being read: one person, or a few */
interface OpenRoom {
  key: string;
  participants: string[];
  subject?: string;
}

/**
 * A line of a message, as a list can show it.
 *
 * The bubble draws references as what they point at; a one-line preview has
 * no room for that, and printing them raw filled the list with a hundred and
 * twenty characters of bech32 where a sentence should be. So each is named
 * by what it is and the rest of the line is left alone.
 */
const previewOf = (content: string): string => {
  const named = content
    .replace(/(?:nostr:)?naddr1[a-z0-9]{20,}/gi, '👥 group')
    .replace(/(?:nostr:)?(?:note1|nevent1)[a-z0-9]{20,}/gi, '📝 note')
    .replace(/(?:nostr:)?(?:npub1|nprofile1)[a-z0-9]{20,}/gi, '👤 someone')
    .replace(/https?:\/\/\S+\.(?:png|jpe?g|gif|webp|avif)(?:\?\S*)?/gi, '🖼 picture')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return named || '🔗 a link';
};

const MessagesPage: React.FC<MessagesPageProps> = ({
  pubkey,
  relaysConnected,
  onNavigateToProfile,
  onNavigateToNote,
  onNavigateToStream,
  onMarkRead,
  initialRecipient
}) => {
  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [profiles, setProfiles] = useState<Record<string, UserProfile>>({});
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<OpenRoom | null>(
    initialRecipient
      ? { key: conversationKey([initialRecipient]), participants: [initialRecipient] }
      : null
  );
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const threadEndRef = useRef<HTMLDivElement>(null);

  const loadMessages = async () => {
    const cached = PersistentCache.get<DirectMessage[]>(`dm_${pubkey}`);
    if (cached && cached.length > 0) {
      setMessages(cached);
      setLoading(false);
    } else {
      setLoading(true);
    }

    try {
      const fetched = await DirectMessageCore.fetchMessages(pubkey);
      // Everyone in every conversation, not only whoever is opposite: a
      // group of five needs five names before it can be drawn as anything
      const people = Array.from(new Set(fetched.flatMap(m => m.participants)));
      const contactProfiles = await NostrCore.fetchProfiles(people);
      setProfiles(prev => ({ ...prev, ...Object.fromEntries(contactProfiles) }));

      // Merged, never replaced. A fetch answers with whatever the relays
      // that replied happened to hold, which is routinely less than what is
      // already on screen — replacing made messages vanish and come back on
      // the next refresh.
      setMessages(prev => {
        const byId = new Map(prev.map(message => [message.id, message]));
        for (const message of fetched) byId.set(message.id, message);
        const merged = Array.from(byId.values()).sort((a, b) => a.createdAt - b.createdAt);
        PersistentCache.set(`dm_${pubkey}`, merged.slice(-300));
        return merged;
      });
    } catch (error) {
      console.error('Failed to load messages:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (relaysConnected) {
      loadMessages();
    } else {
      const cached = PersistentCache.get<DirectMessage[]>(`dm_${pubkey}`);
      if (cached && cached.length > 0) {
        setMessages(cached);
        setLoading(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relaysConnected, pubkey]);

  useEffect(() => {
    if (!relaysConnected) return;
    const interval = setInterval(loadMessages, 15000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relaysConnected, pubkey]);

  useEffect(() => {
    setOpen(initialRecipient
      ? { key: conversationKey([initialRecipient]), participants: [initialRecipient] }
      : null);
  }, [initialRecipient]);

  const conversations = DirectMessageCore.groupConversations(messages);

  // Mark the open thread as read once its messages are in, and let the
  // header badge recompute from the (now-updated) last-seen markers
  useEffect(() => {
    if (!open) return;
    const thread = messages.filter(m => m.key === open.key);
    if (thread.length === 0) return;
    const newest = Math.max(...thread.map(m => m.createdAt));
    DirectMessageStore.setLastSeen(pubkey, open.key, newest);
    onMarkRead?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, open?.key, pubkey]);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: 'end' });
  }, [open?.key, messages.length]);

  const nameFor = (pk: string) => profiles[pk]?.display_name || profiles[pk]?.name || formatAddress(pk);

  /** What to call a conversation: what it calls itself, or who is in it */
  const roomName = (room: { participants: string[]; subject?: string }): string => {
    if (room.subject) return room.subject;
    const names = room.participants.map(nameFor);
    if (names.length <= 2) return names.join(' and ');
    return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const content = draft.trim();
    if (!content || !open || sending) return;

    setSending(true);
    try {
      await DirectMessageCore.sendGroupMessage(open.participants, content, open.subject);
      setDraft('');
      // Optimistic append — the next poll will reconcile with the relay copy
      setMessages(prev => [
        ...prev,
        {
          id: `local_${Date.now()}`,
          senderPubkey: pubkey,
          otherPubkey: open.participants[0],
          participants: open.participants,
          key: open.key,
          subject: open.subject,
          content,
          createdAt: Math.floor(Date.now() / 1000),
          isOwn: true
        }
      ]);
    } catch (error) {
      console.error('Failed to send message:', error);
      alert(error instanceof Error ? error.message : 'Failed to send message');
    } finally {
      setSending(false);
    }
  };

  if (open) {
    const thread = messages
      .filter(m => m.key === open.key)
      .sort((a, b) => a.createdAt - b.createdAt);
    // The name a group last gave itself, so a room opened from the list
    // keeps its name even before anything new is said in it
    const room = { participants: open.participants, subject: open.subject || thread[thread.length - 1]?.subject };
    const alone = open.participants.length === 1;
    const profile = profiles[open.participants[0]];

    return (
      <div className="messages-page">
        <div className="thread-header">
          <button className="thread-back-btn" onClick={() => setOpen(null)}>
            <span className="back-btn-arrow" aria-hidden="true">←</span>
            Back
          </button>

          {alone ? (
            <button className="thread-contact" onClick={() => onNavigateToProfile(open.participants[0])}>
              {profile?.picture ? (
                <img src={profile.picture} alt="" className="thread-contact-avatar" loading="lazy" decoding="async" />
              ) : (
                <div className="thread-contact-avatar-placeholder">
                  {nameFor(open.participants[0]).charAt(0).toUpperCase()}
                </div>
              )}
              <span><EmojiText text={nameFor(open.participants[0])} emojis={profile?.emojis} /></span>
            </button>
          ) : (
            <div className="thread-room">
              <span className="thread-title">{roomName(room)}</span>
              {/* Who is in it, since a group has no page of its own to say so */}
              <div className="thread-room-people">
                {open.participants.map(member => (
                  <button key={member} type="button" onClick={() => onNavigateToProfile(member)}>
                    <EmojiText text={nameFor(member)} emojis={profiles[member]?.emojis} />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="thread-messages">
          {thread.length === 0 && (
            <div className="empty-state">
              <p>{alone ? 'No messages yet — say hello 👋' : 'Nothing said yet. The group starts with the first message.'}</p>
            </div>
          )}
          {thread.map(message => (
            <div key={message.id} className={`dm-bubble-row ${message.isOwn ? 'own' : ''}`}>
              <div className="dm-bubble">
                {/* In a group, who said it — a bubble on its own says only
                    whether it was you */}
                {!alone && !message.isOwn && (
                  <button
                    type="button"
                    className="dm-bubble-who"
                    onClick={() => onNavigateToProfile(message.senderPubkey)}
                  >
                    <EmojiText text={nameFor(message.senderPubkey)} emojis={profiles[message.senderPubkey]?.emojis} />
                  </button>
                )}
                <div className="dm-bubble-content">
                  {/* Pictures are deliberately not loaded here: fetching one
                      tells whoever hosts it that this message was opened,
                      and in a private conversation that is the sender's to
                      learn only if you follow the link yourself. */}
                  <RichText
                    content={message.content}
                    onNavigateToProfile={onNavigateToProfile}
                    onNavigateToNote={onNavigateToNote}
                    onNavigateToStream={onNavigateToStream}
                  />
                </div>
                <div className="dm-bubble-time">{formatDate(new Date(message.createdAt * 1000))}</div>
              </div>
            </div>
          ))}
          <div ref={threadEndRef} />
        </div>

        <form className="thread-compose" onSubmit={handleSend}>
          <textarea
            className="thread-compose-input"
            placeholder={alone ? 'Write a private message...' : 'Write to the group...'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.ctrlKey) handleSend(e as any);
            }}
            rows={2}
            disabled={sending}
          />
          <button type="submit" className="btn btn-primary" disabled={!draft.trim() || sending}>
            {sending ? 'Sending...' : 'Send'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="messages-page">
      <div className="notifications-header">
        <h2>Messages</h2>
      </div>

      {loading && <div className="loading">Loading messages...</div>}

      {!loading && conversations.length === 0 && (
        <div className="empty-state">
          <p>No private messages yet — visit a profile and tap Message to start one</p>
        </div>
      )}

      <div className="conversation-list">
        {conversations.map((conversation: Conversation) => {
          const alone = conversation.participants.length === 1;
          const profile = profiles[conversation.participants[0]];
          const displayName = roomName(conversation);
          const isUnread = !conversation.lastMessage.isOwn &&
            conversation.lastMessage.createdAt > DirectMessageStore.getLastSeen(pubkey, conversation.key);

          return (
            <div
              key={conversation.key}
              className={`conversation-item ${isUnread ? 'unread' : ''}`}
              onClick={() => setOpen({
                key: conversation.key,
                participants: conversation.participants,
                subject: conversation.subject
              })}
            >
              {alone && profile?.picture ? (
                <img src={profile.picture} alt="" className="notification-avatar" loading="lazy" decoding="async" />
              ) : (
                <div className="notification-avatar-placeholder">
                  {alone ? displayName.charAt(0).toUpperCase() : conversation.participants.length + 1}
                </div>
              )}
              <div className="notification-body">
                <div className="notification-text">
                  <EmojiText text={displayName} emojis={alone ? profile?.emojis : undefined} />
                </div>
                <div className="notification-preview">
                  {conversation.lastMessage.isOwn
                    ? 'You: '
                    : (alone ? '' : `${nameFor(conversation.lastMessage.senderPubkey)}: `)}
                  {previewOf(conversation.lastMessage.content)}
                </div>
              </div>
              <div className="notification-time">
                {formatDate(new Date(conversation.lastMessage.createdAt * 1000))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default MessagesPage;
