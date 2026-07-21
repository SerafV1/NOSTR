import React, { useEffect, useState } from 'react';
import { UserProfile } from '../types';
import { NostrCore } from '../nostr/core';
import { parseLiveEvent, LiveStreamInfo } from '../utils/liveStream';
import { formatAddress } from '../utils/helpers';
import LiveVideoPlayer from './LiveVideoPlayer';

interface LiveStreamPageProps {
  kind: number;
  pubkey: string;
  identifier: string;
  onNavigateToProfile: (pubkey: string) => void;
}

const LiveStreamPage: React.FC<LiveStreamPageProps> = ({ kind, pubkey, identifier, onNavigateToProfile }) => {
  const [stream, setStream] = useState<LiveStreamInfo | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      setNotFound(false);
      try {
        const event = await NostrCore.fetchEventByAddress(kind, pubkey, identifier);
        if (cancelled) return;
        if (!event) {
          setNotFound(true);
          return;
        }
        setStream(parseLiveEvent(event));
        const fetchedProfile = await NostrCore.fetchUserProfile(pubkey);
        if (!cancelled) setProfile(fetchedProfile);
      } catch (error) {
        console.error('Failed to load live stream:', error);
        if (!cancelled) setNotFound(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [kind, pubkey, identifier]);

  if (loading) {
    return <div className="live-stream-page"><div className="loading">Loading stream...</div></div>;
  }

  if (notFound || !stream) {
    return (
      <div className="live-stream-page">
        <div className="error">Stream not found</div>
      </div>
    );
  }

  const hostName = profile?.display_name || profile?.name || formatAddress(stream.pubkey);

  return (
    <div className="live-stream-page">
      <div className="live-stream-page-container">
        {stream.status === 'live' ? (
          <LiveVideoPlayer src={stream.streamingUrl} className="live-stream-video" />
        ) : (
          <div className="live-stream-offline">
            {stream.status === 'planned' ? '📅 This stream hasn\'t started yet' : '⏹ This stream has ended'}
          </div>
        )}

        <div className="live-stream-details">
          <div className="live-stream-details-header">
            <h1>{stream.title}</h1>
            {stream.status === 'live' && (
              <span className="live-stream-badge">LIVE</span>
            )}
          </div>

          <button className="live-stream-host-link" onClick={() => onNavigateToProfile(stream.pubkey)}>
            {profile?.picture ? (
              <img src={profile.picture} alt="" className="live-stream-host-avatar" />
            ) : (
              <div className="live-stream-host-avatar-placeholder">{hostName.charAt(0).toUpperCase()}</div>
            )}
            <span>{hostName}</span>
          </button>

          {stream.currentParticipants !== undefined && (
            <div className="live-stream-viewers-count">👁 {stream.currentParticipants} watching</div>
          )}

          {stream.summary && <p className="live-stream-summary">{stream.summary}</p>}

          {stream.hashtags.length > 0 && (
            <div className="event-hashtags">
              {stream.hashtags.map(tag => (
                <span key={tag} className="event-hashtag">#{tag}</span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default LiveStreamPage;
