import React, { useEffect, useMemo, useRef, useState } from 'react';
import { NostrEventSigned, UserProfile } from '../types';
import { NostrCore, EventCache } from '../nostr/core';
import { CredentialManager } from '../nostr/crypto';
import {
  GroupAddress,
  GroupInfo,
  fetchGroupChat,
  fetchGroup,
  fetchGroupMembers,
  fetchGroups,
  fetchMyGroupsOn,
  getGroupRelays,
  groupKey,
  joinGroup,
  joinedGroupsFromCache,
  fetchJoinedGroups,
  leaveGroup,
  sendGroupMessage,
  setGroupRelays,
  subscribeGroupChat
} from '../nostr/groups';
import { formatAddress } from '../utils/helpers';
import RichText from './RichText';
import EmojiText from './EmojiText';

interface GroupsPageProps {
  /** The account's own relays, which is where the shared list of groups lives */
  relaysConnected: boolean;
  onNavigateToProfile: (pubkey: string) => void;
  onNavigateToNote?: (noteId: string) => void;
  onNavigateToTopic?: (topic: string) => void;
}

const relayLabel = (url: string): string => url.replace(/^wss:\/\//, '').replace(/\/$/, '');

/**
 * NIP-29 groups, where the relay is the server: a column of relays, the
 * groups each one holds, and the conversation inside one of them. The same
 * groups people are in through Armada, Chachi or 0xchat.
 */
const GroupsPage: React.FC<GroupsPageProps> = ({ relaysConnected, onNavigateToProfile, onNavigateToNote, onNavigateToTopic }) => {
  const [relays, setRelays] = useState<string[]>(getGroupRelays);
  const [activeRelay, setActiveRelay] = useState<string>(() => getGroupRelays()[0] || '');
  const [groupsByRelay, setGroupsByRelay] = useState<Record<string, GroupInfo[]>>({});
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [search, setSearch] = useState('');

  const [joined, setJoined] = useState<GroupAddress[]>(joinedGroupsFromCache);
  // Which groups each relay considers this account a member of. A group
  // joined in another app was invisible here until it was asked for: the
  // list a client keeps is one thing, being in the group is another.
  const [memberOf, setMemberOf] = useState<Record<string, string[]>>({});
  const [active, setActive] = useState<GroupAddress | null>(null);
  const [messages, setMessages] = useState<NostrEventSigned[]>([]);
  const [members, setMembers] = useState<string[]>([]);
  const [profiles, setProfiles] = useState<Record<string, UserProfile>>({});
  const [loadingChat, setLoadingChat] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [newRelay, setNewRelay] = useState('');

  const bottomRef = useRef<HTMLDivElement>(null);
  const ownPubkey = CredentialManager.getPublicKey();
  const canSign = CredentialManager.canSign();

  const activeGroups = groupsByRelay[activeRelay] || [];
  const activeInfo = useMemo(
    () => (active ? (groupsByRelay[active.relay] || []).find(g => g.id === active.id) || null : null),
    [active, groupsByRelay]
  );
  const inGroup = (address: GroupAddress): boolean =>
    joined.some(g => groupKey(g) === groupKey(address)) ||
    (memberOf[address.relay] || []).includes(address.id);

  const isJoined = active ? inGroup(active) : false;

  /** Everything this account is in, from both what it wrote down and what the relays say */
  const mine: GroupAddress[] = useMemo(() => {
    const all = new Map<string, GroupAddress>();
    for (const address of joined) all.set(groupKey(address), address);
    for (const [relay, ids] of Object.entries(memberOf)) {
      for (const id of ids) all.set(groupKey({ relay, id }), { relay, id });
    }
    return Array.from(all.values());
  }, [joined, memberOf]);

  // The groups a relay holds
  useEffect(() => {
    if (!activeRelay || groupsByRelay[activeRelay]) return;
    let cancelled = false;
    setLoadingGroups(true);
    fetchGroups(activeRelay)
      .then(found => {
        if (cancelled) return;
        setGroupsByRelay(prev => ({ ...prev, [activeRelay]: found }));
      })
      .finally(() => { if (!cancelled) setLoadingGroups(false); });
    return () => { cancelled = true; };
  }, [activeRelay, groupsByRelay]);

  // The groups this account is in, as other clients know them. Asked once the
  // account's own relays are up: asked before that, the pool has nobody to
  // ask and answers with nothing — which read as "you are in no groups".
  useEffect(() => {
    if (!relaysConnected) return;
    let cancelled = false;

    const ask = async (attempt: number) => {
      const found = await fetchJoinedGroups();
      if (cancelled) return;
      if (found.length > 0) {
        setJoined(found);
        return;
      }
      // An empty answer this early is more often a slow relay than an empty list
      if (attempt < 2) setTimeout(() => { if (!cancelled) void ask(attempt + 1); }, 4000);
    };
    void ask(0);

    return () => { cancelled = true; };
  }, [relaysConnected]);

  // And as the relays themselves know them
  useEffect(() => {
    if (!ownPubkey) return;
    let cancelled = false;
    const asked = Array.from(new Set([...relays, ...joined.map(g => g.relay)]));

    for (const relay of asked) {
      fetchMyGroupsOn(relay, ownPubkey).then(ids => {
        if (cancelled || ids.length === 0) return;
        setMemberOf(prev => (prev[relay]?.length === ids.length ? prev : { ...prev, [relay]: ids }));
      });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relays.join(','), joined.length, ownPubkey]);

  // A group of one's own on a relay whose list has not been read carries no
  // name yet, and a row of hex is not a group anybody recognises
  useEffect(() => {
    let cancelled = false;
    for (const address of mine) {
      const known = (groupsByRelay[address.relay] || []).some(g => g.id === address.id);
      if (known) continue;
      fetchGroup(address).then(info => {
        if (cancelled || !info) return;
        setGroupsByRelay(prev => {
          const held = prev[address.relay] || [];
          if (held.some(g => g.id === info.id)) return prev;
          return { ...prev, [address.relay]: [...held, info] };
        });
      });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine.map(groupKey).join(',')]);

  // A group's conversation, and whatever is said while it is open
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let stop: (() => void) | null = null;

    setMessages([]);
    setMembers([]);
    setLoadingChat(true);

    fetchGroupChat(active, 200)
      .then(found => {
        if (cancelled) return;
        setMessages(found);
        void loadProfilesFor(found.map(m => m.pubkey));
      })
      .finally(() => { if (!cancelled) setLoadingChat(false); });

    fetchGroupMembers(active).then(found => {
      if (cancelled) return;
      setMembers(found);
      void loadProfilesFor(found.slice(0, 60));
    });

    subscribeGroupChat(active, event => {
      if (cancelled) return;
      setMessages(prev => (prev.some(m => m.id === event.id)
        ? prev
        : [...prev, event].sort((a, b) => (a.created_at || 0) - (b.created_at || 0))));
      void loadProfilesFor([event.pubkey]);
    }).then(unsubscribe => {
      if (cancelled) unsubscribe();
      else stop = unsubscribe;
    });

    return () => { cancelled = true; stop?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.relay, active?.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, active?.id]);

  const loadProfilesFor = async (pubkeys: string[]) => {
    const wanted = Array.from(new Set(pubkeys)).filter(pubkey => pubkey && !profiles[pubkey]);
    if (wanted.length === 0) return;
    const cached: Record<string, UserProfile> = {};
    for (const pubkey of wanted) {
      const held = EventCache.getProfile(pubkey);
      if (held) cached[pubkey] = held;
    }
    if (Object.keys(cached).length > 0) setProfiles(prev => ({ ...prev, ...cached }));
    const found = await NostrCore.fetchProfiles(wanted);
    setProfiles(prev => ({ ...prev, ...Object.fromEntries(found) }));
  };

  const nameFor = (pubkey: string): string => {
    const profile = profiles[pubkey];
    return profile?.display_name || profile?.name || formatAddress(pubkey);
  };

  const shownGroups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return activeGroups;
    return activeGroups.filter(g =>
      g.name.toLowerCase().includes(needle) || g.about.toLowerCase().includes(needle));
  }, [activeGroups, search]);

  const openGroup = (address: GroupAddress) => {
    setNotice(null);
    setActive(address);
    if (address.relay !== activeRelay) setActiveRelay(address.relay);
  };

  const send = async () => {
    const content = draft.trim();
    if (!content || !active || sending) return;
    setSending(true);
    try {
      const sent = await sendGroupMessage(active, content);
      setDraft('');
      setMessages(prev => (prev.some(m => m.id === sent.id) ? prev : [...prev, sent]));
    } catch (error) {
      setNotice(
        `The relay would not take that: ${error instanceof Error ? error.message : String(error)}` +
        (isJoined ? '' : ' — most groups only take messages from their members, so join it first.')
      );
    } finally {
      setSending(false);
    }
  };

  const toggleMembership = async () => {
    if (!active) return;
    setNotice(null);
    try {
      if (isJoined) {
        await leaveGroup(active);
        setJoined(prev => prev.filter(g => groupKey(g) !== groupKey(active)));
        setMemberOf(prev => ({
          ...prev,
          [active.relay]: (prev[active.relay] || []).filter(id => id !== active.id)
        }));
      } else {
        await joinGroup(active);
        setJoined(prev => [...prev, active]);
        setNotice(activeInfo?.isOpen
          ? null
          : 'This group is closed, so the request is with its admins now.');
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  // A relay this account has groups on but has never been told about — the
  // usual way that happens is joining somewhere else, in 0xchat or Chachi,
  // which writes the relay into the shared list. It takes its place beside
  // the built-in ones rather than leaving the group unreachable.
  useEffect(() => {
    const known = new Set(relays);
    const found = mine.map(g => g.relay).filter(url => url && !known.has(url));
    if (found.length === 0) return;
    const next = [...relays, ...Array.from(new Set(found))];
    setRelays(next);
    setGroupRelays(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine.map(g => g.relay).join(',')]);

  const addRelay = () => {
    const url = newRelay.trim();
    if (!url) return;
    const normalised = url.startsWith('ws') ? url : `wss://${url}`;
    const next = Array.from(new Set([...relays, normalised]));
    setRelays(next);
    setGroupRelays(next);
    setNewRelay('');
    setActiveRelay(normalised);
  };

  return (
    <div className={`groups-page ${active ? 'reading' : 'browsing'}`}>
      {/* The relays, which is to say the servers */}
      <aside className="groups-relays">
        <h2>Servers</h2>
        {relays.map(url => (
          <button
            key={url}
            type="button"
            className={`groups-relay ${url === activeRelay ? 'active' : ''}`}
            onClick={() => setActiveRelay(url)}
            title={url}
          >
            {relayLabel(url)}
          </button>
        ))}
        <div className="groups-add-relay">
          <input
            type="text"
            value={newRelay}
            placeholder="add a relay…"
            onChange={e => setNewRelay(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addRelay(); }}
          />
          <button type="button" onClick={addRelay}>+</button>
        </div>
      </aside>

      {/* What that server holds */}
      <nav className="groups-list">
        {mine.length > 0 && (
          <>
            <h3>Yours</h3>
            {mine.map(address => {
              const info = (groupsByRelay[address.relay] || []).find(g => g.id === address.id);
              return (
                <button
                  key={groupKey(address)}
                  type="button"
                  className={`groups-item ${active && groupKey(active) === groupKey(address) ? 'active' : ''}`}
                  onClick={() => openGroup(address)}
                >
                  <span className="groups-item-name">{info?.name || address.id}</span>
                  <span className="groups-item-relay">{relayLabel(address.relay)}</span>
                </button>
              );
            })}
          </>
        )}

        <h3>On {relayLabel(activeRelay)}</h3>
        <input
          className="groups-search"
          type="text"
          value={search}
          placeholder="search groups…"
          onChange={e => setSearch(e.target.value)}
        />
        {loadingGroups && <div className="groups-empty">Looking…</div>}
        {!loadingGroups && shownGroups.length === 0 && (
          <div className="groups-empty">Nothing here to read.</div>
        )}
        {shownGroups.slice(0, 200).map(group => (
          <button
            key={groupKey(group)}
            type="button"
            className={`groups-item ${active && active.id === group.id && active.relay === group.relay ? 'active' : ''}`}
            onClick={() => openGroup({ relay: group.relay, id: group.id })}
          >
            <span className="groups-item-name">{group.name}</span>
            {inGroup({ relay: group.relay, id: group.id }) && (
              <span className="groups-item-in" title="You are in this group">✓</span>
            )}
            {group.members !== undefined && (
              <span className="groups-item-count">{group.members}</span>
            )}
          </button>
        ))}
      </nav>

      {/* The conversation */}
      <section className="groups-chat">
        {!active ? (
          <div className="groups-empty groups-nothing-open">
            <p>Pick a group to read it.</p>
          </div>
        ) : (
          <>
            <header className="groups-chat-header">
              <button
                type="button"
                className="groups-back"
                onClick={() => setActive(null)}
                title="Back to the list"
              >
                ←
              </button>
              <div>
                <h2>{activeInfo?.name || active.id}</h2>
                {activeInfo?.about && <p>{activeInfo.about}</p>}
              </div>
              {canSign && (
                <button type="button" className="groups-join-btn" onClick={toggleMembership}>
                  {isJoined ? 'Leave' : 'Join'}
                </button>
              )}
            </header>

            {notice && <div className="groups-notice">{notice}</div>}

            <div className="groups-messages">
              {loadingChat && <div className="groups-empty">Reading…</div>}
              {!loadingChat && messages.length === 0 && (
                <div className="groups-empty">Nobody has said anything yet.</div>
              )}
              {messages.map(message => (
                <div key={message.id} className="groups-message">
                  <button
                    type="button"
                    className="groups-message-who"
                    onClick={() => onNavigateToProfile(message.pubkey)}
                  >
                    {profiles[message.pubkey]?.picture
                      ? <img src={profiles[message.pubkey].picture} alt="" />
                      : <span className="groups-avatar-placeholder">{nameFor(message.pubkey).charAt(0).toUpperCase()}</span>}
                  </button>
                  <div className="groups-message-body">
                    <span className="groups-message-name">
                      <EmojiText text={nameFor(message.pubkey)} emojis={profiles[message.pubkey]?.emojis} />
                      <time>{new Date((message.created_at || 0) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</time>
                    </span>
                    <RichText
                      inlineImages
                      content={message.content}
                      eventTags={message.tags}
                      onNavigateToProfile={onNavigateToProfile}
                      onNavigateToNote={onNavigateToNote}
                      onNavigateToTopic={onNavigateToTopic}
                    />
                  </div>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>

            {canSign ? (
              <div className="groups-composer">
                <textarea
                  value={draft}
                  placeholder={`Message ${activeInfo?.name || 'the group'}`}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
                  }}
                />
                <button type="button" onClick={() => void send()} disabled={sending || !draft.trim()}>
                  {sending ? 'Sending…' : 'Send'}
                </button>
              </div>
            ) : (
              <div className="groups-notice">Log in to take part.</div>
            )}
          </>
        )}
      </section>

      {/* Who is in it */}
      <aside className="groups-members">
        {active && (
          <>
            <h3>Members {members.length > 0 && <span>{members.length}</span>}</h3>
            {members.slice(0, 100).map(pubkey => (
              <button
                key={pubkey}
                type="button"
                className="groups-member"
                onClick={() => onNavigateToProfile(pubkey)}
              >
                {profiles[pubkey]?.picture
                  ? <img src={profiles[pubkey].picture} alt="" />
                  : <span className="groups-avatar-placeholder">{nameFor(pubkey).charAt(0).toUpperCase()}</span>}
                <span className={pubkey === ownPubkey ? 'groups-member-you' : ''}>
                  <EmojiText text={nameFor(pubkey)} emojis={profiles[pubkey]?.emojis} />
                </span>
              </button>
            ))}
          </>
        )}
      </aside>
    </div>
  );
};

export default GroupsPage;
