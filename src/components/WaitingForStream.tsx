import React, { useEffect, useState } from 'react';
import { NostrCore } from '../nostr/core';

interface WaitingForStreamProps {
  host: string;
  className?: string;
}

/**
 * What a link that follows a broadcaster shows between broadcasts.
 *
 * In OBS the window is a browser source laid over the video, so a message
 * there would be burned into the overlay. `?transparent=1` marks exactly
 * that window — it shows nothing at all, and fills itself in the moment the
 * stream starts.
 */
const WaitingForStream: React.FC<WaitingForStreamProps> = ({ host, className }) => {
  const [name, setName] = useState('');
  const overlay = new URLSearchParams(window.location.search).get('transparent') === '1';

  useEffect(() => {
    let dropped = false;
    NostrCore.fetchUserProfile(host)
      .then(profile => {
        if (dropped || !profile) return;
        setName(profile.display_name || profile.name || '');
      })
      .catch(() => {});
    return () => { dropped = true; };
  }, [host]);

  if (overlay) return <div className={className} />;

  return (
    <div className={className}>
      <div className="stream-waiting">
        <p className="stream-waiting-line">
          {name ? `${name} is not streaming right now.` : 'Nobody is streaming at this address right now.'}
        </p>
        <p className="stream-waiting-note">
          This link follows the broadcaster rather than one broadcast, so it fills itself
          in when the next stream starts. Nothing to paste again.
        </p>
      </div>
    </div>
  );
};

export default WaitingForStream;
