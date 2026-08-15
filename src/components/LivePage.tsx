import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { UserProfile, EVENT_KINDS, NostrEventSigned } from '../types';
import { NostrCore, PersistentCache } from '../nostr/core';
import { parseLiveEvent, encodeLiveNaddr, LiveStreamInfo } from '../utils/liveStream';
import { formatAddress } from '../utils/helpers';

// Public list, identical for everyone, so it isn't keyed per account
const LIVE_CACHE_KEY = 'live_now';

interface LivePageProps {
  relaysConnected: boolean;
}

const LivePage: React.FC<LivePageProps> = ({ relaysConnected }) => {
  const [streams, setStreams] = useState<LiveStreamInfo[]>([]);
  const [profiles, setProfiles] = useState<Map<string, UserProfile>>(new Map());
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    if (!relaysConnected) return;
    let cancelled = false;

    (async () => {
      // Show the last known list straight away instead of an empty page.
      // These are raw events re-parsed on render, so anything that has
      // since gone stale comes back as 'ended' and is dropped here rather
      // than being presented as still live.
      const cached = PersistentCache.get<NostrEventSigned[]>(LIVE_CACHE_KEY) || [];
      const stillLive = cached.map(parseLiveEvent).filter(s => s.streamingUrl && s.status === 'live');
      if (stillLive.length > 0) {
        setStreams(stillLive);
        setLoading(false);
      } else {
        setLoading(true);
      }
      try {
        const events = await NostrCore.fetchLiveEvents('live');
        const infos = events.map(parseLiveEvent).filter(s => s.streamingUrl);
        if (cancelled) return;
        setStreams(infos);
        PersistentCache.set(LIVE_CACHE_KEY, events);

        const profileMap = await NostrCore.fetchProfiles(infos.map(s => s.pubkey));
        if (!cancelled) setProfiles(profileMap);
      } catch (error) {
        console.error('Failed to load live streams:', error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
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
                    <img src={stream.image} alt={stream.title} />
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
                    {profile?.picture && <img src={profile.picture} alt="" className="live-stream-host-avatar" />}
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
