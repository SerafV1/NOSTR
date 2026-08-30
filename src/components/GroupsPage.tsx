import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { EVENT_KINDS, NostrEventSigned, UserProfile } from '../types';
import { NostrCore, EventCache } from '../nostr/core';
import { CredentialManager } from '../nostr/crypto';
import {
  GroupAddress,
  GroupInfo,
  GroupRole,
  createGroup,
  fetchGroupChat,
  fetchGroupMessageResponses,
  fetchGroup,
  fetchGroupAdmins,
  fetchGroupMembers,
  fetchGroups,
  fetchMyGroupsOn,
  discoverGroupRelays,
  getGroupRelays,
  groupKey,
  readCommunityAddress,
  KNOWN_GROUP_RELAYS,
  joinGroup,
  joinedGroupsFromCache,
  fetchJoinedGroups,
  leaveGroup,
  reactToGroupMessage,
  replyInGroup,
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
import LiveChatReactions, { ReactionTally } from './LiveChatReactions';
import ZapButton from './ZapButton';
import { ZapIcon, ReplyIcon } from './Icons';
import { customEmojiMap } from '../utils/customEmoji';
import EmojiPicker from './EmojiPicker';
import GifPicker from './GifPicker';
import { BlossomClient } from '../nostr/blossom';
import CommunityRoom from './CommunityRoom';
import ServerRow from './ServerRow';
import { Community } from '../nostr/concordCommunity';
import {
  heldCommunities,
  makeCommunity,
  makeChannel,
  pendingInvites,
  acceptInvite
} from '../nostr/concordStore';
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

/**
 * The message this one answers, where it says so.
 *
 * Groups settled on a different mark than the rest of nostr: 0xchat and
 * Chachi point at what they answer with a 'q' tag, not the 'e' marked
 * "reply" a thread uses. Of 342 messages read off groups.hzrd149.com,
 * groups.0xchat.com and chat.wisp.talk, 38 used 'q' and 4 used 'e' — so
 * reading 'e' alone left almost every reply in a group looking like a
 * remark about nothing.
 *
 * `fromQuote` says the reference came from a 'q', which also carries a note
 * quoted from outside the room. RichText already draws one of those in
 * full, so there is nothing left to announce above it.
 */
const answered = (message: NostrEventSigned): { id: string; fromQuote: boolean } | null => {
  const marked = message.tags.find(t => t[0] === 'e' && t[3] === 'reply')?.[1];
  if (marked) return { id: marked, fromQuote: false };
  // 0xchat writes an empty ["q", "", "", ""] on messages that answer
  // nothing at all, so it is the id that makes it a reference
  const quoted = message.tags.find(t => t[0] === 'q' && t[1])?.[1];
  if (quoted) return { id: quoted, fromQuote: true };
  const plain = message.tags.find(t => t[0] === 'e' && t[1])?.[1];
  return plain ? { id: plain, fromQuote: false } : null;
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
  // A server and a group each have an address of their own, so either can be
  // linked to and opened straight into
  const { server, groupId, communityId } = useParams();
  const navigate = useNavigate();
  const linkedRelay = server ? `wss://${decodeURIComponent(server)}` : null;

  const [relays, setRelays] = useState<string[]>(getGroupRelays);
  /** Which servers are set aside */
  const [muted, setMuted] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('nostr_group_relays_muted') || '[]') as string[];
    } catch {
      return [];
    }
  });
  const [activeRelay, setActiveRelay] = useState<string>(() => linkedRelay || getGroupRelays()[0] || '');
  // The first server to turn up — found or added — is the one opened
  useEffect(() => {
    if (!activeRelay && relays.length > 0) setActiveRelay(relays[0]);
  }, [relays, activeRelay]);

  // Arriving by link: the address says which server, and which group on it.
  // A server nobody here has heard of is added, since being sent one is as
  // good a way of learning about it as any.
  useEffect(() => {
    if (!linkedRelay) return;
    setActiveRelay(linkedRelay);
    if (!relays.includes(linkedRelay)) {
      const next = [...relays, linkedRelay];
      setRelays(next);
      setGroupRelays(next);
    }
    if (groupId) {
      const wanted = decodeURIComponent(groupId);
      setActive(current =>
        current && current.relay === linkedRelay && current.id === wanted
          ? current
          : { relay: linkedRelay, id: wanted });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedRelay, groupId]);

  /** Wherever the reader is, the address says so */
  const addressOf = (relay: string, id?: string): string =>
    `/s/${encodeURIComponent(relayLabel(relay))}${id ? `/${encodeURIComponent(id)}` : ''}`;

  const [copied, setCopied] = useState<string | null>(null);

  const shareLink = async (path: string, what: string) => {
    const link = `${window.location.origin}${path}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Where the clipboard is not allowed, showing it is the next best thing
      setNotice(link);
    }
  };
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
  const [runners, setRunners] = useState<GroupRole[]>([]);
  // Reactions and zaps paid on the messages on screen
  const [responses, setResponses] = useState<NostrEventSigned[]>([]);
  const [replyingTo, setReplyingTo] = useState<NostrEventSigned | null>(null);
  const [roleMeanings, setRoleMeanings] = useState<Record<string, string>>({});
  const [profiles, setProfiles] = useState<Record<string, UserProfile>>({});
  const [loadingChat, setLoadingChat] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [newRelay, setNewRelay] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  // A closed group is joined by invitation: the relay ignores a bare request
  // and wants the code that was handed out with it
  const [inviteCode, setInviteCode] = useState('');
  // Making one of your own
  const [making, setMaking] = useState(false);
  const [newGroup, setNewGroup] = useState({ name: '', about: '', picture: '', open: true, publicGroup: true });
  /**
   * Communities nobody hosts (Concord): the ones this account holds keys for,
   * the one being read, and any invitation waiting in the inbox.
   */
  const [communities, setCommunities] = useState<Community[]>([]);
  const [openCommunity, setOpenCommunity] = useState<string | null>(communityId || null);
  const [openChannel, setOpenChannel] = useState<string | null>(null);
  const [makingCommunity, setMakingCommunity] = useState<{ name: string; about: string } | null>(null);
  const [communityBusy, setCommunityBusy] = useState(false);
  const [communityError, setCommunityError] = useState<string | null>(null);
  const [invitations, setInvitations] = useState<{ from: string; invite: any }[]>([]);
  const [makingBusy, setMakingBusy] = useState(false);
  const [makeError, setMakeError] = useState<string | null>(null);

  const [showEmoji, setShowEmoji] = useState(false);
  const [showGifs, setShowGifs] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [askingForCode, setAskingForCode] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  /**
   * Whether the reader is at the newest message. Scrolling up to read
   * something used to be undone by the next arrival — the room dragged them
   * back down, mid-sentence, every time anyone said anything.
   */
  const atBottomRef = useRef(true);
  /** How many have arrived since they scrolled away, for the way back */
  const [missed, setMissed] = useState(0);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const countedRef = useRef(0);
  /** Until when a scroll counts as the reader's own doing, not the page's */
  const drivenUntil = useRef(0);
  /**
   * How many messages the room holds right now. The scroll listener is
   * attached once per room, so reading the count through it would read the
   * number the room had when it opened — and coming back to the bottom and
   * leaving again would then announce the whole history as new.
   */
  const lengthRef = useRef(0);
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
    // A muted server is kept but not read from, which is the whole of what
    // muting one means
    ])).filter(relay => !muted.includes(relay));

    for (const relay of asked) {
      fetchMyGroupsOn(relay, ownPubkey)
        .then(ids => {
          if (cancelled || ids.length === 0) return;
          setMemberOf(prev => (prev[relay]?.length === ids.length ? prev : { ...prev, [relay]: ids }));
        })
        .catch(() => { /* a relay that will not answer is simply not one of yours */ });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relays.join(','), joined.length, aroundTheNetwork.join(','), ownPubkey, muted.join(',')]);

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

  // Arriving by address, or leaving one: the community open is whatever the
  // address names, and nothing when it names a server instead
  useEffect(() => {
    setOpenCommunity(communityId || null);
    if (communityId) { setActive(null); setMakingCommunity(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [communityId]);

  // What this account holds, and who has asked it in
  useEffect(() => {
    if (!canSign) return;
    setCommunities(heldCommunities());
    if (!relaysConnected) return;
    void pendingInvites()
      .then(setInvitations)
      .catch(error => console.error('[Concord] Could not read invitations:', error));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSign, relaysConnected]);

  const startCommunity = async () => {
    if (!makingCommunity || communityBusy) return;
    const name = makingCommunity.name.trim();
    if (!name) return;
    setCommunityBusy(true);
    setCommunityError(null);
    try {
      const made = await makeCommunity(name, makingCommunity.about.trim());
      setCommunities(heldCommunities());
      setMakingCommunity(null);
      setActive(null);
      navigate(`/c/${made.id}`);
    } catch (error) {
      setCommunityError(error instanceof Error ? error.message : 'Could not make it');
    } finally {
      setCommunityBusy(false);
    }
  };

  // A group's conversation, and whatever is said while it is open
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let stop: (() => void) | null = null;

    setMessages([]);
    setMembers([]);
    setRunners([]);
    setRoleMeanings({});
    setResponses([]);
    setReplyingTo(null);
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

  /**
   * To the newest message, and stay there while the room settles.
   *
   * Messages are marked skippable while off screen, so their height is a
   * guess until the browser draws them — one scroll to the bottom landed two
   * thousand pixels short of it as the guesses turned into real rows, and a
   * picture finishing does the same. So it is nudged each frame until the
   * room stops growing, for at most a second.
   *
   * A scroll up during that second ends it: the reader has said where they
   * want to be, and nothing here may argue.
   */
  const stickToBottom = () => {
    const list = messagesRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
  };

  lengthRef.current = messages.length;

  const jumpToLatest = () => {
    atBottomRef.current = true;
    setAwayFromBottom(false);
    setMissed(0);
    countedRef.current = messages.length;
    stickToBottom();
  };

  /**
   * A room settles for a while after it opens: messages are marked skippable
   * while off screen, so their height is a guess until they are drawn, and
   * every picture that finishes moves the bottom further down. One scroll,
   * or even a second of them, landed two thousand pixels short in a room of
   * two hundred messages.
   *
   * So while the reader is at the newest message, the room is held there —
   * and the moment they scroll away it stops, which is the whole point of
   * the button below.
   */
  useEffect(() => {
    const list = messagesRef.current;
    if (!list) return;
    let lastHeight = 0;
    const hold = setInterval(() => {
      if (!atBottomRef.current) return;
      if (list.scrollHeight === lastHeight) return;
      lastHeight = list.scrollHeight;
      stickToBottom();
    }, 250);
    return () => clearInterval(hold);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.relay, active?.id]);

  /**
   * Reading further up is a decision, and it holds: what arrives while it
   * holds is counted rather than scrolled to, and the count is the way back.
   *
   * Only the reader takes the room off its newest message. A scroll on its
   * own does not say who did it, and the page does plenty of its own —
   * every picture that finishes drawing moves the bottom. Read as the
   * reader's, those scrolls stopped the page mid-scroll and left the room
   * hanging fifteen hundred pixels above the last message. So a hand on the
   * wheel, a finger on the glass or a key opens a moment in which a scroll
   * away from the bottom counts; outside it, only arriving at the bottom
   * does.
   */
  useEffect(() => {
    const list = messagesRef.current;
    if (!list) return;

    const atBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 60;

    const read = () => {
      if (atBottom()) {
        atBottomRef.current = true;
        setAwayFromBottom(false);
        setMissed(0);
        countedRef.current = lengthRef.current;
        return;
      }
      if (performance.now() < drivenUntil.current) {
        atBottomRef.current = false;
        setAwayFromBottom(true);
      }
    };

    // A gesture, and the moment after it in which the scrolling it caused
    // actually happens
    const driving = () => { drivenUntil.current = performance.now() + 500; };

    list.addEventListener('scroll', read, { passive: true });
    list.addEventListener('wheel', driving, { passive: true });
    list.addEventListener('touchmove', driving, { passive: true });
    list.addEventListener('mousedown', driving, { passive: true });
    list.addEventListener('keydown', driving);
    return () => {
      list.removeEventListener('scroll', read);
      list.removeEventListener('wheel', driving);
      list.removeEventListener('touchmove', driving);
      list.removeEventListener('mousedown', driving);
      list.removeEventListener('keydown', driving);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.relay, active?.id]);

  // A room just opened is read from its newest message, whatever the last
  // one was doing
  useEffect(() => {
    atBottomRef.current = true;
    setAwayFromBottom(false);
    setMissed(0);
    countedRef.current = 0;
  }, [active?.relay, active?.id]);

  useEffect(() => {
    if (atBottomRef.current) {
      stickToBottom();
      countedRef.current = messages.length;
      return;
    }
    // Arrivals while reading further up: counted from where they stopped
    // following, so a burst of ten says ten
    const since = messages.length - countedRef.current;
    if (since > 0) setMissed(since);
  }, [messages.length, active?.id]);

  // What has been said about what is on screen. Asked once the messages are
  // in, and again when new ones arrive, in one query for the lot of them.
  useEffect(() => {
    if (!active || messages.length === 0) return;
    let cancelled = false;
    const ids = messages.slice(-120).map(m => m.id);
    fetchGroupMessageResponses(active, ids).then(found => {
      if (cancelled) return;
      setResponses(prev => {
        const byId = new Map(prev.map(e => [e.id, e]));
        for (const event of found) byId.set(event.id, event);
        return Array.from(byId.values());
      });
      void loadProfilesFor(found.map(e => e.pubkey));
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.relay, active?.id, messages.length]);

  /** Reactions under each message, and what has been paid on it */
  const chatter = useMemo(() => {
    const byMessage = new Map<string, { tallies: ReactionTally[]; sats: number }>();
    const seenReactors = new Map<string, Set<string>>();

    for (const event of responses) {
      const target = event.tags.filter(t => t[0] === 'e').pop()?.[1];
      if (!target) continue;
      const held = byMessage.get(target) || { tallies: [], sats: 0 };

      if (event.kind === EVENT_KINDS.ZAP_RECEIPT) {
        held.sats += NostrCore.parseZapAmountSats(event);
        byMessage.set(target, held);
        continue;
      }

      // The same person reacting twice with the same thing is one reaction
      const mark = event.content.trim() || '❤️';
      const key = `${target}|${mark}`;
      const reactors = seenReactors.get(key) || new Set<string>();
      if (reactors.has(event.pubkey)) continue;
      reactors.add(event.pubkey);
      seenReactors.set(key, reactors);

      const already = held.tallies.find(t => t.emoji === mark);
      const picture = customEmojiMap(event.tags)[mark.replace(/:/g, '')];
      if (already) {
        already.count += 1;
        already.mine = already.mine || event.pubkey === ownPubkey;
        already.image = already.image || picture;
      } else {
        held.tallies.push({ emoji: mark, count: 1, mine: event.pubkey === ownPubkey, image: picture });
      }
      byMessage.set(target, held);
    }

    return byMessage;
  }, [responses, ownPubkey]);

  const react = async (message: NostrEventSigned, emoji: string) => {
    if (!active) return;
    try {
      const sent = await reactToGroupMessage(active, message, emoji);
      setResponses(prev => [...prev, sent]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

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

  /**
   * One list rather than two: the groups on this server, with the ones this
   * account is in at the top of it. A second list of your own repeated every
   * row that was already a few lines below it.
   */
  const shownGroups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matching = needle
      ? activeGroups.filter(g =>
          g.name.toLowerCase().includes(needle) || g.about.toLowerCase().includes(needle))
      : activeGroups;

    const mineHere = new Set([
      ...joined.filter(g => g.relay === activeRelay).map(g => g.id),
      ...(memberOf[activeRelay] || [])
    ]);

    return [...matching].sort((a, b) => {
      const aMine = mineHere.has(a.id) ? 0 : 1;
      const bMine = mineHere.has(b.id) ? 0 : 1;
      return aMine - bMine || (b.members || 0) - (a.members || 0);
    });
  }, [activeGroups, search, joined, memberOf, activeRelay]);

  const openGroup = (address: GroupAddress) => {
    setNotice(null);
    setActive(address);
    if (address.relay !== activeRelay) setActiveRelay(address.relay);
    navigate(addressOf(address.relay, address.id));
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
      const sent = replyingTo
        ? await replyInGroup(active, replyingTo, resolved)
        : await sendGroupMessage(active, resolved);
      setReplyingTo(null);
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

  /**
   * A group of one's own. The relay is asked to make it and then told what it
   * is called — a relay that does not let strangers make groups says so, and
   * saying that plainly beats leaving a half-made room behind.
   */
  const makeGroup = async () => {
    if (!activeRelay || !newGroup.name.trim() || makingBusy) return;
    setMakingBusy(true);
    setMakeError(null);
    try {
      // An address of its own, so two groups made the same minute cannot land
      // on top of one another
      const id = `${newGroup.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20) || 'group'}-${Math.random().toString(36).slice(2, 8)}`;
      const address = await createGroup(activeRelay, id, {
        name: newGroup.name.trim(),
        about: newGroup.about.trim() || undefined,
        picture: newGroup.picture || undefined,
        open: newGroup.open,
        publicGroup: newGroup.publicGroup
      });

      setMaking(false);
      setNewGroup({ name: '', about: '', picture: '', open: true, publicGroup: true });
      setJoined(prev => [...prev, address]);
      setGroupsByRelay(prev => ({ ...prev, [activeRelay]: [] }));  // read the relay's list afresh
      setActive(address);
    } catch (error) {
      setMakeError(
        `${error instanceof Error ? error.message : String(error)} — not every relay lets anyone make a group.`
      );
    } finally {
      setMakingBusy(false);
    }
  };

  const pickGroupPicture = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadPct(0);
    try {
      const blob = await BlossomClient.uploadFile(file, undefined, setUploadPct);
      setNewGroup(current => ({ ...current, picture: blob.url }));
    } catch (error) {
      setMakeError(error instanceof Error ? error.message : 'Could not upload that picture');
    } finally {
      setUploadPct(null);
    }
  };

  /**
   * A muted server stays in the list and keeps its groups, but is not read
   * from — the quiet way to keep one without it filling the column.
   */
  const toggleMuted = (url: string) => {
    const next = muted.includes(url) ? muted.filter(held => held !== url) : [...muted, url];
    setMuted(next);
    try {
      localStorage.setItem('nostr_group_relays_muted', JSON.stringify(next));
    } catch {
      // Storage full: it simply comes back unmuted next time
    }
    if (!muted.includes(url) && activeRelay === url) {
      setActiveRelay(next.length > 0 ? relays.find(r => !next.includes(r)) || '' : relays[0] || '');
      setActive(null);
    }
  };

  const removeServer = (url: string) => {
    const next = relays.filter(held => held !== url);
    setRelays(next);
    setGroupRelays(next);
    if (activeRelay === url) {
      const first = next[0] || '';
      setActiveRelay(first);
      setActive(null);
      navigate(first ? addressOf(first) : '/s');
    }
  };

  /**
   * Adding a community, however it was handed over: the relay's own address,
   * a link from this app, or the `naddr` other clients pass around — which
   * carries the group and the relay holding it inside itself.
   */
  const addCommunity = () => {
    const address = readCommunityAddress(newRelay);
    if (!address) {
      setAddError("That doesn't look like a community — paste its address, a link to it, or its naddr.");
      return;
    }

    setAddError(null);
    const next = Array.from(new Set([...relays, address.relay]));
    setRelays(next);
    setGroupRelays(next);
    setNewRelay('');
    setAdding(false);
    setActiveRelay(address.relay);

    if (address.id) openGroup({ relay: address.relay, id: address.id });
    else navigate(addressOf(address.relay));
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
        {/* What can be done with a server belongs to that server, not to a
            row underneath the list: with several of them, one button below
            said nothing about which one it meant. */}
        {relays.map(url => (
          <ServerRow
            key={url}
            url={url}
            label={relayLabel(url)}
            // Only one place can be the place you are: with a community open,
            // the server behind it is where you were, not where you are
            active={!openCommunity && url === activeRelay}
            muted={muted.includes(url)}
            shared={copied === `server:${url}`}
            onOpen={() => {
              // Leaving the community behind is the point: its channels were
              // standing where this server's groups belong
              setOpenCommunity(null);
              setOpenChannel(null);
              setActiveRelay(url);
              setActive(null);
              navigate(addressOf(url));
            }}
            onShare={() => void shareLink(addressOf(url), `server:${url}`)}
            onToggleMute={() => toggleMuted(url)}
            onRemove={() => removeServer(url)}
          />
        ))}

        {canSign && (
          <div className="groups-encrypted">
            <h2>No server</h2>
            {communities.map(info => (
              <button
                key={info.id}
                type="button"
                className={`groups-relay ${info.id === openCommunity ? 'active' : ''}`}
                onClick={() => {
                  setOpenChannel(null);
                  navigate(`/c/${info.id}`);
                }}
                title={info.description || 'Encrypted community'}
              >
                🔒 {info.name}
              </button>
            ))}

            {invitations.map(({ from, invite }) => (
              <button
                key={invite.community_id}
                type="button"
                className="groups-invitation"
                title={`Invited by ${formatAddress(from)}`}
                onClick={async () => {
                  const joined = await acceptInvite(invite);
                  setInvitations(current => current.filter(i => i.invite.community_id !== invite.community_id));
                  setCommunities(heldCommunities());
                  setActive(null);
                  navigate(`/c/${joined.id}`);
                }}
              >
                ✉ Join {invite.name}
              </button>
            ))}

            <button
              type="button"
              className="groups-add-community"
              onClick={() => {
                setMakingCommunity({ name: '', about: '' });
                setOpenCommunity(null);
                setActive(null);
              }}
            >
              + Encrypted community
            </button>
          </div>
        )}

        {!adding ? (
          <button type="button" className="groups-add-community" onClick={() => setAdding(true)}>
            + Add server
          </button>
        ) : (
          <div className="groups-add-community-form">
            <input
              type="text"
              value={newRelay}
              autoFocus
              placeholder="address, link or naddr"
              onChange={e => { setNewRelay(e.target.value); setAddError(null); }}
              onKeyDown={e => {
                if (e.key === 'Enter') addCommunity();
                if (e.key === 'Escape') { setAdding(false); setAddError(null); }
              }}
            />
            <div className="groups-add-community-buttons">
              <button type="button" onClick={() => { setAdding(false); setAddError(null); }}>Cancel</button>
              <button type="button" className="groups-join-btn" onClick={addCommunity}>Add</button>
            </div>
            {addError && <p className="groups-empty">{addError}</p>}
            <p className="groups-empty">
              Anything works: wss://groups.example.com, a link somebody sent, or the naddr another
              app hands out.
            </p>
          </div>
        )}
      </aside>

      {/* What is open: a community's channels, or the server's groups. Both
          lists in the same column at once was the confusion — the groups of a
          server nobody was reading stayed on screen beside a community. */}
      {openCommunity ? (
        <nav className="groups-list">
          {(() => {
            const info = communities.find(c => c.id === openCommunity);
            if (!info) return null;
            return (
              <>
                <h3>{info.name}</h3>
                {info.channels.map(channel => (
                  <button
                    key={channel.id}
                    type="button"
                    className={`groups-item ${channel.id === openChannel ? 'active' : ''}`}
                    onClick={() => setOpenChannel(channel.id)}
                  >
                    <span className="groups-item-name">#{channel.name}</span>
                    {channel.private && <span className="groups-item-in" title="Private channel">🔒</span>}
                  </button>
                ))}
                {/* Anyone holding the control key can add one; for now that
                    is the founder, until grants are written (CORD-04) */}
                {info.ownerPubkey === ownPubkey && (
                  <button
                    type="button"
                    className="groups-add-community"
                    onClick={async () => {
                      const name = window.prompt('What is the channel called?')?.trim();
                      if (!name) return;
                      try {
                        const updated = await makeChannel(info, name.replace(/^#/, ''));
                        setCommunities(heldCommunities());
                        setOpenChannel(updated.channels[updated.channels.length - 1].id);
                      } catch (error) {
                        alert(error instanceof Error ? error.message : 'Could not add that channel');
                      }
                    }}
                  >
                    + New channel
                  </button>
                )}

                <p className="groups-empty">
                  No server holds this one. Only the people with its key can read a word of it.
                </p>
              </>
            );
          })()}
        </nav>
      ) : (
      <nav className="groups-list">
        {activeRelay && (
          <>
            <h3>
              On {relayLabel(activeRelay)}
            </h3>

            {canSign && (
              <button
                type="button"
                className="groups-make-way"
                onClick={() => { setMaking(true); setMakeError(null); }}
                title={`Make a group on ${relayLabel(activeRelay)}`}
              >
                <strong>+ New group</strong>
                <span>Public or private, held by this server</span>
              </button>
            )}
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
      )}

      {making && (
        <div className="groups-make-overlay" onClick={() => !makingBusy && setMaking(false)}>
          <div className="groups-make" onClick={e => e.stopPropagation()}>
            <h3>New group on {relayLabel(activeRelay)}</h3>

            <label>
              Name
              <input
                type="text"
                value={newGroup.name}
                autoFocus
                onChange={e => setNewGroup({ ...newGroup, name: e.target.value })}
              />
            </label>

            <label>
              What it is for
              <textarea
                value={newGroup.about}
                rows={3}
                onChange={e => setNewGroup({ ...newGroup, about: e.target.value })}
              />
            </label>

            <div className="groups-make-picture">
              {newGroup.picture
                ? <img src={newGroup.picture} alt=""  loading="lazy" decoding="async" />
                : <span className="groups-avatar-placeholder">{(newGroup.name || '?').charAt(0).toUpperCase()}</span>}
              <label className="groups-upload">
                {uploadPct === null ? 'Choose a picture' : `${uploadPct}%`}
                <input type="file" accept="image/*" hidden onChange={pickGroupPicture} />
              </label>
              {newGroup.picture && (
                <button type="button" onClick={() => setNewGroup({ ...newGroup, picture: '' })}>Remove</button>
              )}
            </div>

            {/* The two flags a NIP-29 relay actually keeps were a pair of
                checkboxes nobody read as "make this private". They are the
                same two flags; this says what they mean together. */}
            <div className="groups-make-kind">
              <button
                type="button"
                className={newGroup.publicGroup ? 'chosen' : ''}
                onClick={() => setNewGroup({ ...newGroup, publicGroup: true, open: true })}
              >
                <strong>Public</strong>
                <span>Anyone may read it, and anyone may join</span>
              </button>
              <button
                type="button"
                className={!newGroup.publicGroup ? 'chosen' : ''}
                onClick={() => setNewGroup({ ...newGroup, publicGroup: false, open: false })}
              >
                <strong>Private</strong>
                <span>
                  Only members may read it, and joining is by invitation. The server
                  holding it enforces that — and can read what is said.
                </span>
              </button>
            </div>

            {newGroup.publicGroup && (
              <label className="groups-make-flag">
                <input
                  type="checkbox"
                  checked={newGroup.open}
                  onChange={e => setNewGroup({ ...newGroup, open: e.target.checked })}
                />
                Anyone may join without being asked in
              </label>
            )}

            {makeError && <div className="groups-notice">{makeError}</div>}

            <div className="groups-make-buttons">
              <button type="button" onClick={() => setMaking(false)} disabled={makingBusy}>Cancel</button>
              <button
                type="button"
                className="groups-join-btn"
                onClick={() => void makeGroup()}
                disabled={makingBusy || !newGroup.name.trim()}
              >
                {makingBusy ? 'Making…' : 'Make it'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Founding one */}
      {makingCommunity && (
        <div className="groups-make-overlay">
          <div className="groups-make">
            <h3>New encrypted community</h3>
            <p className="dm-make-note">
              No server holds this one. Its messages are readable only by the people holding
              its key — not by any relay, and not by whoever runs one. You are its owner, and
              what it is stays inside the community's own signed state, where no relay can
              change it.
            </p>

            <label>
              Name
              <input
                type="text"
                value={makingCommunity.name}
                autoFocus
                maxLength={64}
                onChange={e => setMakingCommunity({ ...makingCommunity, name: e.target.value })}
              />
            </label>

            <label>
              What it is for
              <input
                type="text"
                value={makingCommunity.about}
                maxLength={200}
                onChange={e => setMakingCommunity({ ...makingCommunity, about: e.target.value })}
              />
            </label>

            {communityError && <div className="groups-notice">{communityError}</div>}

            <div className="groups-make-buttons">
              <button type="button" onClick={() => setMakingCommunity(null)} disabled={communityBusy}>
                Cancel
              </button>
              <button
                type="button"
                className="groups-join-btn"
                onClick={() => void startCommunity()}
                disabled={communityBusy || !makingCommunity.name.trim()}
              >
                {communityBusy ? 'Making…' : 'Make it'}
              </button>
            </div>
          </div>
        </div>
      )}

      {openCommunity && (
        <CommunityRoom
          communityId={openCommunity}
          relaysConnected={relaysConnected}
          onNavigateToProfile={onNavigateToProfile}
          onNavigateToNote={onNavigateToNote}
          onNavigateToTopic={onNavigateToTopic}
          channelId={openChannel}
          onChannelChange={channel => setOpenChannel(channel.id)}
          onLeft={() => {
            setOpenChannel(null);
            setCommunities(heldCommunities());
            navigate(activeRelay ? addressOf(activeRelay) : '/s');
          }}
          onChanged={() => setCommunities(heldCommunities())}
        />
      )}

      {/* The conversation */}
      {!openCommunity && <section className="groups-chat">
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
              <button
                type="button"
                className="groups-share-btn"
                onClick={() => void shareLink(addressOf(active.relay, active.id), 'group')}
                title="Copy a link to this group"
              >
                {copied === 'group' ? 'Link copied' : 'Share'}
              </button>
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

            <div className="groups-messages" ref={messagesRef}>
              {loadingChat && <div className="groups-empty">Reading…</div>}
              {!loadingChat && messages.length === 0 && (
                <div className="groups-empty">Nobody has said anything yet.</div>
              )}
              {messages.map(message => (
                <div
                  key={message.id}
                  id={`msg-${message.id}`}
                  className={replyingTo?.id === message.id ? 'groups-message groups-message-active' : 'groups-message'}
                >
                  <button
                    type="button"
                    className="groups-message-who"
                    onClick={() => onNavigateToProfile(message.pubkey)}
                  >
                    {profiles[message.pubkey]?.picture
                      ? <img src={profiles[message.pubkey].picture} alt=""  loading="lazy" decoding="async" />
                      : <span className="groups-avatar-placeholder">{nameFor(message.pubkey).charAt(0).toUpperCase()}</span>}
                  </button>
                  <div className="groups-message-body">
                    {message.kind === EVENT_KINDS.GROUP_THREAD
                      && message.tags.find(t => t[0] === 'subject')?.[1] && (
                      <span className="groups-message-subject">
                        {message.tags.find(t => t[0] === 'subject')![1]}
                      </span>
                    )}
                    {/* Every message in a room stands on the same line as the
                        rest — who it answers is a detail of the message, not
                        a place to put it. Drawing replies underneath what
                        they answered was tried and taken back out: it moved
                        the 12% that answer anything out of the clock's order,
                        and the room stopped reading top to bottom. */}
                    {(() => {
                      const ref = answered(message);
                      if (!ref) return null;
                      const to = messages.find(m => m.id === ref.id);
                      // A note quoted from outside the room is drawn in the
                      // message itself — saying "↳ an earlier message" over
                      // it would point at something that is not here
                      if (!to && ref.fromQuote) return null;
                      return (
                        <button
                          type="button"
                          className="groups-answering"
                          onClick={() => {
                            if (to) document.getElementById(`msg-${to.id}`)?.scrollIntoView({ block: 'center' });
                          }}
                        >
                          ↳ {to
                            ? `${nameFor(to.pubkey)}: ${to.content.replace(/\s+/g, ' ').slice(0, 48)}`
                            : 'an earlier message'}
                        </button>
                      );
                    })()}
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

                    <LiveChatReactions
                      tallies={chatter.get(message.id)?.tallies || []}
                      canReact={canSign}
                      onReact={(mark) => void react(message, mark)}
                    />

                    {canSign && (
                      <div className="groups-message-actions">
                        <button type="button" onClick={() => setReplyingTo(message)} title="Reply">
                          <ReplyIcon />
                        </button>
                        <ZapButton
                          lud16={profiles[message.pubkey]?.lud16}
                          triggerClassName="groups-message-zap"
                          triggerTitle={`Zap ${nameFor(message.pubkey)}`}
                          recipientPubkey={message.pubkey}
                          eventId={message.id}
                          recipientName={nameFor(message.pubkey)}
                          recipientPicture={profiles[message.pubkey]?.picture}
                          recipientEmojis={profiles[message.pubkey]?.emojis}
                        >
                          <ZapIcon />
                          {(chatter.get(message.id)?.sats || 0) > 0 && (
                            <span>{chatter.get(message.id)!.sats.toLocaleString()}</span>
                          )}
                        </ZapButton>
                      </div>
                    )}
                  </div>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>

            {/* Only while it is of any use: at the newest message there is
                nowhere to jump to */}
            {awayFromBottom && messages.length > 0 && (
              <button
                type="button"
                className={`groups-jump-latest${missed > 0 ? ' unread' : ''}`}
                onClick={jumpToLatest}
              >
                ↓ {missed > 0
                  ? `${missed} new message${missed === 1 ? '' : 's'}`
                  : 'Jump to latest'}
              </button>
            )}

            {canSign ? (
              <div className="groups-composer">
                {replyingTo && (
                  <div className="groups-replying">
                    {/* Who and which message, the same two things the line
                        above a sent reply carries — a room where the same
                        person has said several things needs the second one
                        to know which is being answered */}
                    <span className="groups-replying-what">
                      ↳ Replying to {nameFor(replyingTo.pubkey)}
                      {(() => {
                        // A picture on its own has nothing to quote back
                        const said = replyingTo.content.replace(/\s+/g, ' ').trim();
                        return said ? `: ${said.slice(0, 48)}` : '';
                      })()}
                    </span>
                    <button type="button" onClick={() => setReplyingTo(null)} title="Never mind">✕</button>
                  </div>
                )}
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
      </section>}

      {/* Who is in it */}
      {!openCommunity && <aside className="groups-members">
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
                      ? <img src={profiles[pubkey].picture} alt=""  loading="lazy" decoding="async" />
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
      </aside>}
    </div>
  );
};

export default GroupsPage;
