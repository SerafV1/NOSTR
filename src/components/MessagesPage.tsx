import React, { useState, useEffect, useRef } from 'react';
import { UserProfile } from '../types';
import { NostrCore, PersistentCache } from '../nostr/core';
import { DirectMessageCore, DirectMessageStore, DirectMessage, Conversation } from '../nostr/dm';
import { formatDate, formatAddress } from '../utils/helpers';

interface MessagesPageProps {
  pubkey: string;
  relaysConnected: boolean;
  onNavigateToProfile: (pubkey: string) => void;
  onMarkRead?: () => void;
  /** Set when arriving from a profile's "Message" button — opens that thread directly */
  initialRecipient?: string | null;
}

const MessagesPage: React.FC<MessagesPageProps> = ({
  pubkey,
  relaysConnected,
  onNavigateToProfile,
  onMarkRead,
  initialRecipient
}) => {
  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [profiles, setProfiles] = useState<Record<string, UserProfile>>({});
  const [loading, setLoading] = useState(true);
  const [selectedPubkey, setSelectedPubkey] = useState<string | null>(initialRecipient || null);
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
      const contacts = Array.from(new Set(fetched.map(m => m.otherPubkey)));
      const contactProfiles = await NostrCore.fetchProfiles(contacts);
      setProfiles(prev => ({ ...prev, ...Object.fromEntries(contactProfiles) }));

      setMessages(fetched);
      PersistentCache.set(`dm_${pubkey}`, fetched.slice(-300));
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
    setSelectedPubkey(initialRecipient || null);
  }, [initialRecipient]);

  const conversations = DirectMessageCore.groupConversations(messages);

  // Mark the open thread as read once its messages are in, and let the
  // header badge recompute from the (now-updated) last-seen markers
  useEffect(() => {
    if (!selectedPubkey) return;
    const thread = messages.filter(m => m.otherPubkey === selectedPubkey);
    if (thread.length === 0) return;
    const newest = Math.max(...thread.map(m => m.createdAt));
    DirectMessageStore.setLastSeen(pubkey, selectedPubkey, newest);
    onMarkRead?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, selectedPubkey, pubkey]);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: 'end' });
  }, [selectedPubkey, messages.length]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const content = draft.trim();
    if (!content || !selectedPubkey || sending) return;

    setSending(true);
    try {
      await DirectMessageCore.sendDirectMessage(selectedPubkey, content);
      setDraft('');
      // Optimistic append — the next poll will reconcile with the relay copy
      setMessages(prev => [
        ...prev,
        {
          id: `local_${Date.now()}`,
          senderPubkey: pubkey,
          otherPubkey: selectedPubkey,
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

  const nameFor = (pk: string) => profiles[pk]?.display_name || profiles[pk]?.name || formatAddress(pk);

  if (selectedPubkey) {
    const thread = messages
      .filter(m => m.otherPubkey === selectedPubkey)
      .sort((a, b) => a.createdAt - b.createdAt);
    const profile = profiles[selectedPubkey];

    return (
      <div className="messages-page">
        <div className="thread-header">
          <button className="thread-back-btn" onClick={() => setSelectedPubkey(null)}>
            <span className="back-btn-arrow" aria-hidden="true">←</span>
            Back
          </button>
          <button className="thread-contact" onClick={() => onNavigateToProfile(selectedPubkey)}>
            {profile?.picture ? (
              <img src={profile.picture} alt="" className="thread-contact-avatar" />
            ) : (
              <div className="thread-contact-avatar-placeholder">
                {nameFor(selectedPubkey).charAt(0).toUpperCase()}
              </div>
            )}
            <span>{nameFor(selectedPubkey)}</span>
          </button>
        </div>

        <div className="thread-messages">
          {thread.length === 0 && (
            <div className="empty-state">
              <p>No messages yet — say hello 👋</p>
            </div>
          )}
          {thread.map(message => (
            <div key={message.id} className={`dm-bubble-row ${message.isOwn ? 'own' : ''}`}>
              <div className="dm-bubble">
                <div className="dm-bubble-content">{message.content}</div>
                <div className="dm-bubble-time">{formatDate(new Date(message.createdAt * 1000))}</div>
              </div>
            </div>
          ))}
          <div ref={threadEndRef} />
        </div>

        <form className="thread-compose" onSubmit={handleSend}>
          <textarea
            className="thread-compose-input"
            placeholder="Write a private message..."
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
          const profile = profiles[conversation.pubkey];
          const displayName = nameFor(conversation.pubkey);
          const isUnread = !conversation.lastMessage.isOwn &&
            conversation.lastMessage.createdAt > DirectMessageStore.getLastSeen(pubkey, conversation.pubkey);

          return (
            <div
              key={conversation.pubkey}
              className={`conversation-item ${isUnread ? 'unread' : ''}`}
              onClick={() => setSelectedPubkey(conversation.pubkey)}
            >
              {profile?.picture ? (
                <img src={profile.picture} alt="" className="notification-avatar" />
              ) : (
                <div className="notification-avatar-placeholder">
                  {displayName.charAt(0).toUpperCase()}
                </div>
              )}
              <div className="notification-body">
                <div className="notification-text">{displayName}</div>
                <div className="notification-preview">
                  {conversation.lastMessage.isOwn ? 'You: ' : ''}
                  {conversation.lastMessage.content}
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
