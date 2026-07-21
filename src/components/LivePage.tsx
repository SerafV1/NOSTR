import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { UserProfile, EVENT_KINDS } from '../types';
import { NostrCore } from '../nostr/core';
import { parseLiveEvent, encodeLiveNaddr, LiveStreamInfo } from '../utils/liveStream';
import { formatAddress } from '../utils/helpers';

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
      setLoading(true);
      try {
        const events = await NostrCore.fetchLiveEvents('live');
        const infos = events.map(parseLiveEvent).filter(s => s.streamingUrl);
        if (cancelled) return;
        setStreams(infos);

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
