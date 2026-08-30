import React, { useEffect, useRef, useState } from 'react';
import { UserProfile, NostrEventSigned } from '../types';
import { NostrCore, EventCache } from '../nostr/core';
import { CredentialManager } from '../nostr/crypto';
import { formatAddress } from '../utils/helpers';
import { pubkeyForNip05 } from '../utils/nip05';
import { Channel, ChannelMessage, Community } from '../nostr/concordCommunity';
import {
  channelAddress,
  communityById,
  fetchChannel,
  fetchMembers,
  heldMessages,
  invite as inviteSomebody,
  leaveCommunity,
  refreshCommunity,
  sayInChannel,
  takeChannelEvent
} from '../nostr/concordStore';
import { KIND } from '../nostr/concord';
import RichText from './RichText';
import EmojiText from './EmojiText';
import EmojiPicker from './EmojiPicker';
import GifPicker from './GifPicker';
import { BlossomClient } from '../nostr/blossom';
import { useAnchoredPopup } from '../hooks/useAnchoredPopup';

interface CommunityRoomProps {
  communityId: string;
  relaysConnected: boolean;
  onNavigateToProfile: (pubkey: string) => void;
  onNavigateToNote?: (noteId: string) => void;
  onNavigateToTopic?: (topic: string) => void;
  onLeft?: () => void;
  onChanged?: () => void;
  /** Which channel is being read, so the column beside it can say so */
  channelId?: string | null;
  onChannelChange?: (channel: Channel) => void;
}

/**
 * A community nobody hosts, read and written.
 *
 * What the relays hold for this room is a pile of kind-1059 wraps at an
 * address only a member can derive. Everything below happens after those are
 * opened here — which is also why leaving takes the room with it: the keys
 * were never anywhere else.
 */
const CommunityRoom: React.FC<CommunityRoomProps> = ({
  communityId,
  relaysConnected,
  onNavigateToProfile,
  onNavigateToNote,
  onNavigateToTopic,
  onLeft,
  onChanged,
  channelId,
  onChannelChange
}) => {
  const [community, setCommunity] = useState<Community | null>(() => communityById(communityId));
  const [channel, setChannel] = useState<Channel | null>(null);
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const [profiles, setProfiles] = useState<Record<string, UserProfile>>({});
  const [members, setMembers] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [inviting, setInviting] = useState<string | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  /** People to pick from while typing, so an invite is not npub-only */
  const [candidates, setCandidates] = useState<UserProfile[]>([]);
  const [lookingUp, setLookingUp] = useState(false);
  /** The same things to write with as anywhere else in the app */
  /** Who has been picked out of the list, waiting for the invite to be sent */
  const [picked, setPicked] = useState<UserProfile | null>(null);
  const [showEmoji, setShowEmoji] = useState(false);
  const [showGifs, setShowGifs] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const emoji = useAnchoredPopup(showEmoji, () => setShowEmoji(false));
  const gifs = useAnchoredPopup(showGifs, () => setShowGifs(false));

  const addToDraft = (text: string) => {
    setDraft(current => (current ? `${current.trimEnd()} ${text}` : text));
    draftRef.current?.focus();
  };

  /**
   * A picture goes where every other picture in this app goes — to the
   * account's own media server — and the message carries its address. What
   * the community keeps private is what is said; a picture behind a public
   * link is as public as the link.
   */
  const addPicture = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadPct(0);
    try {
      const blob = await BlossomClient.uploadFile(file, undefined, setUploadPct);
      addToDraft(blob.url);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not upload that picture');
    } finally {
      setUploadPct(null);
    }
  };

  // The community as its own control plane describes it, not merely as it was
  // when this device last looked
  useEffect(() => {
    const held = communityById(communityId);
    setCommunity(held);
    const first = held?.channels.find(c => c.id === channelId) || held?.channels[0] || null;
    setChannel(first);
    if (first) onChannelChange?.(first);
    setMessages([]);
    if (!held || !relaysConnected) return;
    void refreshCommunity(held)
      .then(fresh => {
        setCommunity(fresh);
        setChannel(current => {
          const next = fresh.channels.find(c => c.id === current?.id) || fresh.channels[0] || null;
          if (next && next.id !== current?.id) onChannelChange?.(next);
          return next;
        });
        onChanged?.();
      })
      .catch(error => console.error('[Concord] Could not read the community:', error));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [communityId, relaysConnected]);

  useEffect(() => {
    if (!community || !channel) return;
    setMessages(heldMessages(channel.id));
    if (!relaysConnected) return;
    let cancelled = false;

    const learnName = async (pubkey: string) => {
      const known = EventCache.getProfile(pubkey);
      if (known) { setProfiles(prev => ({ ...prev, [pubkey]: known })); return; }
      const found = await NostrCore.fetchUserProfile(pubkey);
      if (found && !cancelled) setProfiles(prev => ({ ...prev, [pubkey]: found }));
    };

    void fetchChannel(community, channel).then(said => {
      if (cancelled) return;
      setMessages(said);
      for (const author of new Set(said.map(m => m.author))) void learnName(author);
    });

    void fetchMembers(community).then(found => { if (!cancelled) setMembers(found); });

    const subId = NostrCore.subscribeLive(
      [{ kinds: [KIND.wrap], authors: [channelAddress(community, channel)] }],
      (event: NostrEventSigned) => {
        const message = takeChannelEvent(community, channel, event);
        if (!message || cancelled) return;
        setMessages(prev => (prev.some(m => m.id === message.id)
          ? prev
          : [...prev, message].sort((a, b) => a.at - b.at)));
        void learnName(message.author);
      }
    );

    return () => { cancelled = true; NostrCore.unsubscribeLive(subId); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [community?.id, channel?.id, relaysConnected]);

  useEffect(() => {
    if (!channelId || !community) return;
    let wanted = community.channels.find(c => c.id === channelId);
    if (!wanted) {
      // A channel made from the column a moment ago is not in the copy this
      // room is holding, so the copy is what is out of date
      const fresh = communityById(communityId);
      wanted = fresh?.channels.find(c => c.id === channelId);
      if (fresh && wanted) setCommunity(fresh);
    }
    if (wanted && wanted.id !== channel?.id) setChannel(wanted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, community?.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, channel?.id]);

  /**
   * Whoever is being typed, however it is written.
   *
   * People do not type keys, they type names — with an "@" in front, or a "#"
   * that a client somewhere writes before them, or the whole nostr address,
   * or a pasted npub. All four end up here and all four are looked up: the
   * people this browser already knows come back at once, a key or an address
   * is resolved to exactly one account, and the relays are asked last, since
   * they can only answer for a profile published lately.
   */
  useEffect(() => {
    const raw = (inviting || '').trim();
    // A leading @ or # is how a name is written, not part of it
    const typed = raw.replace(/^[@#]+/, '').trim();
    if (typed.length < 2) {
      setCandidates([]);
      setLookingUp(false);
      return;
    }

    const key = NostrCore.pubkeyFromIdentifier(typed);
    const asAddress = !key && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(typed);
    const wanted = typed.toLowerCase();
    const mine = CredentialManager.getPublicKey();

    // A key or an address names one account, so there is nothing to sift
    setCandidates(key || asAddress ? [] : EventCache.getAllProfiles()
      .filter(person => person.pubkey !== mine)
      .filter(person => [person.name, person.display_name, person.nip05]
        .filter(Boolean).join(' ').toLowerCase().includes(wanted))
      .slice(0, 8));
    setLookingUp(true);

    const timer = setTimeout(async () => {
      try {
        const one = key || (asAddress ? await pubkeyForNip05(typed) : null);
        if (one) {
          const profile = await NostrCore.fetchUserProfile(one);
          setCandidates([profile ?? { pubkey: one, name: typed }]);
          return;
        }

        const found = await NostrCore.searchProfiles(typed, 8);
        setCandidates(current => {
          const byPubkey = new Map(current.map(person => [person.pubkey, person]));
          for (const person of found) {
            if (person.pubkey !== mine && !byPubkey.has(person.pubkey)) byPubkey.set(person.pubkey, person);
          }
          return Array.from(byPubkey.values()).slice(0, 12);
        });
      } catch (error) {
        console.error('[Concord] Could not look up people:', error);
      } finally {
        setLookingUp(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [inviting]);

  const inviteThem = async (who: string) => {
    if (!community) return;
    setInviteBusy(true);
    setNotice(null);
    try {
      await inviteSomebody(community, who);
      setInviting(null);
      setCandidates([]);
      setNotice('Invited. They hold the keys the moment it lands — an invitation cannot be taken back.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not invite them');
    } finally {
      setInviteBusy(false);
    }
  };

  const nameFor = (pubkey: string) =>
    profiles[pubkey]?.display_name || profiles[pubkey]?.name || formatAddress(pubkey);

  const say = async (e?: React.FormEvent) => {
    e?.preventDefault?.();
    const content = draft.trim();
    if (!content || !community || !channel || sending) return;
    setSending(true);
    setDraft('');
    try {
      const mine = await sayInChannel(community, channel, content);
      setMessages(prev => (prev.some(m => m.id === mine.id) ? prev : [...prev, mine].sort((a, b) => a.at - b.at)));
    } catch (error) {
      console.error('[Concord] Could not send:', error);
      setDraft(current => current || content);
      setNotice(error instanceof Error ? error.message : 'Could not send that');
    } finally {
      setSending(false);
    }
  };

  if (!community) {
    return (
      <section className="groups-chat">
        <div className="groups-empty">
          This community is not on this device. Its keys were never on a relay, so somebody
          in it has to invite you again.
        </div>
      </section>
    );
  }

  return (
    <section className="groups-chat">
      <header className="groups-chat-header">
        <div>
          <h2>{community.name}</h2>
          <p>
            {community.description || 'Encrypted community'} · {members.length || 1}{' '}
            {members.length === 1 ? 'member' : 'members'} · no server holds it
          </p>
        </div>
        <div className="groups-chat-actions">
          <button
            type="button"
            className="groups-join-btn"
            onClick={() => { setInviting(inviting === null ? '' : null); setPicked(null); }}
          >
            {inviting === null ? 'Invite' : 'Close'}
          </button>
          <button
            type="button"
            className="groups-chat-action"
            onClick={async () => {
              const sure = window.confirm(
                `Leave "${community.name}"?\n\nThe keys go with it, and they were never on a relay — ` +
                'somebody in it would have to invite you again.'
              );
              if (!sure) return;
              await leaveCommunity(community);
              onLeft?.();
            }}
          >
            Leave
          </button>
        </div>
      </header>

      {inviting !== null && (
        <div className="groups-invite">
          {picked ? (
            <span className="groups-invite-picked">
              {picked.picture
                ? <img src={picked.picture} alt="" loading="lazy" decoding="async" />
                : <span className="groups-invite-face">
                    {(picked.display_name || picked.name || '?').charAt(0).toUpperCase()}
                  </span>}
              <EmojiText
                text={picked.display_name || picked.name || formatAddress(picked.pubkey)}
                emojis={picked.emojis}
              />
              <button type="button" title="Somebody else" onClick={() => setPicked(null)}>✕</button>
            </span>
          ) : (
            <input
              type="text"
              value={inviting}
              autoFocus
              placeholder="Search a name, an @address, or paste an npub"
              onChange={e => setInviting(e.target.value)}
            />
          )}
          <button
            type="button"
            className="groups-join-btn"
            disabled={inviteBusy || (!picked && !inviting.trim())}
            onClick={async () => {
              if (picked) { await inviteThem(picked.pubkey); setPicked(null); return; }
              const typed = inviting.trim().replace(/^[@#]+/, '');
              const who = NostrCore.pubkeyFromIdentifier(typed)
                || (typed.includes('@') ? await pubkeyForNip05(typed) : null);
              if (!who) {
                setNotice(typed.includes('@')
                  ? `${typed} does not answer for any account`
                  : 'Pick somebody from the list, or paste an npub or a name@domain');
                return;
              }
              await inviteThem(who);
            }}
          >
            {inviteBusy ? 'Inviting…' : 'Invite'}
          </button>
        </div>
      )}

      {inviting !== null && !picked && inviting.trim().replace(/^[@#]+/, '').length >= 2 && (
        <div className="groups-invite-people">
          {candidates.length === 0 && (
            <p className="groups-empty">
              {lookingUp
                ? 'Looking…'
                : 'Nobody by that name, and no domain answering for it. Relays only answer for profiles published lately — a pasted npub always works.'}
            </p>
          )}
          {candidates.map(person => (
            <button
              key={person.pubkey}
              type="button"
              className="groups-invite-person"
              disabled={inviteBusy}
              onClick={() => {
                // Chosen, not sent: an invitation cannot be taken back, so it
                // waits for the button that says so
                setPicked(person);
                setInviting('');
                setCandidates([]);
              }}
            >
              {person.picture
                ? <img src={person.picture} alt="" loading="lazy" decoding="async" />
                : <span className="groups-invite-face">
                    {(person.display_name || person.name || '?').charAt(0).toUpperCase()}
                  </span>}
              <span>
                <EmojiText
                  text={person.display_name || person.name || formatAddress(person.pubkey)}
                  emojis={person.emojis}
                />
              </span>
            </button>
          ))}
        </div>
      )}

      {notice && <div className="groups-notice">{notice}</div>}

      <div className="groups-messages">
        {messages.length === 0 && (
          <div className="groups-empty">
            Nothing said yet. What is written here is readable only by the people holding
            this community's key.
          </div>
        )}
        {messages.map(message => (
          <div key={message.id} className="groups-message">
            <button
              type="button"
              className="groups-message-who"
              onClick={() => onNavigateToProfile(message.author)}
            >
              {profiles[message.author]?.picture
                ? <img src={profiles[message.author].picture} alt="" loading="lazy" decoding="async" />
                : <span className="groups-avatar-placeholder">
                    {nameFor(message.author).charAt(0).toUpperCase()}
                  </span>}
            </button>
            <div className="groups-message-body">
              <span className="groups-message-name">
                <button
                  type="button"
                  className="groups-message-author"
                  onClick={() => onNavigateToProfile(message.author)}
                >
                  <EmojiText text={nameFor(message.author)} emojis={profiles[message.author]?.emojis} />
                </button>
                <time>
                  {new Date(message.at).toLocaleTimeString([], {
                    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
                  })}
                </time>
              </span>
              <RichText
                inlineImages
                inlineQuotes
                content={message.content}
                onNavigateToProfile={onNavigateToProfile}
                onNavigateToNote={onNavigateToNote}
                onNavigateToTopic={onNavigateToTopic}
              />
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="groups-composer">
        <textarea
          ref={draftRef}
          className="groups-composer-input"
          placeholder={`Message #${channel?.name || 'general'}`}
          value={draft}
          rows={1}
          maxLength={2000}
          disabled={sending || !channel}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void say(e as any); }
          }}
        />

        <div className="groups-composer-tools">
          <div ref={emoji.containerRef}>
            <button
              type="button"
              ref={emoji.triggerRef}
              title="Emoji"
              onClick={() => {
                if (showEmoji) { setShowEmoji(false); return; }
                emoji.openPopup();
                setShowEmoji(true);
              }}
            >
              😊
            </button>
            {showEmoji && emoji.render(
              <div className="groups-picker-popup" ref={emoji.popupRef} style={emoji.style}>
                <EmojiPicker onSelect={mark => { setShowEmoji(false); addToDraft(mark); }} />
              </div>
            )}
          </div>

          <div ref={gifs.containerRef}>
            <button
              type="button"
              ref={gifs.triggerRef}
              title="GIF"
              onClick={() => {
                if (showGifs) { setShowGifs(false); return; }
                gifs.openPopup();
                setShowGifs(true);
              }}
            >
              GIF
            </button>
            {showGifs && gifs.render(
              <div className="groups-picker-popup" ref={gifs.popupRef} style={gifs.style}>
                <GifPicker onSelect={url => { setShowGifs(false); addToDraft(url); }} />
              </div>
            )}
          </div>

          <label className="groups-upload" title="Picture">
            {uploadPct === null ? '🖼' : `${uploadPct}%`}
            <input type="file" accept="image/*" hidden onChange={addPicture} />
          </label>
        </div>

        <button
          type="button"
          className="groups-send"
          onClick={e => void say(e as any)}
          disabled={sending || !draft.trim()}
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </section>
  );
};

export default CommunityRoom;
