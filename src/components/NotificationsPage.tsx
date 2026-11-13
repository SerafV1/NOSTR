import React, { useState, useEffect, useMemo, useRef } from 'react';
import { NostrEventSigned, UserProfile, EVENT_KINDS } from '../types';
import { NostrCore, EventCache } from '../nostr/core';
import {
  NotificationCore,
  NotificationStore,
  NostrNotification,
  NotificationType,
  cacheNotifications,
  readCachedNotifications,
  cacheTargets,
  readCachedTargets,
  dropMuted,
  dropThreadChatter,
  isThreadChatter,
  notificationsIncludeThreads,
  setNotificationsIncludeThreads,
  dropStrangers,
  notificationActor,
  notificationsFromFollowsOnly,
  setNotificationsFromFollowsOnly
} from '../nostr/notifications';
import { formatDate, formatAddress } from '../utils/helpers';
import RichText from './RichText';
import EmojiText from './EmojiText';
import Pic from './Pic';
import Thumbnail from './Thumbnail';
import ProfileHoverCard from './ProfileHoverCard';
import { customEmojiMap } from '../utils/customEmoji';
import {
  stripMediaUrls,
  extractImageUrls,
  extractVideoUrls,
  extractStreamUrls,
  extractEmbeds,
  quoteRefRegex
} from '../utils/media';
import { usePageMeta } from '../hooks/usePageMeta';

interface NotificationsPageProps {
  pubkey: string;
  relaysConnected: boolean;
  onNavigateToProfile: (pubkey: string) => void;
  onNavigateToNote: (noteId: string) => void;
  /** Live chat mentions belong to a stream, not to a note */
  onNavigateToStream?: (kind: number, pubkey: string, identifier: string) => void;
  onMarkRead?: () => void;
}

const TYPE_META: Record<NotificationType, { icon: string; verb: string }> = {
  reply: { icon: '💬', verb: 'replied to your note' },
  mention: { icon: '📣', verb: 'mentioned you' },
  reaction: { icon: '❤️', verb: 'reacted to' },
  repost: { icon: '🔄', verb: 'reposted' },
  zap: { icon: '⚡', verb: 'zapped you' },
  livechat: { icon: '📺', verb: 'tagged you in a stream chat' },
  follow: { icon: '👤', verb: 'started following you' },
  unfollow: { icon: '👋', verb: 'stopped following you' }
};

// NIP-25: reaction content is '+' or empty for a plain "like" (shown as a
// heart), '-' for a dislike, or any other string for a custom emoji
// reaction — that emoji should actually be shown, not always a heart
const reactionIcon = (content: string): string => {
  if (content === '' || content === '+') return '❤️';
  if (content === '-') return '👎';
  return content;
};

/**
 * The note a reaction, repost or zap is actually about: the last 'e' tag.
 *
 * A reaction carries the tags of the thread as well as the note it is for,
 * and NIP-25 puts the note being reacted to last. Preferring a marker
 * instead was wrong both ways round. "root" named the top of the
 * conversation — someone liking a reply showed up as liking the post it hung
 * under. "reply" names the note that was *answered*, which is how a like on
 * somebody's own answer came through as a notification about the post they
 * had answered: measured over his last twenty reactions carrying more than
 * one 'e' tag, seven pointed at the wrong note, every one of them a reply
 * marker copied from the thread, with the liked note sitting last where the
 * spec says it is.
 *
 * The last tag also keeps the case where a reaction is not about this
 * account's note at all — someone liking another person's reply in a thread
 * this account is tagged in — pointing at what was actually liked rather
 * than at whichever note here happens to be nearby.
 */
const reactedNoteId = (event: { tags: string[][] }): string | undefined => {
  const eTags = event.tags.filter(t => t[0] === 'e' && t[1]);
  if (eTags.length === 0) return undefined;
  return eTags[eTags.length - 1][1];
};

/**
 * What the thing being reacted to actually is.
 *
 * Anything can be reacted to, not only a note: someone liked a profile and
 * the row said "reacted to your note" and then printed the whole kind-0
 * event as its text — the JSON, addresses and all. So the target's kind
 * decides both what the row says and what, if anything, is worth previewing.
 */
const describeTarget = (
  target: { kind: number; content: string; tags: string[][] } | undefined,
  fallback: string
): { noun: string; preview?: string; tags?: string[][] } => {
  if (!target) return { noun: fallback };

  const titleTag = (name: string) => target.tags.find(t => t[0] === name)?.[1];

  switch (target.kind) {
    case 0: {
      // A profile's content is JSON, which is nobody's idea of a preview
      let name = '';
      try {
        const parsed = JSON.parse(target.content || '{}');
        name = parsed.display_name || parsed.name || '';
      } catch {
        // A profile that will not parse still is not a note
      }
      return { noun: 'your profile', preview: name ? `Profile: ${name}` : undefined };
    }
    case EVENT_KINDS.LONG_FORM:
      return { noun: 'your article', preview: titleTag('title'), tags: target.tags };
    case EVENT_KINDS.LIVE_EVENT:
      return { noun: 'your stream', preview: titleTag('title'), tags: target.tags };
    case EVENT_KINDS.LIVE_CHAT_MESSAGE:
      return { noun: 'your message in a stream', preview: target.content, tags: target.tags };
    default:
      return { noun: fallback, preview: target.content, tags: target.tags };
  }
};

/**
 * A note that holds no words, shown rather than described.
 *
 * A preview prints the note's text and leaves out its pictures, videos and
 * quote references, because those are drawn rather than printed — so a note
 * made of nothing but those strips down to an empty string. The gap was
 * filled first with "🔁 Quoted a post", a description of an action in the
 * one place on the row that describes the note the action was aimed at, and
 * then with "🖼 a picture", which is at least true but is still a word
 * standing in for a photograph anyone can recognise at a glance.
 *
 * So the picture itself goes there, small, asked for at the size it is
 * drawn. Only what has a picture to show can be shown: a plain video file
 * carries no poster anywhere in the note, so that one still says what it is.
 */
const AUDIO_EMBEDS = ['spotify', 'soundcloud', 'applemusic', 'deezer', 'tidal'];

/** How many fit on a row before the rest are better left unsaid */
const PREVIEW_PICTURES = 3;
/** Twice the drawn size, so it is sharp on a dense screen */
const PREVIEW_PICTURE_WIDTH = 160;

const previewWordlessNote = (content: string): React.ReactNode => {
  if (quoteRefRegex('i').test(content)) return '🔁 a quoted post';

  const embeds = extractEmbeds(content);
  const posters = [
    ...extractImageUrls(content),
    ...embeds.map(embed => embed.thumbnail).filter((url): url is string => !!url)
  ];

  if (posters.length) {
    return (
      <span className="notification-preview-media">
        {posters.slice(0, PREVIEW_PICTURES).map(url => (
          <Thumbnail
            key={url}
            src={url}
            width={PREVIEW_PICTURE_WIDTH}
            fallback="🖼"
            fallbackClassName="notification-preview-plate"
          />
        ))}
        {posters.length > PREVIEW_PICTURES && (
          <span className="notification-preview-more">+{posters.length - PREVIEW_PICTURES}</span>
        )}
      </span>
    );
  }

  if (extractVideoUrls(content).length || extractStreamUrls(content).length) return '🎬 a video';
  if (embeds.length) {
    return embeds.every(embed => AUDIO_EMBEDS.includes(embed.kind)) ? '🎵 a track' : '🎬 a video';
  }

  return null;
};

const NotificationsPage: React.FC<NotificationsPageProps> = ({
  pubkey,
  relaysConnected,
  onNavigateToProfile,
  onNavigateToNote,
  onNavigateToStream,
  onMarkRead
}) => {
  usePageMeta({ title: 'Notifications', noindex: true });
  const [notifications, setNotifications] = useState<NostrNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [profiles, setProfiles] = useState<Record<string, UserProfile>>({});
  // Seeded so previews are on screen with the list, not a beat later
  const [targetNotes, setTargetNotes] = useState<Record<string, NostrEventSigned>>(() => {
    const kept = readCachedTargets(pubkey);
    for (const event of Object.values(kept)) EventCache.addEvent(event);
    return kept;
  });
  // Captured once on mount so items stay highlighted as "new" for this
  // viewing even after the seen marker below advances past them
  const initialLastSeenRef = useRef(NotificationStore.getLastSeen(pubkey));

  // Whether strangers are heard at all, and who counts as one. The follow
  // list is read from storage first so ticking the box acts at once rather
  // than after the relays answer.
  // Reading further back than the first fetch reaches
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);
  const loadingOlderRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const [followsOnly, setFollowsOnly] = useState(notificationsFromFollowsOnly);
  // Replies between other people in a thread you are part of. Left out
  // unless asked for, and said to be what they are when shown.
  const [includeThreads, setIncludeThreads] = useState(notificationsIncludeThreads);
  const [follows, setFollows] = useState<Set<string>>(
    () => new Set(NostrCore.getCachedFollowedAccounts())
  );

  useEffect(() => {
    if (!relaysConnected) return;
    let cancelled = false;
    void NostrCore.fetchFollowedAccounts().then(list => {
      if (!cancelled && list.length > 0) setFollows(new Set(list));
    });
    return () => { cancelled = true; };
  }, [relaysConnected, pubkey]);

  /**
   * What is actually on the page. The notifications themselves are kept
   * whole — unticking the box puts the hidden ones back without another
   * fetch, and without having lost the ones that arrived while it was on.
   */
  // Muting somebody from this very page — the card over their name has the
  // button — has to take their rows away now. They were only dropped as new
  // ones were merged in, so the person stayed on screen until the next poll.
  const [muteTick, setMuteTick] = useState(0);
  useEffect(() => NostrCore.onMutesChanged(() => setMuteTick(n => n + 1)), []);

  const shown = useMemo(
    () => {
      // Replies found to be other people answering each other are judged
      // while the list is fetched — after what was kept from last time is
      // already on screen — so they are taken out here too
      const heard = dropThreadChatter(pubkey, dropMuted(notifications));
      return followsOnly ? dropStrangers(heard, follows) : heard;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [notifications, followsOnly, follows, muteTick, includeThreads]
  );

  /**
   * Nothing already on the page is ever taken off it. What is kept between
   * visits is capped, and a busy account fills that cap in minutes — so an
   * older notification would drop out of the store while it was still on
   * screen being read, and come back when a later fetch returned it again.
   * The page holds the union of everything this visit has seen.
   */
  const mergeIntoView = (incoming: NostrNotification[]) => {
    // The note somebody replied with is the notification. Held here and
    // nowhere else, clicking one sent the note page back to the relays for
    // an event this browser already had — a second or three of "Loading
    // note..." for something in memory. Kept where every page looks first.
    for (const notification of incoming) {
      if (notification.event.kind === EVENT_KINDS.TEXT_NOTE
        || notification.event.kind === EVENT_KINDS.COMMENT) {
        EventCache.addEvent(notification.event);
      }
    }
    setNotifications(prev => {
      const byId = new Map(prev.map(n => [n.id, n]));
      for (const notification of incoming) byId.set(notification.id, notification);
      // Kept whole, muted people included: they are taken out on the way to
      // the screen, so unmuting puts their rows back without a fetch
      return Array.from(byId.values())
        .sort((a, b) => (b.event.created_at || 0) - (a.event.created_at || 0));
    });
  };

  /**
   * The notes the rows are about — what a like, a repost or a zap was for.
   *
   * Fetched as early as there is anything to fetch, because it is what
   * opens when a row is pressed: measured, a reaction row pressed the
   * moment it appeared took 945ms to show the post and 31ms once this had
   * happened. The relays are asked once per note; anything already known is
   * answered from memory.
   */
  const fetchTargets = async (rows: NostrNotification[]) => {
    const ids = rows
      .filter(n => n.type === 'reaction' || n.type === 'repost' || n.type === 'zap')
      .map(n => reactedNoteId(n.event))
      .filter((id): id is string => !!id && !EventCache.getEvent(id));
    if (ids.length === 0) return;

    const targets = await NostrCore.fetchEventsByIds(ids);
    for (const target of targets.values()) EventCache.addEvent(target);
    setTargetNotes(cacheTargets(pubkey, Object.fromEntries(targets)));
  };

  /**
   * The next page back. Every relay answers with its newest hundred, which
   * for a busy account is about a week — and that was all there was: the
   * relays held a year more, and nothing ever asked for it.
   */
  const loadOlder = async () => {
    if (loadingOlderRef.current || reachedEnd || notifications.length === 0) return;
    // A follow is stamped with its contact list's date, which says nothing
    // about when it happened, so it does not mark how far back we have read
    const dated = notifications.filter(n => n.type !== 'follow' && n.type !== 'unfollow');
    if (dated.length === 0) return;
    const oldest = Math.min(...dated.map(n => n.event.created_at || 0));

    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const older = await NotificationCore.fetchNotifications(pubkey, 100, undefined, oldest);
      const have = new Set(notifications.map(n => n.id));
      const fresh = older.filter(n => !have.has(n.id));
      if (fresh.length === 0) {
        setReachedEnd(true);
        return;
      }
      mergeIntoView(fresh);
      const [actorProfiles] = await Promise.all([
        NostrCore.fetchProfiles(fresh.map(n => notificationActor(n.event))),
        fetchTargets(fresh)
      ]);
      setProfiles(prev => ({ ...prev, ...Object.fromEntries(actorProfiles) }));
    } catch (error) {
      console.error('Failed to load older notifications:', error);
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  };

  // The end of the list coming into view asks for more, with a margin ahead
  // of it so the next page is already arriving
  useEffect(() => {
    const sentinel = bottomRef.current;
    if (!sentinel || loading || reachedEnd || !relaysConnected) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) void loadOlder(); },
      { rootMargin: '600px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, reachedEnd, loadingOlder, relaysConnected, notifications.length]);

  const loadNotifications = async () => {
    const cached = readCachedNotifications(pubkey);
    if (cached.length > 0) {
      mergeIntoView(cached);
      setLoading(false);
      // Before the relays are asked anything: these rows are on screen and
      // can be pressed now, and the poll that keeps the badge up to date has
      // usually cached them long before this page was opened
      void fetchTargets(cached);
    } else {
      setLoading(true);
    }

    try {
      // Unfollows are a separate question — no filter can ask a relay for
      // lists that no longer name you, so they are worked out by checking
      // the lists of everyone known to follow you
      const [fetched, unfollows] = await Promise.all([
        NotificationCore.fetchNotifications(pubkey, 100),
        NotificationCore.fetchUnfollows(pubkey)
      ]);
      fetched.push(...unfollows);

      // Merged, not replaced: a partial answer from the relays must not
      // take away notifications that were already on screen
      // Filtered on the way to the screen rather than out of the cache, so
      // unmuting brings someone's notifications back rather than losing them
      const shown = cacheNotifications(pubkey, fetched);
      // Both what the store keeps and what this fetch found: the store's cap
      // may already have dropped something that is still on screen
      mergeIntoView([...shown, ...fetched]);

      // Names and the notes behind the rows at the same time, not one after
      // the other: a face arriving late leaves an initial in a circle, a
      // note arriving late leaves somebody looking at a spinner after they
      // pressed the row.
      //
      // Every name on the page, not only the ones this fetch returned. A
      // follow is announced once — by whichever poll saw it first, often the
      // background one — and never appears in a later fetch, so asking only
      // about `fetched` left those rows showing a shortened key and a blank
      // avatar until something else happened to load that profile.
      const [actorProfiles] = await Promise.all([
        NostrCore.fetchProfiles(shown.map(n => notificationActor(n.event))),
        fetchTargets([...shown, ...fetched])
      ]);
      setProfiles(prev => ({ ...prev, ...Object.fromEntries(actorProfiles) }));

    } catch (error) {
      console.error('Failed to load notifications:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (relaysConnected) {
      loadNotifications();
    } else {
      const cached = readCachedNotifications(pubkey);
      if (cached.length > 0) {
        mergeIntoView(cached);
        setLoading(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relaysConnected, pubkey]);

  // Refresh while the page stays open so new notifications show up without
  // a manual reload
  useEffect(() => {
    if (!relaysConnected) return;
    const interval = setInterval(loadNotifications, 30000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relaysConnected, pubkey]);

  // Advance the "seen" marker once notifications are loaded, clearing the
  // header badge while initialLastSeenRef keeps this view's items highlighted
  // What was read is what was shown: a notification hidden behind the box
  // has not been seen, and should still be there if the box is unticked
  useEffect(() => {
    if (shown.length === 0) return;
    const newest = Math.max(...shown.map(n => n.event.created_at || 0));
    NotificationStore.setLastSeen(pubkey, newest);
    NotificationStore.markSeen(pubkey, shown.map(n => n.id));
    onMarkRead?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, pubkey]);

  const handleClick = (notification: NostrNotification) => {
    if (notification.type === 'follow' || notification.type === 'unfollow') {
      onNavigateToProfile(notificationActor(notification.event));
      return;
    }
    if (notification.type === 'livechat') {
      // A chat message belongs to its stream, not to a note page
      const address = notification.event.tags.find(t => t[0] === 'a')?.[1];
      const [kind, pubkey, identifier] = (address || '').split(':');
      if (kind && pubkey) {
        onNavigateToStream?.(Number(kind), pubkey, identifier || '');
      }
      return;
    }
    if (notification.type === 'reply' || notification.type === 'mention') {
      onNavigateToNote(notification.event.id);
      return;
    }
    const targetId = reactedNoteId(notification.event);
    const target = targetOf(notification);
    // A reaction to a profile leads to the profile, not to a page trying to
    // read a kind 0 as if it were a note
    if (target?.kind === 0) {
      onNavigateToProfile(target.pubkey);
      return;
    }
    if (targetId) {
      onNavigateToNote(targetId);
    } else {
      onNavigateToProfile(notificationActor(notification.event));
    }
  };

  /** The event a reaction, repost or zap is about, if it is to hand */
  const targetOf = (notification: NostrNotification) => {
    const targetId = reactedNoteId(notification.event);
    // The note this is about is often already in memory — from the feed, or
    // from an earlier visit — so read it straight out rather than showing an
    // empty preview until the network answers
    return targetId ? (targetNotes[targetId] || EventCache.getEvent(targetId)) : undefined;
  };

  const renderPreview = (notification: NostrNotification): React.ReactNode => {
    let rawContent: string | undefined;
    // Whichever event the text comes from also carries its emoji definitions
    let sourceTags: string[][] | undefined;
    if (
      notification.type === 'reply'
      || notification.type === 'mention'
      || notification.type === 'livechat'
    ) {
      rawContent = notification.event.content;
      sourceTags = notification.event.tags;
    } else {
      const described = describeTarget(targetOf(notification), 'your note');
      rawContent = described.preview;
      sourceTags = described.tags;
    }
    if (!rawContent) return null;

    // Raw content can be just a "nostr:nevent1..."/"note1..." quote
    // reference, a photograph or a video with no other text — strip it like
    // EventCard does instead of showing that literal string, and show the
    // note itself when stripping leaves nothing to print
    const stripped = stripMediaUrls(rawContent);
    if (!stripped) return previewWordlessNote(rawContent);

    // Mentions, hashtags and links were showing as raw "nostr:npub1…" text
    return (
      <RichText
        content={stripped}
        eventTags={sourceTags}
        onNavigateToProfile={onNavigateToProfile}
        onNavigateToNote={onNavigateToNote}
      />
    );
  };

  return (
    <div className="notifications-page">
      <div className="notifications-header">
        <h2>Notifications</h2>
        <label
          className="notifications-follows-only"
          title="Hide replies, reactions, reposts and zaps from accounts you do not follow"
        >
          <input
            type="checkbox"
            checked={followsOnly}
            onChange={(e) => {
              setFollowsOnly(e.target.checked);
              setNotificationsFromFollowsOnly(e.target.checked);
            }}
          />
          Only people I follow
        </label>
        <label
          className="notifications-follows-only"
          title="Also show replies other people write to each other in threads you took part in"
        >
          <input
            type="checkbox"
            checked={includeThreads}
            onChange={(e) => {
              setIncludeThreads(e.target.checked);
              setNotificationsIncludeThreads(e.target.checked);
              // What was left out was never brought to the page, so turning
              // this on has to go and get it
              if (e.target.checked) void loadNotifications();
            }}
          />
          Threads I'm in
        </label>
      </div>

      {loading && <div className="loading">Loading notifications...</div>}

      {!loading && shown.length === 0 && (
        <div className="empty-state">
          <p>
            {followsOnly && notifications.length > 0
              ? 'Nothing here from the people you follow — untick the box to see the rest'
              : 'No notifications yet — replies, mentions, reactions, reposts and zaps will show up here'}
          </p>
        </div>
      )}

      <div className="notification-list">
        {shown.map((notification) => {
          // A zap receipt is signed by the wallet service that settled the
          // payment, not by the person who chose to send it — so every zap
          // was announced as "Alby Zapper", with the sender's own name only
          // inside the request the receipt carries
          const actor = notificationActor(notification.event);
          // Profiles persist locally, so the name and avatar are usually
          // known before any request goes out — reading them here stops the
          // list rendering as anonymous placeholders on every visit
          const profile = profiles[actor] || EventCache.getProfile(actor);
          const displayName = profile?.display_name || profile?.name || formatAddress(actor);
          const meta = TYPE_META[notification.type];
          const icon = notification.type === 'reaction'
            ? reactionIcon(notification.event.content)
            : meta.icon;
          const preview = renderPreview(notification);
          const isNew = (notification.event.created_at || 0) > initialLastSeenRef.current;
          const amountSats = notification.type === 'zap'
            ? NostrCore.getZapAmountSats(notification.event)
            : 0;

          return (
            <div
              key={notification.id}
              className={`notification-item ${isNew ? 'unread' : ''} ${
                notification.type === 'reply' && isThreadChatter(pubkey, notification.id) ? 'in-thread' : ''
              }`}
              onClick={() => handleClick(notification)}
            >
              {/* A reaction can be a picture rather than an emoji — NIP-30
                  names it in the content as :shortcode: and gives its address
                  in the event's own tags. Printed as text it read ":flame:" */}
              <span className="notification-icon">
                {notification.type === 'reaction'
                  ? <EmojiText text={icon} emojis={customEmojiMap(notification.event.tags)} />
                  : icon}
              </span>
              {/* Pointing at whoever did this says who they are and offers
                  to follow or mute them, the same as it does in a feed */}
              <ProfileHoverCard
                pubkey={actor}
                profile={profile}
                onNavigateToProfile={onNavigateToProfile}
              >
                {profile?.picture ? (
                  <Pic
                    src={profile.picture}
                    alt={displayName}
                    className="notification-avatar"
                    width={48}
                    height={48}
                  />
                ) : (
                  <div className="notification-avatar-placeholder">
                    {displayName.charAt(0).toUpperCase()}
                  </div>
                )}
              </ProfileHoverCard>
              <div className="notification-body">
                <div className="notification-text">
                  <ProfileHoverCard
                    pubkey={actor}
                    profile={profile}
                    onNavigateToProfile={onNavigateToProfile}
                  >
                    <button
                      className="notification-actor"
                      onClick={(e) => { e.stopPropagation(); onNavigateToProfile(actor); }}
                    >
                      <EmojiText text={displayName} emojis={profile?.emojis} />
                    </button>
                  </ProfileHoverCard>{' '}
                  {notification.type === 'reply' && isThreadChatter(pubkey, notification.id)
                    ? <span className="notification-thread-label">replied to someone else in a thread you are in</span>
                    : meta.verb}
                  {(notification.type === 'reaction' || notification.type === 'repost')
                    ? ` ${describeTarget(targetOf(notification), 'your note').noun}`
                    : ''}
                  {notification.type === 'zap' && amountSats > 0 ? ` (${amountSats.toLocaleString()} sats)` : ''}
                </div>
                {preview && <div className="notification-preview">{preview}</div>}
              </div>
              <div className="notification-time">
                {formatDate(new Date((notification.event.created_at || 0) * 1000))}
              </div>
            </div>
          );
        })}
      </div>

      {!loading && notifications.length > 0 && (
        <div className="feed-end" ref={bottomRef}>
          {loadingOlder
            ? 'Loading older notifications…'
            : reachedEnd
              ? 'That is as far back as the relays go'
              : ''}
        </div>
      )}
    </div>
  );
};

export default NotificationsPage;
