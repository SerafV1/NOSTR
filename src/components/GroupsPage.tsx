import React, { useEffect, useMemo, useRef, useState } from 'react';
import { NostrEventSigned, UserProfile } from '../types';
import { NostrCore, EventCache } from '../nostr/core';
import { CredentialManager } from '../nostr/crypto';
import {
  GroupAddress,
  GroupInfo,
  GroupRole,
  fetchGroupChat,
  fetchGroup,
  fetchGroupAdmins,
  fetchGroupMembers,
  fetchGroups,
  fetchMyGroupsOn,
  discoverGroupRelays,
  getGroupRelays,
  groupKey,
  KNOWN_GROUP_RELAYS,
  joinGroup,
  joinedGroupsFromCache,
  fetchJoinedGroups,
  leaveGroup,
  sendGroupMessage,
  setGroupRelays,
  subscribeGroupChat
} from '../nostr/groups';
import { formatAddress } from '../utils/helpers';
import { resolveMentionHandles } from '../utils/mentions';
import {
  extractEmbeds,
  extractImageUrls,
  extractPreviewLinkUrl,
  extractStreamUrls,
  extractVideoUrls
} from '../utils/media';
import LinkPreviewCard from './LinkPreviewCard';
import RichText from './RichText';
import EmojiText from './EmojiText';
import ProfileHoverCard from './ProfileHoverCard';
import EmojiPicker from './EmojiPicker';
import GifPicker from './GifPicker';
import { BlossomClient } from '../nostr/blossom';
import { useAnchoredPopup } from '../hooks/useAnchoredPopup';

interface GroupsPageProps {
  /** The account's own relays, which is where the shared list of groups lives */
  relaysConnected: boolean;
  onNavigateToProfile: (pubkey: string) => void;
  onNavigateToNote?: (noteId: string) => void;
  onNavigateToTopic?: (topic: string) => void;
}

/**
 * A plain link is worth a card of its own — the same rule a post keeps: only
 * where there is nothing else to look at, so an article gets a preview and a
 * picture does not get one underneath it.
 */
const previewableLink = (content: string): string | null => {
  if (extractImageUrls(content).length > 0) return null;
  if (extractVideoUrls(content).length > 0) return null;
  if (extractStreamUrls(content).length > 0) return null;
  if (extractEmbeds(content).length > 0) return null;
  return extractPreviewLinkUrl(content) || null;
};

const relayLabel = (url: string): string => url.replace(/^wss:\/\//, '').replace(/\/$/, '');

/** The rank everyone else is */
const MEMBER = '\u0000member';

/** Whoever holds the place together goes first, whatever they are called */
const rankOrder = (role: string): number => {
  const known = ['king', 'owner', 'admin', 'bishop', 'moderator', 'mod'];
  const at = known.indexOf(role.toLowerCase());
  return at === -1 ? known.length : at;
};

const plural = (role: string): string => {
  const word = role.charAt(0).toUpperCase() + role.slice(1);
  if (/s$/i.test(word)) return word;
  return /(ch|sh|x|z)$/i.test(word) ? `${word}es` : `${word}s`;
};

/**
 * NIP-29 groups, where the relay is the server: a column of relays, the
 * groups each one holds, and the conversation inside one of them. The same
 * groups people are in through Armada, Chachi or 0xchat.
 */
const GroupsPage: React.FC<GroupsPageProps> = ({ relaysConnected, onNavigateToProfile, onNavigateToNote, onNavigateToTopic }) => {
  const [relays, setRelays] = useState<string[]>(getGroupRelays);
  const [activeRelay, setActiveRelay] = useState<string>(() => getGroupRelays()[0] || '');
  // The first server to turn up — found or added — is the one opened
  useEffect(() => {
    if (!activeRelay && relays.length > 0) setActiveRelay(relays[0]);
  }, [relays, activeRelay]);
  const [groupsByRelay, setGroupsByRelay] = useState<Record<string, GroupInfo[]>>({});
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [search, setSearch] = useState('');

  const [joined, setJoined] = useState<GroupAddress[]>(joinedGroupsFromCache);
  // Which groups each relay considers this account a member of. A group
  // joined in another app was invisible here until it was asked for: the
  // list a client keeps is one thing, being in the group is another.
  const [memberOf, setMemberOf] = useState<Record<string, string[]>>({});
  const [lookingForMine, setLookingForMine] = useState(false);
  const [active, setActive] = useState<GroupAddress | null>(null);
  const [messages, setMessages] = useState<NostrEventSigned[]>([]);
  const [members, setMembers] = useState<string[]>([]);
  const [runners, setRunners] = useState<GroupRole[]>([]);
  const [roleMeanings, setRoleMeanings] = useState<Record<string, string>>({});
  const [profiles, setProfiles] = useState<Record<string, UserProfile>>({});
  const [loadingChat, setLoadingChat] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [newRelay, setNewRelay] = useState('');
  // A closed group is joined by invitation: the relay ignores a bare request
  // and wants the code that was handed out with it
  const [inviteCode, setInviteCode] = useState('');
  const [showEmoji, setShowEmoji] = useState(false);
  const [showGifs, setShowGifs] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [askingForCode, setAskingForCode] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const emoji = useAnchoredPopup(showEmoji, () => setShowEmoji(false));
  const gifs = useAnchoredPopup(showGifs, () => setShowGifs(false));
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

  // Which relays are worth asking at all — the well-known ones, and whatever
  // the network itself is using
  const [aroundTheNetwork, setAroundTheNetwork] = useState<string[]>([]);
  useEffect(() => {
    if (!relaysConnected) return;
    let cancelled = false;
    discoverGroupRelays().then(found => { if (!cancelled) setAroundTheNetwork(found); });
    return () => { cancelled = true; };
  }, [relaysConnected]);

  // And as the relays themselves know them
  useEffect(() => {
    if (!ownPubkey) return;
    let cancelled = false;
    // Every relay this account might be known at, not only the ones being
    // browsed: a group joined in another client leaves its trace on the relay
    // that holds it and nowhere else
    const asked = Array.from(new Set([
      ...relays,
      ...joined.map(g => g.relay),
      ...KNOWN_GROUP_RELAYS,
      ...aroundTheNetwork
    ]));
    setLookingForMine(true);
    let outstanding = asked.length;

    for (const relay of asked) {
      fetchMyGroupsOn(relay, ownPubkey)
        .then(ids => {
          if (cancelled || ids.length === 0) return;
          setMemberOf(prev => (prev[relay]?.length === ids.length ? prev : { ...prev, [relay]: ids }));
        })
        .finally(() => {
          outstanding -= 1;
          if (!cancelled && outstanding <= 0) setLookingForMine(false);
        });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relays.join(','), joined.length, aroundTheNetwork.join(','), ownPubkey]);

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
    setRunners([]);
    setRoleMeanings({});
    setNotice(null);
    setAskingForCode(false);
    setInviteCode('');
    setLoadingChat(true);

    fetchGroupChat(active, 200)
      .then(({ messages: found, refusal }) => {
        if (cancelled) return;
        setMessages(found);
        // A relay that will not show a group says why, and "private group" is
        // a different thing from a group nobody has spoken in
        if (refusal) setNotice(refusal);
        void loadProfilesFor(found.map(m => m.pubkey));
      })
      .finally(() => { if (!cancelled) setLoadingChat(false); });

    fetchGroupMembers(active).then(found => {
      if (cancelled) return;
      setMembers(found);
      void loadProfilesFor(found.slice(0, 60));
    });

    fetchGroupAdmins(active).then(({ people, meanings }) => {
      if (cancelled) return;
      setRunners(people);
      setRoleMeanings(meanings);
      void loadProfilesFor(people.map(p => p.pubkey));
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

  /**
   * The member list in ranks, as this kind of app always shows it: whoever
   * runs the place at the top under whatever it calls them — admin, king,
   * moderator — and everyone else below.
   */
  const byRank = useMemo(() => {
    const roleOf = new Map(runners.map(r => [r.pubkey, r.role]));
    const ranks = new Map<string, string[]>();

    for (const { pubkey, role } of runners) {
      const held = ranks.get(role) || [];
      if (!held.includes(pubkey)) held.push(pubkey);
      ranks.set(role, held);
    }

    const rest = members.filter(pubkey => !roleOf.has(pubkey));
    // Someone can run a group without the relay listing them as a member
    const ordered = Array.from(ranks.entries())
      .sort((a, b) => rankOrder(a[0]) - rankOrder(b[0]) || a[0].localeCompare(b[0]))
      .map(([role, people]) => ({ role, people }));

    if (rest.length > 0) ordered.push({ role: MEMBER, people: rest.slice(0, 200) });
    return ordered;
  }, [runners, members]);

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

  /**
   * Naming somebody in the message being written. What is typed reads as
   * "@Their Name"; what is published carries their actual address, or they
   * were never really named at all.
   */
  const pickedMentions = useRef(new Map<string, string>());

  const mention = (pubkey: string) => {
    const name = nameFor(pubkey);
    pickedMentions.current.set(name, pubkey);
    addToDraft(`@${name}`);
  };

  /** Anything added to a message is added as its address; the chat draws it */
  const addToDraft = (text: string) => {
    setDraft(current => (current ? `${current.trimEnd()} ${text}` : text));
    draftRef.current?.focus();
  };

  const addPicture = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';   // so the same picture can be picked twice
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

  const send = async () => {
    const content = draft.trim();
    if (!content || !active || sending) return;
    setSending(true);
    try {
      const { content: resolved } = resolveMentionHandles(content, pickedMentions.current);
      const sent = await sendGroupMessage(active, resolved);
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

  const toggleMembership = async (code?: string) => {
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
        await joinGroup(active, code);
        setJoined(prev => [...prev, active]);
        setAskingForCode(false);
        setInviteCode('');
        setNotice(activeInfo?.isOpen
          ? null
          : 'The request is with the group\'s admins now.');
      }
    } catch (error) {
      const said = error instanceof Error ? error.message : String(error);
      setNotice(said);
      // Some relays only say what is missing once asked, so the way to try
      // again with an invitation is put in front of whoever was refused
      if (/invit|code|closed|not allowed|restricted/i.test(said)) setAskingForCode(true);
    }
  };

  /** A closed group takes an invitation; an open one is simply joined */
  const pressJoin = () => {
    if (isJoined) { void toggleMembership(); return; }
    if (activeInfo && !activeInfo.isOpen && !askingForCode) { setAskingForCode(true); return; }
    void toggleMembership(inviteCode.trim() || undefined);
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
        {relays.length === 0 && (
          <div className="groups-empty">
            None yet. Join a group in any nostr app and its server turns up
            here, or add one below.
          </div>
        )}
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
        <h3>Yours</h3>
        {mine.length === 0 && (
          <div className="groups-empty">
            {lookingForMine
              ? 'Looking for the groups you are in…'
              : 'None yet — join one below, and groups joined in other apps show up here too.'}
          </div>
        )}
        {mine.length > 0 && (
          <>
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

        {activeRelay && (
          <>
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
          </>
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
            {!group.isOpen && (
              <span className="groups-item-closed" title="By invitation">🔒</span>
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
                <button type="button" className="groups-join-btn" onClick={pressJoin}>
                  {isJoined ? 'Leave' : askingForCode ? 'Join with code' : 'Join'}
                </button>
              )}
            </header>

            {askingForCode && !isJoined && (
              <div className="groups-invite">
                <input
                  type="text"
                  value={inviteCode}
                  placeholder="invitation code"
                  onChange={e => setInviteCode(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') pressJoin(); }}
                />
                <button type="button" onClick={() => { setAskingForCode(false); setInviteCode(''); }}>
                  Cancel
                </button>
              </div>
            )}

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
                      {/* Whoever said it, with the same card the rest of the
                          app gives: follow, mute, who they are */}
                      <ProfileHoverCard
                        pubkey={message.pubkey}
                        profile={profiles[message.pubkey]}
                        escapesClipping
                        onNavigateToProfile={onNavigateToProfile}
                      >
                        <button
                          type="button"
                          className="groups-message-author"
                          onClick={() => onNavigateToProfile(message.pubkey)}
                        >
                          <EmojiText text={nameFor(message.pubkey)} emojis={profiles[message.pubkey]?.emojis} />
                        </button>
                      </ProfileHoverCard>
                      <time>{new Date((message.created_at || 0) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</time>
                    </span>
                    <RichText
                      inlineImages
                      inlineQuotes
                      content={message.content}
                      eventTags={message.tags}
                      onNavigateToProfile={onNavigateToProfile}
                      onNavigateToNote={onNavigateToNote}
                      onNavigateToTopic={onNavigateToTopic}
                    />
                    {previewableLink(message.content) && (
                      <LinkPreviewCard url={previewableLink(message.content)!} />
                    )}
                  </div>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>

            {canSign ? (
              <div className="groups-composer">
                <textarea
                  ref={draftRef}
                  value={draft}
                  placeholder={`Message ${activeInfo?.name || 'the group'}`}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
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
                        <EmojiPicker onSelect={(mark) => { setShowEmoji(false); addToDraft(mark); }} />
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
                        <GifPicker onSelect={(url) => { setShowGifs(false); addToDraft(url); }} />
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
                  onClick={() => void send()}
                  disabled={sending || !draft.trim()}
                >
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
            <h3>
              Members
              {members.length > 0 && <span className="groups-members-count">{members.length}</span>}
            </h3>
            {byRank.map(({ role, people }) => (
              <div className="groups-rank" key={role}>
                <h4 title={roleMeanings[role] || undefined}>
                  {role === MEMBER ? 'Members' : plural(role)}
                  <span className="groups-members-count">{people.length}</span>
                </h4>
                {people.map(pubkey => (
                  <ProfileHoverCard
                    key={pubkey}
                    pubkey={pubkey}
                    profile={profiles[pubkey]}
                    escapesClipping
                    onNavigateToProfile={onNavigateToProfile}
                  >
                  <button
                    type="button"
                    className="groups-member"
                    // Clicking someone in the list is how a message to them
                    // starts; their profile is a click on their picture in
                    // anything they have said
                    onClick={() => mention(pubkey)}
                    title={`${nameFor(pubkey)}${role === MEMBER ? '' : ` — ${role}`} · click to mention`}
                  >
                    {profiles[pubkey]?.picture
                      ? <img src={profiles[pubkey].picture} alt="" />
                      : <span className="groups-avatar-placeholder">{nameFor(pubkey).charAt(0).toUpperCase()}</span>}
                    <span className={`groups-member-name ${pubkey === ownPubkey ? 'groups-member-you' : ''}`}>
                      <EmojiText text={nameFor(pubkey)} emojis={profiles[pubkey]?.emojis} />
                    </span>
                    {role !== MEMBER && <span className="groups-member-role">{role}</span>}
                  </button>
                  </ProfileHoverCard>
                ))}
              </div>
            ))}
          </>
        )}
      </aside>
    </div>
  );
};

export default GroupsPage;
