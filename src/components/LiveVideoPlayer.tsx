import React, { useEffect, useRef, useState } from 'react';
import type Hls from 'hls.js';
import { unplayableReason } from '../utils/liveStream';
import {
  PlayIcon, PauseIcon, VolumeIcon, MutedIcon, GearIcon,
  FullscreenIcon, ExitFullscreenIcon, PipIcon
} from './Icons';

interface QualityLevel {
  /** Index into hls.js's own level list */
  index: number;
  label: string;
}

interface LiveVideoPlayerProps {
  src: string;
  className?: string;
  /**
   * Shrink the player into a corner of the page rather than into the
   * browser's own picture-in-picture window. Where this is given it replaces
   * that button: the browser's window is placed and stacked by the browser,
   * which drops it behind everything the moment something else is clicked,
   * and a page cannot ask it to do otherwise. A corner of the page can be
   * put where it belongs and stays where it is put.
   */
  onMinimize?: () => void;
  /** True while it is in that corner, so the button offers the way back */
  minimized?: boolean;
}

/**
 * Plays an HLS (.m3u8) live stream. Safari supports HLS natively via
 * <video src>; every other browser needs hls.js, which demuxes the stream
 * into fragments MSE can play. hls.js is ~500KB, so it's dynamically
 * imported here rather than bundled into the main chunk every page pays for.
 */
const LiveVideoPlayer: React.FC<LiveVideoPlayerProps> = ({ src, className, onMinimize, minimized }) => {
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
  const wrapperRef = useRef<HTMLDivElement>(null);
  // How many times the player has been rebuilt since video last flowed. It
  // resets on the first fragment that arrives, so a stream that comes back
  // an hour later is picked up with the same budget as the first minute.
  const remountsRef = useRef(0);
  // Whether the picture is meant to be moving. Only a deliberate press of
  // pause turns this off, so a player that stopped by itself can be told to
  // carry on without overriding someone who paused it.
  const wantsPlayRef = useRef(true);

  // The browser's own controls are switched off below, because its menu —
  // the one holding playback speed — is drawn in a closed shadow tree that a
  // page cannot add to. Quality would have had to sit somewhere else on the
  // picture. Everything is drawn here instead, so it is all one menu.
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [volume, setVolume] = useState(1);
  const [speed, setSpeed] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [menu, setMenu] = useState<'closed' | 'quality' | 'speed'>('closed');

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;

    // Some addresses cannot work from here at all. Left to hls.js they look
    // like a stream that never starts, and the page waits on it forever.
    const refused = unplayableReason(src);
    if (refused) {
      setError(refused);
      setBuffering(false);
      return;
    }

    setError(null);
    setBuffering(true);
    setSlow(false);

    let hls: Hls | null = null;
    let cancelled = false;

    const tryPlay = () => {
      video.play().catch(err => console.warn('[LiveVideoPlayer] Autoplay was blocked:', err));
    };

    const slowTimer = setTimeout(() => setSlow(true), 15000);

    // Not every "stream" is HLS: some broadcasters publish a plain file —
    // .mp4, .webm — and hls.js cannot make sense of one, since it is looking
    // for a playlist. The browser plays those on its own.
    const isPlaylist = /\.(m3u8|mpd)(\?|#|$)/i.test(src);
    if (!isPlaylist) {
      const onNativeError = () => {
        setBuffering(false);
        setError('This stream could not be played — the file may be gone, or in a format this browser cannot play');
      };
      video.addEventListener('error', onNativeError);
      video.src = src;
      tryPlay();

      return () => {
        cancelled = true;
        clearTimeout(slowTimer);
        video.removeEventListener('error', onNativeError);
      };
    }

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
        remountsRef.current = 0;
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        console.warn('[LiveVideoPlayer] HLS error:', data.type, data.details, 'fatal:', data.fatal);
        if (!data.fatal || !hls) return;

        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            if (networkRetries++ < MAX_RETRIES) {
              console.warn(`[LiveVideoPlayer] Retrying after network error (${networkRetries}/${MAX_RETRIES})`);
              hls.startLoad();
            } else if (remountsRef.current < 3) {
              console.warn('[LiveVideoPlayer] Network retries exhausted — remounting player');
              remountsRef.current += 1;
              setReinitKey(k => k + 1);
            } else {
              setError('Stream unavailable — the broadcaster may not be live right now');
            }
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            if (mediaRetries++ < MAX_RETRIES) {
              console.warn(`[LiveVideoPlayer] Recovering from media error (${mediaRetries}/${MAX_RETRIES})`);
              hls.recoverMediaError();
            } else if (remountsRef.current < 3) {
              console.warn('[LiveVideoPlayer] Media retries exhausted — remounting player');
              remountsRef.current += 1;
              setReinitKey(k => k + 1);
            } else {
              setError('Playback error — the stream will be picked up again if it comes back');
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

  // A live stream can stop moving without hls.js calling it an error: the
  // playlist stops being updated, or a fragment never arrives, and the
  // picture simply freezes. Nothing then asks for it to be fixed, which is
  // why the page had to be reloaded to get the stream back.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || error) return;

    let frozenAt: number | null = null;
    let stalledSeconds = 0;
    // How many times in a row the picture has been found standing still
    let stalledRounds = 0;

    const check = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (video.ended) return;

      // Stopped without being asked to stop — which is what a player rebuilt
      // after a break looks like: a brand-new element, at nought, playing
      // nothing, with nobody left to press play
      if (video.paused) {
        if (!wantsPlayRef.current) {
          frozenAt = null;
          stalledSeconds = 0;
          return;
        }
        video.play().catch(() => undefined);
      }

      if (frozenAt !== null && video.currentTime === frozenAt) {
        stalledSeconds += 5;
        if (stalledSeconds < 15) return;

        stalledSeconds = 0;
        stalledRounds += 1;
        const hls = hlsRef.current;

        // Asking it to load again is cheap and is what hls.js offers for
        // exactly this, so it is not rationed — it is only the rebuilding
        // of the whole player that has to be
        if (hls) {
          console.warn('[LiveVideoPlayer] Picture has not moved for 15s — reaching for the live edge');
          hls.startLoad();
          const edge = (hls as unknown as { liveSyncPosition?: number }).liveSyncPosition;
          if (typeof edge === 'number' && edge > video.currentTime) video.currentTime = edge;
        }

        // Half a minute of asking and still nothing: start the player over.
        // The
        // budget is cleared with it — a stream that has been gone this long
        // and comes back is a fresh attempt, not another retry in a storm.
        if (stalledRounds >= 2) {
          console.warn('[LiveVideoPlayer] Half a minute without a picture — building the player again');
          stalledRounds = 0;
          remountsRef.current = 0;
          setReinitKey(k => k + 1);
        }
        return;
      }

      frozenAt = video.currentTime;
      stalledSeconds = 0;
      stalledRounds = 0;
    }, 5000);

    return () => clearInterval(check);
  }, [error, reinitKey]);

  // Having given up, keep looking: a broadcaster who drops off for a few
  // minutes and comes back used to need the page reloading to be seen again
  useEffect(() => {
    if (!error) return;
    // Only the errors that a stream coming back would cure — an address this
    // browser cannot play is not one of them
    if (!/unavailable|Playback error/i.test(error)) return;

    const retry = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      console.warn('[LiveVideoPlayer] Looking for the stream again');
      remountsRef.current = 0;
      setError(null);
      setReinitKey(k => k + 1);
    }, 30000);

    return () => clearInterval(retry);
  }, [error]);

  // Fullscreen can also be left with Escape or the browser's own gesture, so
  // the button follows the document rather than its own last click
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === wrapperRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      wantsPlayRef.current = true;
      video.play().catch(() => undefined);
    } else {
      wantsPlayRef.current = false;
      video.pause();
    }
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  };

  const changeVolume = (value: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = value;
    // Dragging the slider up is also how someone unmutes
    if (value > 0 && video.muted) {
      video.muted = false;
      setMuted(false);
    }
    setVolume(value);
  };

  const chooseSpeed = (value: number) => {
    const video = videoRef.current;
    if (video) video.playbackRate = value;
    setSpeed(value);
    setMenu('closed');
  };

  const chooseQuality = (index: number) => {
    setCurrentLevel(index);
    if (hlsRef.current) hlsRef.current.currentLevel = index;
    setMenu('closed');
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else wrapperRef.current?.requestFullscreen().catch(() => undefined);
  };

  const togglePip = async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch {
      // Refused (unsupported, or the video has no picture yet) — nothing to
      // recover from, the button simply does nothing
    }
  };

  const qualityLabel = currentLevel === -1
    ? 'Auto'
    : levels.find(l => l.index === currentLevel)?.label ?? 'Auto';

  if (!src) {
    return <div className="video-unsupported-note">⚠️ This stream has no playback URL</div>;
  }

  if (error) {
    return <div className="video-unsupported-note">⚠️ {error}</div>;
  }

  return (
    <div className={`live-video-wrapper ${menu !== 'closed' ? 'menu-open' : ''}`} ref={wrapperRef}>

      {buffering && (
        <div className="live-video-buffering">
          Connecting to stream…
          {slow && <span className="live-video-buffering-hint"> This is taking a while — the broadcaster may not actually be live.</span>}
        </div>
      )}
      <video
        key={reinitKey}
        ref={videoRef}
        className={className}
        autoPlay
        muted
        playsInline
        onClick={togglePlay}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onVolumeChange={(e) => {
          const video = e.currentTarget;
          setMuted(video.muted);
          setVolume(video.volume);
        }}
        onPlaying={() => setBuffering(false)}
        onWaiting={() => setBuffering(true)}
      />

      <div className="live-video-controls">
        <button type="button" className="live-video-btn" onClick={togglePlay} title={playing ? 'Pause' : 'Play'}>
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>

        <div className="live-video-volume">
          <button type="button" className="live-video-btn" onClick={toggleMute} title={muted ? 'Unmute' : 'Mute'}>
            {muted || volume === 0 ? <MutedIcon /> : <VolumeIcon />}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={(e) => changeVolume(Number(e.target.value))}
            title="Volume"
          />
        </div>

        {/* A live stream has no position to show, only whether you are at the
            edge of it — which is where this player always is */}
        <span className="live-video-live">● LIVE</span>

        <span className="live-video-spacer" />

        <div className="live-video-menu-wrapper">
          <button
            type="button"
            className={`live-video-btn ${menu !== 'closed' ? 'active' : ''}`}
            onClick={() => setMenu(open => (open === 'closed' ? 'quality' : 'closed'))}
            title="Settings"
          >
            <GearIcon />
          </button>

          {menu !== 'closed' && (
            <div className="live-video-menu">
              <div className="live-video-menu-tabs">
                <button
                  type="button"
                  className={menu === 'quality' ? 'active' : ''}
                  onClick={() => setMenu('quality')}
                >
                  Quality
                </button>
                <button
                  type="button"
                  className={menu === 'speed' ? 'active' : ''}
                  onClick={() => setMenu('speed')}
                >
                  Speed
                </button>
              </div>

              {menu === 'quality' ? (
                <div className="live-video-menu-list">
                  {levels.length > 1 ? (
                    <>
                      <button
                        type="button"
                        className={currentLevel === -1 ? 'chosen' : ''}
                        onClick={() => chooseQuality(-1)}
                      >
                        Auto
                      </button>
                      {[...levels].reverse().map(level => (
                        <button
                          key={level.index}
                          type="button"
                          className={currentLevel === level.index ? 'chosen' : ''}
                          onClick={() => chooseQuality(level.index)}
                        >
                          {level.label}
                        </button>
                      ))}
                    </>
                  ) : (
                    <span className="live-video-menu-empty">
                      This stream is sent at one quality only
                    </span>
                  )}
                </div>
              ) : (
                <div className="live-video-menu-list">
                  {[0.5, 0.75, 1, 1.25, 1.5, 2].map(rate => (
                    <button
                      key={rate}
                      type="button"
                      className={speed === rate ? 'chosen' : ''}
                      onClick={() => chooseSpeed(rate)}
                    >
                      {rate === 1 ? 'Normal' : `${rate}×`}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <span className="live-video-quality-label">{qualityLabel}</span>

        {onMinimize ? (
          <button
            type="button"
            className={`live-video-btn ${minimized ? 'active' : ''}`}
            onClick={onMinimize}
            title={minimized ? 'Back to full size' : 'Shrink into the corner'}
          >
            <PipIcon />
          </button>
        ) : document.pictureInPictureEnabled && (
          <button type="button" className="live-video-btn" onClick={togglePip} title="Picture in picture">
            <PipIcon />
          </button>
        )}

        <button
          type="button"
          className="live-video-btn"
          onClick={toggleFullscreen}
          title={fullscreen ? 'Leave fullscreen' : 'Fullscreen'}
        >
          {fullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
        </button>
      </div>
    </div>
  );
};

export default LiveVideoPlayer;
