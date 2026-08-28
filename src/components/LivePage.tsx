import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { UserProfile, EVENT_KINDS, NostrEventSigned } from '../types';
import { NostrCore, PersistentCache } from '../nostr/core';
import { parseLiveEvent, encodeLiveNaddr, isEffectivelyLive, LiveStreamInfo } from '../utils/liveStream';
import { formatAddress } from '../utils/helpers';

// Public list, identical for everyone, so it isn't keyed per account
const LIVE_CACHE_KEY = 'live_now';

interface LivePageProps {
  relaysConnected: boolean;
}

const addressOf = (event: NostrEventSigned): string =>
  `${event.pubkey}:${event.tags.find(t => t[0] === 'd')?.[1] || ''}`;

const LivePage: React.FC<LivePageProps> = ({ relaysConnected }) => {
  // The events themselves rather than what was parsed out of them: a stream
  // announces itself over and over as it runs, and each announcement replaces
  // the last — which can only be judged by comparing the two.
  const [events, setEvents] = useState<Map<string, NostrEventSigned>>(new Map());
  const [profiles, setProfiles] = useState<Map<string, UserProfile>>(new Map());
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

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
      .filter(({ info }) => info.streamingUrl)
      .sort((a, b) =>
        (b.info.currentParticipants ?? 0) - (a.info.currentParticipants ?? 0) ||
        (b.info.starts ?? 0) - (a.info.starts ?? 0) ||
        b.at - a.at)
      .map(({ info }) => info),
    [events]
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

        const profileMap = await NostrCore.fetchProfiles(found.map(e => e.pubkey));
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
      const profileMap = await NostrCore.fetchProfiles(found.map(e => e.pubkey));
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

        {loading && <div className="loading">Loading live streams...</div>}

        {!loading && streams.length === 0 && (
          <div className="empty-state">
            <p>No one is live right now.</p>
          </div>
        )}

        <div className="live-streams-grid">
          {streams.map(stream => {
            const profile = profiles.get(stream.pubkey);
            const hostName = profile?.display_name || profile?.name || formatAddress(stream.pubkey);
            const naddr = encodeLiveNaddr(EVENT_KINDS.LIVE_EVENT, stream.pubkey, stream.dTag);

            return (
              <button
                key={`${stream.pubkey}:${stream.dTag}`}
                className="live-stream-card"
                onClick={() => navigate(`/live/${naddr}`)}
              >
                <div className="live-stream-thumb">
                  {stream.image ? (
                    <img src={stream.image} alt={stream.title}  loading="lazy" decoding="async" />
                  ) : (
                    <div className="live-stream-thumb-placeholder" />
                  )}
                  <span className="live-stream-badge">LIVE</span>
                  {stream.currentParticipants !== undefined && (
                    <span className="live-stream-viewers">👁 {stream.currentParticipants}</span>
                  )}
                </div>
                <div className="live-stream-info">
                  <div className="live-stream-title">{stream.title}</div>
                  <div className="live-stream-host">
                    {profile?.picture && <img src={profile.picture} alt="" className="live-stream-host-avatar"  loading="lazy" decoding="async" />}
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
