import React, { useEffect, useRef, useState } from 'react';

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

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    setError(null);

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      return;
    }

    let hls: import('hls.js').default | null = null;
    let cancelled = false;

    import('hls.js').then(({ default: Hls }) => {
      if (cancelled) return;

      if (!Hls.isSupported()) {
        setError("Your browser can't play this stream format");
        return;
      }

      hls = new Hls();
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          console.error('[LiveVideoPlayer] Fatal HLS error:', data);
          setError('Stream unavailable — the broadcaster may not be live right now');
        }
      });
    });

    return () => {
      cancelled = true;
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
    <video
      ref={videoRef}
      className={className}
      controls
      autoPlay
      muted
      playsInline
    />
  );
};

export default LiveVideoPlayer;
