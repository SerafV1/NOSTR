import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { NostrEventSigned, UserProfile, EVENT_KINDS } from '../types';
import { NostrCore } from '../nostr/core';
import { CredentialManager } from '../nostr/crypto';
import RichText from './RichText';
import { formatAddress } from '../utils/helpers';
import { resolveMentionHandles, handleFromName, detectMentionTrigger } from '../utils/mentions';
import { EventCache } from '../nostr/core';
import EmojiPicker from './EmojiPicker';
import GifPicker from './GifPicker';
import ZapButton from './ZapButton';
import { ZapIcon, ImageIcon } from './Icons';
import { BlossomClient } from '../nostr/blossom';
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

/**
 * When something was said, to the minute — seconds say nothing in a chat.
 *
 * On a 24-hour clock whatever the browser's language would prefer: in a
 * column this narrow the "PM" is the first thing to be cut off, and half a
 * 12-hour clock is worse than none — 6:30 read as morning where the person
 * who said it saw 18:30.
 */
const atTime = (createdAt?: number): string =>
  createdAt
    ? new Date(createdAt * 1000).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
      })
    : '';

/** How many past zaps the chat keeps alongside the talk */
const CHAT_ZAP_HISTORY = 15;

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

/**
 * The last lines of a chat, kept so a window that reopens has something to
 * show at once.
 *
 * A browser source in OBS is reloaded constantly, and every reload asked the
 * relays from nothing: measured at three and a half seconds of an empty
 * overlay before the first message appeared. These are that stream's own
 * messages under that stream's own address, so what comes back is the same
 * chat, filled in and replaced the moment the relays answer.
 */
/** How long after speaking somebody still counts as being here */
const PRESENT_FOR_MS = 10 * 60 * 1000;

const CHAT_MEMORY = 'razr_livechat';
/**
 * The stream's own mute list, kept for the same reason.
 *
 * Nothing is drawn until this list is known — showing a line and taking it
 * back once the host's mutes arrive is worse than a moment's wait — and that
 * wait was most of the delay before an overlay showed anything. A list from
 * the last time this window was open is a far better starting point than
 * none, and the relays replace it a second later.
 */
const MUTE_MEMORY = 'razr_stream_mutes';
const CHAT_MEMORY_LINES = 60;
const CHAT_MEMORY_STREAMS = 3;

const rememberedMutes = (address: string): string[] | null => {
  try {
    const held = JSON.parse(localStorage.getItem(MUTE_MEMORY) || '{}') as Record<string, string[]>;
    return Array.isArray(held[address]) ? held[address] : null;
  } catch {
    return null;
  }
};

const rememberMutes = (address: string, muted: string[]): void => {
  try {
    const held = JSON.parse(localStorage.getItem(MUTE_MEMORY) || '{}') as Record<string, string[]>;
    held[address] = muted;
    localStorage.setItem(MUTE_MEMORY, JSON.stringify(Object.fromEntries(Object.entries(held).slice(-CHAT_MEMORY_STREAMS))));
  } catch {
    // Then it is read from the relays, as before
  }
};

const rememberedChat = (address: string): NostrEventSigned[] => {
  try {
    const held = JSON.parse(localStorage.getItem(CHAT_MEMORY) || '{}') as Record<string, NostrEventSigned[]>;
    const lines = held[address];
    return Array.isArray(lines) ? lines : [];
  } catch {
    return [];
  }
};

const rememberChat = (address: string, messages: NostrEventSigned[]): void => {
  try {
    const held = JSON.parse(localStorage.getItem(CHAT_MEMORY) || '{}') as Record<string, NostrEventSigned[]>;
    held[address] = messages.slice(-CHAT_MEMORY_LINES);
    const trimmed = Object.fromEntries(Object.entries(held).slice(-CHAT_MEMORY_STREAMS));
    localStorage.setItem(CHAT_MEMORY, JSON.stringify(trimmed));
  } catch {
    // A window that cannot store them simply waits for the relays, as before
  }
};

const LiveChatPanel: React.FC<LiveChatPanelProps> = ({ address, relayHint, disabled, onNavigateToProfile, onNavigateToNote, onNavigateToTopic, relaysConnected = true, onPopOut, onPeoplePresent, hideComposer, obsLink, owners = [], identifier, transparent, bold, onDisplayChange }) => {
  const [messages, setMessages] = useState<NostrEventSigned[]>(() => rememberedChat(address));
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
  const [streamMuted, setStreamMuted] = useState<Set<string>>(() => new Set(rememberedMutes(address) || []));
  // Until the list has been read, showing the chat would show whoever was
  // thrown out — for the second or two the read takes — and then take them
  // back off screen. Better to hold the messages for that moment.
  // A list already known is a list read: the relays are asked again anyway,
  // and what they say replaces it
  const [muteListRead, setMuteListRead] = useState(() => rememberedMutes(address) !== null);
  /**
   * What this window has just decided, until the relays agree. Publishing a
   * change takes seconds, and in the meantime the subscription delivers the
   * previous version of the list — which would undo on screen what was just
   * asked for.
   */
  const pendingMute = useRef<Map<string, boolean>>(new Map());
  /** Shown after muting: what just happened, and the way to take it back */
  const [justMuted, setJustMuted] = useState<
    { pubkey: string; name: string; forEveryone: boolean } | null
  >(null);
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
  /**
   * Reaching back through a long stream.
   *
   * The chat opens on the last two hundred lines, which after five hours is
   * the tail of the evening. Scrolling to the top asks for what came before
   * it, a screenful at a time, until the relays have no more to give.
   */
  const [olderState, setOlderState] = useState<'unknown' | 'idle' | 'loading' | 'done'>('unknown');
  /** The address the question "is there anything earlier?" was asked about */
  const probed = useRef<string | null>(null);
  /** The height before older lines were put in, so the view can stay put */
  const heldHeight = useRef<number | null>(null);
  /**
   * Whether the reader was at the bottom before the last line arrived.
   *
   * Judged after the fact it is wrong: by then the new message is already in
   * the list, and a tall one — a picture, an embedded video — puts the
   * bottom further away than any threshold. The chat then stops following
   * and sits there, which is exactly what it looked like.
   */
  const atBottom = useRef(true);
  /** Something arrived while the reader was up in the history */
  const [missed, setMissed] = useState(false);
  /** Ticks so presence ages out while the page sits open */
  const [presenceTick, setPresenceTick] = useState(0);

  useEffect(() => {
    const tick = setInterval(() => setPresenceTick(n => n + 1), 30000);
    return () => clearInterval(tick);
  }, []);
  const inputRef = useRef<HTMLInputElement>(null);
  const profilesRef = useRef<Map<string, UserProfile>>(new Map());
  const isLoggedIn = CredentialManager.isLoggedIn();
  profilesRef.current = profiles;

  // The panel clips anything that reaches outside it, and the picker is wider
  // than the button it hangs off — anchored in CSS it was cut to a strip
  const emoji = useAnchoredPopup(showEmojiPicker, () => setShowEmojiPicker(false));
  const [showGifPicker, setShowGifPicker] = useState(false);
  const gifPicker = useAnchoredPopup(showGifPicker, () => setShowGifPicker(false));
  // How far the picture being sent has got, or null when none is going up
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
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
    let zapSubId: string | null = null;

    (async () => {
      const [history, zapHistory] = await Promise.all([
        NostrCore.fetchLiveChatMessages(address),
        NostrCore.fetchLiveZaps(address)
      ]);
      if (cancelled) return;
      // Merged with what is already there — the remembered lines, or what a
      // subscription delivered while this was in flight. A quick answer from
      // one relay holds less than the last window did, and replacing with it
      // made the chat empty itself and fill again a moment later.
      if (history.length > 0) {
        setMessages(prev => {
          const byId = new Map(prev.map(m => [m.id, m]));
          for (const message of history) byId.set(message.id, message);
          const merged = [...byId.values()].sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
          rememberChat(address, merged);
          return merged;
        });
      }
      setZaps(zapHistory);

      // Then the same question again, this time waiting for every relay: the
      // first answer comes from whichever replies first and is routinely
      // missing messages the others hold, which looked like a chat that had
      // stopped updating until it was reloaded
      // Deeper than the quick answer: a busy stream says more in an evening
      // than two hundred lines
      NostrCore.fetchLiveChatMessages(address, 500, true).then(complete => {
        if (cancelled || complete.length === 0) return;
        setMessages(prev => {
          const byId = new Map(prev.map(m => [m.id, m]));
          for (const message of complete) byId.set(message.id, message);
          const merged = [...byId.values()].sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
          rememberChat(address, merged);
          return merged;
        });
        NostrCore.fetchProfiles(complete.map(m => m.pubkey)).then(found => {
          if (!cancelled) setProfiles(prev => new Map([...prev, ...found]));
        });
      });

      const zapParties = zapHistory
        .flatMap(zap => [NostrCore.zapSenderPubkey(zap), NostrCore.zapRecipientPubkey(zap)])
        .filter((pubkey): pubkey is string => !!pubkey);
      const profileMap = await NostrCore.fetchProfiles([
        ...history.map(m => m.pubkey),
        ...zapParties
      ]);
      if (!cancelled) setProfiles(profileMap);

      // Zaps come through a subscription of their own, with no `since`, so
      // the relays replay everything the stream has taken. Asked for as
      // history instead, they came back empty on streams whose zaps the
      // zappers panel — which subscribes exactly this way — listed a dozen of.
      zapSubId = NostrCore.subscribeLive(
        [{ kinds: [EVENT_KINDS.ZAP_RECEIPT], '#a': [address] }],
        (event) => {
          if (!NostrCore.zapIsShowable(event)) return;
          setZaps(prev => {
            if (prev.some(z => z.id === event.id)) return prev;
            // The relays replay every zap the stream has ever taken; a chat
            // is a conversation, not a ledger, so only the recent ones sit
            // in it. The zappers panel keeps the full tally.
            return [...prev, event]
              .sort((a, b) => (a.created_at || 0) - (b.created_at || 0))
              .slice(-CHAT_ZAP_HISTORY);
          });
          const sender = NostrCore.zapSenderPubkey(event);
          const recipient = NostrCore.zapRecipientPubkey(event);
          const unknown = [sender, recipient]
            .filter((pubkey): pubkey is string => !!pubkey && !profilesRef.current.has(pubkey));
          if (unknown.length) {
            NostrCore.fetchProfiles(unknown).then(found => {
              if (!cancelled) setProfiles(prev => new Map([...prev, ...found]));
            });
          }
        }
      );

      const since = Math.floor(Date.now() / 1000);
      subId = NostrCore.subscribeLive(
        [{ kinds: [EVENT_KINDS.LIVE_CHAT_MESSAGE], '#a': [address], since }],
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
      if (zapSubId) NostrCore.unsubscribeLive(zapSubId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, relaysConnected]);

  useEffect(() => {
    // Nothing to wait for only when there is no list to read. Before the
    // relays are up there is nothing to show either, so the flag stays down
    // rather than letting the first messages through unchecked.
    if (!identifier || owners.length === 0) {
      setMuteListRead(true);
      return;
    }
    if (!relaysConnected) return;
    let cancelled = false;

    NostrCore.fetchStreamMuteList(owners, identifier).then(list => {
      if (cancelled) return;
      const applied = applyPending(list);
      setStreamMuted(applied);
      rememberMutes(address, [...applied]);
      setMuteListRead(true);
    });

    // A relay that never answers must not hold the chat back for longer than
    // it takes to notice something is wrong
    const giveUp = setTimeout(() => {
      if (!cancelled) setMuteListRead(true);
    }, 1500);

    // Read once, the list was whatever it said when this window opened: a
    // host muting someone from the stream page never reached the popped-out
    // chat — the one an overlay is actually showing — until it was reloaded.
    // The list is replaceable, so each new version replaces its author's.
    const byOwner = new Map<string, { at: number; muted: string[] }>();
    const subId = NostrCore.subscribeLive(
      [{
        kinds: [EVENT_KINDS.PEOPLE_SET],
        authors: owners,
        '#d': [`livechat-mute:${identifier}`]
      }],
      (event) => {
        const held = byOwner.get(event.pubkey);
        if (held && held.at >= (event.created_at || 0)) return;
        byOwner.set(event.pubkey, {
          at: event.created_at || 0,
          muted: event.tags.filter(t => t[0] === 'p' && t[1]).map(t => t[1])
        });
        if (!cancelled) setStreamMuted(applyPending(
          new Set([...byOwner.values()].flatMap(entry => entry.muted))
        ));
      }
    );

    return () => {
      cancelled = true;
      clearTimeout(giveUp);
      NostrCore.unsubscribeLive(subId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relaysConnected, identifier, owners.join(',')]);

  useEffect(() => {
    if (!justMuted) return;
    const timer = setTimeout(() => setJustMuted(null), 10000);
    return () => clearTimeout(timer);
  }, [justMuted]);

  // Names for the list, once there is one to show
  useEffect(() => {
    if (!showStreamMuted || streamMuted.size === 0) return;
    let cancelled = false;
    NostrCore.fetchProfiles([...streamMuted]).then(found => {
      if (!cancelled) setStreamMutedProfiles(found);
    });
    return () => { cancelled = true; };
  }, [showStreamMuted, streamMuted]);

  const undoMute = async () => {
    if (!justMuted) return;
    const { pubkey: target, forEveryone } = justMuted;
    setJustMuted(null);
    if (forEveryone) {
      unmuteForEveryone(target);
      return;
    }
    setMuted(current => {
      const without = new Set(current);
      without.delete(target);
      return without;
    });
    try {
      await NostrCore.unblockUser(target);
    } catch (error) {
      setMuted(current => new Set(current).add(target));
      alert(error instanceof Error ? error.message : 'Could not unmute this account');
    }
  };

  const unmuteForEveryone = async (target: string) => {
    if (!identifier) return;
    // Back on screen at once, for the same reason
    pendingMute.current.set(target, false);
    setStreamMuted(current => {
      const without = new Set(current);
      without.delete(target);
      return without;
    });
    try {
      const updated = await NostrCore.setStreamMuted(address, identifier, target, false);
      pendingMute.current.delete(target);
      setStreamMuted(updated);
    } catch (error) {
      pendingMute.current.delete(target);
      setStreamMuted(current => new Set(current).add(target));
      alert(error instanceof Error ? error.message : 'Could not update the stream mute list');
    }
  };

  /** Whatever the relays said, with this window's own decision on top */
  const applyPending = (list: Set<string>): Set<string> => {
    const result = new Set(list);
    for (const [pubkey, muted] of pendingMute.current) {
      if (muted) result.add(pubkey); else result.delete(pubkey);
    }
    return result;
  };

  const setMutedForEveryone = async (author: string, name: string) => {
    if (!identifier) return;
    setJustMuted({ pubkey: author, name, forEveryone: true });
    // Off screen at once. Publishing the list means reading the current one
    // back first, signing and waiting for a relay — some eight seconds in
    // which the person you just threw out was still talking.
    pendingMute.current.set(author, true);
    setStreamMuted(current => new Set(current).add(author));
    try {
      const updated = await NostrCore.setStreamMuted(address, identifier, author, true);
      pendingMute.current.delete(author);
      setStreamMuted(updated);
    } catch (error) {
      pendingMute.current.delete(author);
      // Put them back rather than leave the screen disagreeing with the list
      setStreamMuted(current => {
        const reverted = new Set(current);
        reverted.delete(author);
        return reverted;
      });
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

  // Stick to the bottom as new messages come in — unless the reader has
  // scrolled up to read something, or older lines were just put in above,
  // where snapping to the bottom would throw away what they went for
  const toBottom = () => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
    atBottom.current = true;
    setMissed(false);
  };

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;

    if (heldHeight.current !== null) {
      list.scrollTop += list.scrollHeight - heldHeight.current;
      heldHeight.current = null;
      return;
    }

    if (atBottom.current) list.scrollTop = list.scrollHeight;
    else setMissed(true);
  }, [messages.length, zaps.length]);

  /**
   * A picture or a video in a message has no size until it loads, and the
   * list grows again when it does — after the effect above has run. Without
   * this the chat lands a screenful short of the newest line whenever the
   * last message carried one.
   */
  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(() => {
      if (atBottom.current) list.scrollTop = list.scrollHeight;
    });
    for (const child of Array.from(list.children)) watch.observe(child);
    return () => watch.disconnect();
  }, [messages.length, zaps.length]);

  /**
   * Is there anything before the oldest line here?
   *
   * Asked once, for one message, so the way back is only offered where there
   * is something to go back to — a chat that holds everything it has should
   * not be showing a button that does nothing.
   */
  useEffect(() => {
    if (messages.length === 0 || probed.current === address) return;
    probed.current = address;
    let dropped = false;

    const oldest = messages.reduce(
      (found, message) => Math.min(found, message.created_at || 0),
      messages[0].created_at || 0
    );
    if (!oldest) return;

    NostrCore.fetchLiveChatMessages(address, 1, true, oldest - 1)
      .then(found => {
        if (dropped) return;
        setOlderState(current => (current === 'unknown' ? (found.length > 0 ? 'idle' : 'done') : current));
      })
      .catch(() => {
        // Unanswered is not the same as nothing: leave the way back open
        if (!dropped) setOlderState(current => (current === 'unknown' ? 'idle' : current));
      });

    return () => { dropped = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, messages.length > 0]);

  /** What was said before the oldest line on screen */
  const loadOlder = async () => {
    const list = listRef.current;
    if (!list || (olderState !== 'idle' && olderState !== 'unknown') || messages.length === 0) return;

    const oldest = messages.reduce(
      (found, message) => Math.min(found, message.created_at || 0),
      messages[0].created_at || 0
    );
    if (!oldest) return;

    setOlderState('loading');
    try {
      // Two questions, because relays answer differently. The first asks
      // for what came before the oldest line here. The second asks for a
      // deeper slice of the same stretch: each relay holds its own subset —
      // measured on one stream, five relays held 500, 369, 287, 100 and 6
      // messages of the same chat — so what is missing is as often a hole in
      // the middle as it is the far end.
      const [older, deeper] = await Promise.all([
        NostrCore.fetchLiveChatMessages(address, 200, true, oldest - 1),
        NostrCore.fetchLiveChatMessages(address, Math.min(messages.length * 2 + 200, 1000), true)
      ]);
      const fresh = [...older, ...deeper]
        .filter(message => !messages.some(held => held.id === message.id))
        .filter((message, at, all) => all.findIndex(other => other.id === message.id) === at);

      // Nothing further to ask for only when the relays answered about the
      // stretch before this one and had nothing in it. An answer that holds
      // only lines already here says the relays that replied this time had
      // no more — not that no relay has any, so the way back stays open.
      if (older.length === 0 && deeper.length === 0) {
        setOlderState('done');
        return;
      }
      if (fresh.length === 0) {
        setOlderState('idle');
        return;
      }


      heldHeight.current = list.scrollHeight;
      setMessages(prev => {
        const byId = new Map(prev.map(m => [m.id, m]));
        for (const message of fresh) byId.set(message.id, message);
        return [...byId.values()].sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
      });
      NostrCore.fetchProfiles(fresh.map(m => m.pubkey)).then(found => {
        setProfiles(prev => new Map([...prev, ...found]));
      });
      setOlderState('idle');
    } catch (error) {
      console.error('Failed to load older chat messages:', error);
      setOlderState('idle');
    }
  };


  /**
   * A picture goes to a media server first, and what the chat carries is its
   * address — the same thing a gif or a pasted link is. It lands in the box
   * rather than being sent outright, so a caption can still be typed and
   * nothing leaves before the writer presses Send.
   */
  const sendImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // so the same picture can be picked again
    if (!file) return;

    setUploadPct(0);
    try {
      const blob = await BlossomClient.uploadFile(file, undefined, setUploadPct);
      setInput(current => (current ? `${current.trimEnd()} ${blob.url}` : blob.url));
      inputRef.current?.focus();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Could not upload that picture');
    } finally {
      setUploadPct(null);
    }
  };

  /** A gif is sent as its address, which the chat draws as the picture */
  const sendGif = (url: string) => {
    setShowGifPicker(false);
    setInput(current => (current ? `${current.trimEnd()} ${url}` : url));
    inputRef.current?.focus();
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
    setMuted(current => new Set(current).add(author));
    setJustMuted({ pubkey: author, name, forEveryone: false });
    try {
      await NostrCore.blockUser(author);
    } catch (error) {
      setMuted(current => {
        const reverted = new Set(current);
        reverted.delete(author);
        return reverted;
      });
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

    // The box empties the moment the message is on its way, the way a chat
    // is expected to behave — waiting for every relay to answer left a
    // message sitting there re-readable and re-sendable while the room was
    // already reading it. Whatever was written is kept here, and put back
    // only if it turns out nowhere took it.
    const tagged = new Map(mentions.current);
    setInput('');
    mentions.current.clear();
    closeSuggestions();
    setSending(true);
    try {
      const { content: resolved, mentioned } = resolveMentionHandles(content, tagged);
      const sent = await NostrCore.publishLiveChatMessage(address, relayHint, resolved, mentioned);
      if (sent) {
        setMessages(prev => (prev.some(m => m.id === sent.id) ? prev : [...prev, sent]));
      } else {
        throw new Error('Message was not accepted by any relay — check your connection');
      }
    } catch (error) {
      console.error('Failed to send chat message:', error);
      // Nothing took it, so hand the words back rather than making them be
      // typed again — unless something else has since been written
      setInput(current => current || content);
      mentions.current = tagged;
      alert(error instanceof Error ? error.message : 'Failed to send message');
    } finally {
      setSending(false);
    }
  };


  /**
   * Who is here: anyone who has spoken or zapped **lately**, newest first.
   *
   * Without the window this counted everyone in the loaded history, so a
   * stream whose chat had one message this morning claimed a viewer all day
   * — and the number differed from the one in the viewers window, which has
   * always counted the last ten minutes. Two places, two answers, for the
   * same question.
   */
  const present: PresentPerson[] = (() => {
    const since = Math.floor((Date.now() - PRESENT_FOR_MS) / 1000);
    void presenceTick; // recomputed on the tick, so people age out
    const lately = <T extends { created_at?: number }>(events: T[]) =>
      events.filter(event => (event.created_at || 0) >= since);

    const seen = new Map<string, PresentPerson>();
    const recentMessages = lately(messages);
    const speakers = [
      ...recentMessages.map(m => m.pubkey),
      ...lately(zaps).map(z => NostrCore.zapSenderPubkey(z))
    ];
    for (const pubkey of [...recentMessages].reverse().map(m => m.pubkey).concat(
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
  // Zaps sit in the conversation, not on top of it: the relays replay every
  // one the stream has ever taken, and being the newest events they landed
  // at the bottom — where the chat scrolls to — leaving a screen of nothing
  // but zap boxes. Only those from the stretch of time the messages cover
  // are shown, and only the last few of them.
  const oldestMessage = messages.length
    ? Math.min(...messages.map(m => m.created_at || 0))
    : 0;
  const zapsInView = zaps
    .filter(zap => (zap.created_at || 0) >= oldestMessage)
    .slice(-CHAT_ZAP_HISTORY);

  const timeline: TimelineEntry[] = !muteListRead ? [] : [
    ...messages.map((event): TimelineEntry => ({
      kind: 'message',
      event,
      author: event.pubkey,
      recipient: null,
      sats: 0
    })),
    ...zapsInView.map((event): TimelineEntry => ({
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
            title="Copy this address for an OBS browser source. It stays the same for every stream you do: the chat empties and refills on its own when the next one starts."
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
                <span className="live-chat-muted-person">
                  {profile?.picture ? (
                    <img src={profile.picture} alt="" className="live-chat-muted-avatar"  loading="lazy" decoding="async" />
                  ) : (
                    <span className="live-chat-muted-avatar-placeholder">
                      {label.charAt(0).toUpperCase()}
                    </span>
                  )}
                  <span className="live-chat-author">
                    <EmojiText text={label} emojis={profile?.emojis} />
                  </span>
                </span>
                {/* The card carries the same action, but a list of names is
                    read to act on, so it is here as well */}
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

      {justMuted && (
        <div className="live-chat-undo">
          <span>
            Muted <strong>{justMuted.name}</strong>
            {justMuted.forEveryone ? ' for everyone here' : ''}
          </span>
          <button type="button" className="btn btn-secondary btn-small" onClick={undoMute}>
            Undo
          </button>
        </div>
      )}

      <div
        className="live-chat-messages"
        ref={listRef}
        onScroll={(e) => {
          const list = e.currentTarget;
          atBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
          if (atBottom.current) setMissed(false);
          if (list.scrollTop < 120) void loadOlder();
        }}
      >
        {messages.length > 0 && (olderState === 'idle' || olderState === 'loading') && (
          <div className="live-chat-older">
            {olderState === 'loading' ? 'Reading what came before…' : (
              <button type="button" className="live-chat-older-btn" onClick={() => void loadOlder()}>
                Earlier messages
              </button>
            )}
          </div>
        )}
        {timeline.length === 0 && (
          <div className="live-chat-empty">
            {muteListRead ? 'No messages yet — say hello!' : 'Loading the chat…'}
          </div>
        )}
        {timeline.map(entry => {
          const event = entry.event;
          const author = entry.author;
          const profile = author ? profiles.get(author) : undefined;
          const name = profile?.display_name || profile?.name
            || (author ? formatAddress(author) : 'Someone');

          const avatar = profile?.picture ? (
            <img src={profile.picture} alt="" className="live-chat-avatar"  loading="lazy" decoding="async" />
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
                    <time className="live-chat-time">{atTime(event.created_at)}</time>
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
                  <time className="live-chat-time">{atTime(event.created_at)}</time>
                </span>
                <span className="live-chat-text">
                  <RichText
                    inlineImages
                    inlineQuotes
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
                <img src={profile.picture} alt="" className="suggestion-avatar"  loading="lazy" decoding="async" />
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

      {/* Somebody spoke while you were reading further up */}
      {missed && (
        <button type="button" className="live-chat-to-latest" onClick={toBottom}>
          ↓ Latest
        </button>
      )}

      {!hideComposer && <form className="live-chat-input-row" onSubmit={handleSend}>
        {/* What is being written comes first; what can be attached to it sits
            underneath. Side by side, the five of them squeezed the message
            box down to a slot barely wider than the word in it. */}
        <div className="live-chat-line">
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
        </div>
        <div className="live-chat-tools">
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
          {showEmojiPicker && emoji.render(
            <div className="live-chat-emoji-popup" ref={emoji.popupRef} style={emoji.style}>
              <EmojiPicker onSelect={insertEmoji} />
            </div>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={sendImage}
        />
        <button
          type="button"
          className="live-chat-emoji-btn live-chat-image-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={!isLoggedIn || disabled || sending || uploadPct !== null}
          title="Send a picture"
        >
          {uploadPct === null ? <ImageIcon /> : <span className="live-chat-upload-pct">{uploadPct}%</span>}
        </button>
        <div className="live-chat-emoji-wrapper" ref={gifPicker.containerRef}>
          <button
            ref={gifPicker.triggerRef}
            type="button"
            className="live-chat-emoji-btn live-chat-gif-btn"
            onClick={() => {
              if (showGifPicker) {
                setShowGifPicker(false);
                return;
              }
              gifPicker.openPopup();
              setShowGifPicker(true);
            }}
            disabled={!isLoggedIn || disabled || sending}
            title="Send a GIF"
          >
            GIF
          </button>
          {showGifPicker && gifPicker.render(
            <div className="live-chat-emoji-popup" ref={gifPicker.popupRef} style={gifPicker.style}>
              <GifPicker onSelect={sendGif} />
            </div>
          )}
        </div>
        </div>
      </form>}
    </div>
  );
};

export default LiveChatPanel;
