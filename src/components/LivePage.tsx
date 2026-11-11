import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Thumbnail from './Thumbnail';
import { UserProfile, EVENT_KINDS, NostrEventSigned } from '../types';
import { NostrCore, PersistentCache } from '../nostr/core';
import { parseLiveEvent, encodeLiveNaddr, isEffectivelyLive, isAudioRoom, posterSources, LiveStreamInfo } from '../utils/liveStream';
import { usePosterTick } from '../hooks/usePosterTick';
import { formatAddress } from '../utils/helpers';
import Pic from './Pic';
import { LIVE_CATEGORIES, ALL_LIVE, inCategory, isLiveCategory } from '../utils/liveCategories';
import { usePageMeta } from '../hooks/usePageMeta';

// Public list, identical for everyone, so it isn't keyed per account
const LIVE_CACHE_KEY = 'live_now';

interface LivePageProps {
  relaysConnected: boolean;
}

const addressOf = (event: NostrEventSigned): string =>
  `${event.pubkey}:${event.tags.find(t => t[0] === 'd')?.[1] || ''}`;

const LivePage: React.FC<LivePageProps> = ({ relaysConnected }) => {
  usePageMeta({ title: 'Live now', description: 'Every nostr stream that is live right now — watch it with its chat and zap the host, no account needed.' });
  // The events themselves rather than what was parsed out of them: a stream
  // announces itself over and over as it runs, and each announcement replaces
  // the last — which can only be judged by comparing the two.
  const [events, setEvents] = useState<Map<string, NostrEventSigned>>(new Map());
  const [profiles, setProfiles] = useState<Map<string, UserProfile>>(new Map());
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  // Every card on this page is a stream that is on air, so every poster on
  // it is being rewritten while it is looked at
  const posterAt = usePosterTick();

  /**
   * Which tab is open, kept in the address so it can be sent to somebody
   * and so a reload lands back where the reader was. A word that names no
   * tab — a typo, or a category this version does not have — opens all of
   * them rather than an empty page.
   */
  const [params, setParams] = useSearchParams();
  const asked = params.get('c') || ALL_LIVE;
  const category = isLiveCategory(asked) ? asked : ALL_LIVE;
  const chooseCategory = (id: string) => {
    const next = new URLSearchParams(params);
    if (id === ALL_LIVE) next.delete('c'); else next.set('c', id);
    setParams(next, { replace: true });
  };

  // Whoever is on air now, most watched first. Not newest-announcement
  // first, which is what the order used to be: a running stream announces
  // itself again every minute or so, and with the list now keeping itself up
  // to date that would have the cards trading places under the reader's
  // cursor. A broadcast that has ended, or gone quiet long enough to count as
  // ended, drops out on its own.
  const streams: LiveStreamInfo[] = useMemo(
    () => Array.from(events.values())
      .filter(isEffectivelyLive)
      .map(event => ({ info: parseLiveEvent(event), at: event.created_at || 0 }))
      // Something to watch. A room to talk in is a live event too, and has
      // no picture behind its address at all
      .filter(({ info }) => info.streamingUrl && !isAudioRoom(info))
      .sort((a, b) =>
        (b.info.currentParticipants ?? 0) - (a.info.currentParticipants ?? 0) ||
        (b.info.starts ?? 0) - (a.info.starts ?? 0) ||
        b.at - a.at)
      .map(({ info }) => info),
    [events]
  );

  /**
   * How many of the streams on air belong to each tab, so a reader can see
   * where there is something to watch without opening every one. Counted
   * over everything live, not over what the open tab shows.
   */
  const counts = useMemo(() => {
    const tally = new Map<string, number>([[ALL_LIVE, streams.length]]);
    for (const { id } of LIVE_CATEGORIES) {
      tally.set(id, streams.filter(stream => inCategory(stream, id)).length);
    }
    return tally;
  }, [streams]);

  const shown = useMemo(
    () => streams.filter(stream => inCategory(stream, category)),
    [streams, category]
  );

  const takeEvents = (incoming: NostrEventSigned[]) => {
    setEvents(prev => {
      const next = new Map(prev);
      let changed = false;
      for (const event of incoming) {
        if (event.kind !== EVENT_KINDS.LIVE_EVENT) continue;
        const address = addressOf(event);
        const held = next.get(address);
        // Relays still hand out older copies of a replaceable event; the
        // newest is the one that says what is happening now
        if (held && (held.created_at || 0) >= (event.created_at || 0)) continue;
        next.set(address, event);
        changed = true;
      }
      return changed ? next : prev;
    });
  };

  const takeEventsRef = useRef(takeEvents);
  takeEventsRef.current = takeEvents;

  useEffect(() => {
    if (!relaysConnected) return;
    let cancelled = false;

    (async () => {
      // Show the last known list straight away instead of an empty page.
      // These are raw events re-parsed on render, so anything that has
      // since gone stale comes back as 'ended' and is dropped here rather
      // than being presented as still live.
      const cached = PersistentCache.get<NostrEventSigned[]>(LIVE_CACHE_KEY) || [];
      const stillLive = cached.filter(isEffectivelyLive);
      if (stillLive.length > 0) {
        takeEventsRef.current(stillLive);
        setLoading(false);
      } else {
        setLoading(true);
      }
      try {
        const found = await NostrCore.fetchLiveEvents('live');
        if (cancelled) return;
        takeEventsRef.current(found);
        PersistentCache.set(LIVE_CACHE_KEY, found);

        // On a platform-published stream the signer is the platform and the
        // presenter is named in a `p` tag, so both are worth having: one
        // names the card, the other can lend it a picture
        const profileMap = await NostrCore.fetchProfiles(
          found.flatMap(e => [e.pubkey, parseLiveEvent(e).hostPubkey]).filter(Boolean)
        );
        if (!cancelled) setProfiles(profileMap);
      } catch (error) {
        console.error('Failed to load live streams:', error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    // A broadcast can start, end or change while this page is open. Read once
    // and never listened to, the list stood still until the page was
    // reloaded — someone going live was simply not there.
    const subId = NostrCore.subscribeLive(
      [{ kinds: [EVENT_KINDS.LIVE_EVENT], limit: 100 }],
      (event) => { if (!cancelled) takeEventsRef.current([event]); }
    );

    // Under the subscription, for a relay that drops its socket or never
    // pushes the newer copy
    const poll = setInterval(async () => {
      if (document.visibilityState !== 'visible') return;
      const found = await NostrCore.fetchLiveEvents('live');
      if (cancelled || found.length === 0) return;
      takeEventsRef.current(found);
      PersistentCache.set(LIVE_CACHE_KEY, found);
      const profileMap = await NostrCore.fetchProfiles(
        found.flatMap(e => [e.pubkey, parseLiveEvent(e).hostPubkey]).filter(Boolean)
      );
      if (!cancelled) setProfiles(prev => new Map([...prev, ...profileMap]));
    }, 30000);

    return () => {
      cancelled = true;
      clearInterval(poll);
      NostrCore.unsubscribeLive(subId);
    };
  }, [relaysConnected]);

  return (
    <div className="live-page">
      <div className="live-page-container">
        <h1>Live Now</h1>

        {/* What a stream is about is a hashtag on it, written by whoever
            started it — so a tab holds whoever said the word, and plenty of
            broadcasts say nothing at all and live only under "All live". */}
        <div className="live-category-tabs" role="tablist" aria-label="Stream categories">
          {[{ id: ALL_LIVE, label: 'All live' }, ...LIVE_CATEGORIES].map(tab => {
            const held = counts.get(tab.id) ?? 0;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={category === tab.id}
                className={`live-category-tab${category === tab.id ? ' active' : ''}${held === 0 ? ' empty' : ''}`}
                onClick={() => chooseCategory(tab.id)}
              >
                {tab.label}
                <span className="live-category-count">{held}</span>
              </button>
            );
          })}
        </div>

        {loading && <div className="loading">Loading live streams...</div>}

        {!loading && shown.length === 0 && (
          <div className="empty-state">
            <p>
              {streams.length === 0
                ? 'No one is live right now.'
                : 'Nobody is live under this one — the rest are under All live.'}
            </p>
          </div>
        )}

        <div className="live-streams-grid">
          {shown.map(stream => {
            const profile = profiles.get(stream.pubkey);
            // Whoever is actually presenting — the same person the stream
            // page names, which on zap.stream is not the account that signed
            // the event
            const host = profiles.get(stream.hostPubkey) || profile;
            const hostName = host?.display_name || host?.name || formatAddress(stream.hostPubkey);
            const naddr = encodeLiveNaddr(EVENT_KINDS.LIVE_EVENT, stream.pubkey, stream.dTag);

            return (
              <button
                key={`${stream.pubkey}:${stream.dTag}`}
                className="live-stream-card"
                onClick={() => navigate(`/live/${naddr}`)}
              >
                <div className="live-stream-thumb">
                  {/* A stream's own picture where it names one. Plenty name
                      none at all — zap.stream publishes a great many like
                      that — and a card of nothing but a television is a card
                      that says nothing, so the broadcaster's own banner or
                      face stands in. The plate is the last resort, for when
                      there is no picture of any kind or the address is dead. */}
                  <Thumbnail
                    src={[...posterSources(stream, posterAt), host?.banner, host?.picture]}
                    alt={stream.title}
                    fallback="📺"
                    fallbackClassName="live-stream-thumb-placeholder"
                    width={420}
                  />
                  <span className="live-stream-badge">LIVE</span>
                  {stream.currentParticipants !== undefined && (
                    <span className="live-stream-viewers">👁 {stream.currentParticipants}</span>
                  )}
                </div>
                <div className="live-stream-info">
                  <div className="live-stream-title">{stream.title}</div>
                  <div className="live-stream-host">
                    {host?.picture && <Pic src={host.picture} className="live-stream-host-avatar" width={32} height={32} />}
                    {hostName}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default LivePage;
