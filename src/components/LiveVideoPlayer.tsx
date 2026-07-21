import React, { useEffect, useRef, useState } from 'react';
import type Hls from 'hls.js';

interface LiveVideoPlayerProps {
  src: string;
  className?: string;
}

/**
 * Plays an HLS (.m3u8) live stream. Safari supports HLS natively via
 * <video src>; every other browser needs hls.js, which demuxes the stream
 * into fragments MSE can play. hls.js is ~500KB, so it's dynamically
 * imported here rather than bundled into the main chunk every page pays for.
 */
const LiveVideoPlayer: React.FC<LiveVideoPlayerProps> = ({ src, className }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [buffering, setBuffering] = useState(true);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    setError(null);
    setBuffering(true);
    setSlow(false);

    let hls: Hls | null = null;
    let cancelled = false;
    let HlsCtor: typeof Hls | null = null;

    const tryPlay = () => {
      video.play().catch(err => console.warn('[LiveVideoPlayer] Autoplay was blocked:', err));
    };

    const slowTimer = setTimeout(() => setSlow(true), 15000);

    // Some stalls (a decoder that's silently given up on an otherwise
    // healthy-looking buffer) don't clear with a nudge — startLoad()/seeking
    // to the live edge doesn't help because hls.js's internal pipeline
    // itself is stuck, not the network. Escalate to fully tearing down and
    // recreating the whole hls.js instance, which is what a page refresh
    // effectively does, without losing the surrounding page.
    let fullReinitCount = 0;
    const MAX_FULL_REINITS = 3;

    const initHls = () => {
      if (!HlsCtor || cancelled) return;

      if (!HlsCtor.isSupported()) {
        setError("Your browser can't play this stream format");
        return;
      }

      hls = new HlsCtor();
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(HlsCtor.Events.MANIFEST_PARSED, tryPlay);

      let networkRetries = 0;
      let mediaRetries = 0;
      const MAX_RETRIES = 4;

      hls.on(HlsCtor.Events.FRAG_LOADED, () => {
        networkRetries = 0;
        mediaRetries = 0;
      });

      hls.on(HlsCtor.Events.ERROR, (_event, data) => {
        console.warn('[LiveVideoPlayer] HLS error:', data.type, data.details, 'fatal:', data.fatal);
        if (!data.fatal || !hls || !HlsCtor) return;

        switch (data.type) {
          case HlsCtor.ErrorTypes.NETWORK_ERROR:
            if (networkRetries++ < MAX_RETRIES) {
              console.warn(`[LiveVideoPlayer] Retrying after network error (${networkRetries}/${MAX_RETRIES})`);
              hls.startLoad();
            } else {
              setError('Stream unavailable — the broadcaster may not be live right now');
            }
            break;
          case HlsCtor.ErrorTypes.MEDIA_ERROR:
            if (mediaRetries++ < MAX_RETRIES) {
              console.warn(`[LiveVideoPlayer] Recovering from media error (${mediaRetries}/${MAX_RETRIES})`);
              hls.recoverMediaError();
            } else {
              setError('Playback error — try reloading the page');
            }
            break;
          default:
            setError('Stream unavailable — the broadcaster may not be live right now');
        }
      });
    };

    const fullReinit = () => {
      if (fullReinitCount >= MAX_FULL_REINITS) {
        console.warn('[LiveVideoPlayer] Giving up after repeated full reinits');
        setError('Playback keeps stalling — try reloading the page');
        return;
      }
      fullReinitCount++;
      console.warn(`[LiveVideoPlayer] Stall persisted after a nudge — full reinit ${fullReinitCount}/${MAX_FULL_REINITS}`);
      hls?.destroy();
      hls = null;
      initHls();
    };

    // Falling behind the live edge (or a stuck decoder) can freeze playback
    // silently — no error event fires, currentTime just stops advancing.
    // First try a light nudge (seek to live edge + resume loading); if the
    // stall persists right through that, escalate to a full reinit.
    let lastTime = -1;
    let stalledTicks = 0;
    let nudgedAt = 0;
    const watchdog = setInterval(() => {
      if (cancelled || video.ended) return;

      if (video.currentTime === lastTime) {
        stalledTicks++;
        if (stalledTicks === 2) {
          console.warn('[LiveVideoPlayer] Playback stalled — nudging to live edge');
          const liveEdge = hls?.liveSyncPosition;
          if (liveEdge != null && liveEdge > video.currentTime) {
            video.currentTime = liveEdge;
          } else if (video.seekable.length > 0) {
            video.currentTime = video.seekable.end(video.seekable.length - 1);
          }
          hls?.startLoad();
          video.play().catch(() => { /* ignore — controls let the viewer resume manually */ });
          nudgedAt = Date.now();
        } else if (stalledTicks >= 4 && Date.now() - nudgedAt > 8000) {
          // Still frozen a good while after the nudge — that didn't work
          stalledTicks = 0;
          if (hls) {
            fullReinit();
          } else {
            // Native (Safari) path has no hls.js instance to recreate —
            // reloading the <video> element's source is the equivalent
            video.src = '';
            video.src = src;
            tryPlay();
          }
        }
      } else {
        stalledTicks = 0;
      }
      lastTime = video.currentTime;
    }, 5000);

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      tryPlay();
      return () => {
        clearTimeout(slowTimer);
        clearInterval(watchdog);
      };
    }

    import('hls.js').then(({ default: Hls }) => {
      if (cancelled) return;
      HlsCtor = Hls;
      initHls();
    });

    return () => {
      cancelled = true;
      clearTimeout(slowTimer);
      clearInterval(watchdog);
      hls?.destroy();
    };
  }, [src]);

  if (!src) {
    return <div className="video-unsupported-note">⚠️ This stream has no playback URL</div>;
  }

  if (error) {
    return <div className="video-unsupported-note">⚠️ {error}</div>;
  }

  return (
    <div className="live-video-wrapper">
      {buffering && (
        <div className="live-video-buffering">
          Connecting to stream…
          {slow && <span className="live-video-buffering-hint"> This is taking a while — the broadcaster may not actually be live.</span>}
        </div>
      )}
      <video
        ref={videoRef}
        className={className}
        controls
        autoPlay
        muted
        playsInline
        onPlaying={() => setBuffering(false)}
        onWaiting={() => setBuffering(true)}
      />
    </div>
  );
};

export default LiveVideoPlayer;
