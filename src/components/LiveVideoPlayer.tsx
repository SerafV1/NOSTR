import React, { useEffect, useRef, useState } from 'react';
import type Hls from 'hls.js';

interface QualityLevel {
  /** Index into hls.js's own level list */
  index: number;
  label: string;
}

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
  // Bumping this remounts a brand-new <video> DOM node (via the key prop
  // below), used only as a last resort once hls.js's own recovery gives up.
  const [reinitKey, setReinitKey] = useState(0);
  // What the stream offers, and which one is being watched. -1 is hls.js's
  // own "auto": it picks by measured bandwidth, which is right until someone
  // wants to force a quality.
  const [levels, setLevels] = useState<QualityLevel[]>([]);
  const [currentLevel, setCurrentLevel] = useState(-1);
  const hlsRef = useRef<Hls | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    setError(null);
    setBuffering(true);
    setSlow(false);

    let hls: Hls | null = null;
    let cancelled = false;

    const tryPlay = () => {
      video.play().catch(err => console.warn('[LiveVideoPlayer] Autoplay was blocked:', err));
    };

    const slowTimer = setTimeout(() => setSlow(true), 15000);

    import('hls.js').then(({ default: Hls }) => {
      if (cancelled) return;

      // Prefer hls.js whenever MSE is available — it's what's actually
      // battle-tested here. `canPlayType('application/vnd.apple.mpegurl')`
      // looks like the right way to detect native HLS support, but several
      // Chromium-based browsers (observed: Brave) return "maybe" for it
      // despite having no real native HLS playback — that false positive
      // was silently routing them to the browser's own unreliable native
      // handling, skipping every recovery mechanism below entirely. Only
      // fall back to native <video src> when hls.js genuinely can't run
      // (MSE unavailable — basically just Safari, where native HLS is
      // actually good).
      if (!Hls.isSupported()) {
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = src;
          tryPlay();
        } else {
          setError("Your browser can't play this stream format");
        }
        return;
      }

      // A 404 on a playlist/segment reload usually means the browser served
      // a stale cached .m3u8 listing segments that already aged out of the
      // live window — skip the HTTP cache entirely so reloads always see
      // what's actually current.
      hls = new Hls({
        fetchSetup: (context, initParams) =>
          new Request(context.url, { ...initParams, cache: 'no-store' }),
        xhrSetup: (xhr) => {
          xhr.setRequestHeader('Cache-Control', 'no-cache');
        }
      });
      hls.loadSource(src);
      hls.attachMedia(video);
      hlsRef.current = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
        // Named by height where the stream says one — "720p" is what people
        // look for — and by bitrate for the audio-only or unlabelled rungs
        setLevels(data.levels.map((level, index) => ({
          index,
          label: level.height
            ? `${level.height}p`
            : `${Math.round((level.bitrate || 0) / 1000)}kbps`
        })));
        setCurrentLevel(hls?.currentLevel ?? -1);
        console.log('[LiveVideoPlayer] Codecs reported by manifest:', data.levels.map(l => ({
          videoCodec: l.videoCodec,
          audioCodec: l.audioCodec,
          bitrate: l.bitrate,
          resolution: `${l.width}x${l.height}`
        })));
        tryPlay();
      });

      // hls.js's own documented recovery pattern (see their README): a
      // fatal error doesn't necessarily mean the stream is dead, just that
      // hls.js's own internal retries were exhausted. Give it another shot
      // via its own recovery APIs before giving up — but don't add extra
      // polling/forcing on top, since that ends up racing hls.js's own
      // internal reload cycle rather than helping it.
      let networkRetries = 0;
      let mediaRetries = 0;
      const MAX_RETRIES = 4;

      hls.on(Hls.Events.FRAG_LOADED, () => {
        networkRetries = 0;
        mediaRetries = 0;
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        console.warn('[LiveVideoPlayer] HLS error:', data.type, data.details, 'fatal:', data.fatal);
        if (!data.fatal || !hls) return;

        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            if (networkRetries++ < MAX_RETRIES) {
              console.warn(`[LiveVideoPlayer] Retrying after network error (${networkRetries}/${MAX_RETRIES})`);
              hls.startLoad();
            } else if (reinitKey < 3) {
              console.warn('[LiveVideoPlayer] Network retries exhausted — remounting player');
              setReinitKey(k => k + 1);
            } else {
              setError('Stream unavailable — the broadcaster may not be live right now');
            }
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            if (mediaRetries++ < MAX_RETRIES) {
              console.warn(`[LiveVideoPlayer] Recovering from media error (${mediaRetries}/${MAX_RETRIES})`);
              hls.recoverMediaError();
            } else if (reinitKey < 3) {
              console.warn('[LiveVideoPlayer] Media retries exhausted — remounting player');
              setReinitKey(k => k + 1);
            } else {
              setError('Playback error — try reloading the page');
            }
            break;
          default:
            setError('Stream unavailable — the broadcaster may not be live right now');
        }
      });
    });

    return () => {
      cancelled = true;
      clearTimeout(slowTimer);
      hlsRef.current = null;
      setLevels([]);
      hls?.destroy();
    };
  }, [src, reinitKey]);

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
      {/* Only worth showing when the stream actually offers a choice */}
      {levels.length > 1 && (
        <select
          className="live-video-quality"
          value={currentLevel}
          title="Picture quality"
          onChange={(e) => {
            const chosen = Number(e.target.value);
            setCurrentLevel(chosen);
            if (hlsRef.current) hlsRef.current.currentLevel = chosen;
          }}
        >
          <option value={-1}>Auto</option>
          {levels.map(level => (
            <option key={level.index} value={level.index}>{level.label}</option>
          ))}
        </select>
      )}
      <video
        key={reinitKey}
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
