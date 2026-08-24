import React, { useEffect, useRef, useState } from 'react';

interface VideoPlayerProps {
  src: string;
  className?: string;
}

/**
 * Video player that detects codec problems: if the browser can decode the
 * audio but not the video track (e.g. HEVC in .mov/.mp4), it shows a notice
 * with a link to open the file externally instead of a silent black box.
 */
const VideoPlayer: React.FC<VideoPlayerProps> = ({ src, className }) => {
  const [audioOnly, setAudioOnly] = useState(false);
  const [failed, setFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  /**
   * Scrolling past a playing video stops it.
   *
   * A feed is read by scrolling, and a video left playing somewhere above
   * carries on talking over whatever is being read now — with no way to find
   * it again short of scrolling back. It is paused rather than reset, so
   * coming back to it and pressing play continues from where it was.
   *
   * A live stream is the exception and has its own behaviour: it moves to
   * the corner and keeps going, which is what a live thing is for.
   */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting && !video.paused) video.pause();
      },
      // Half out of sight is still being watched; gone is gone
      { threshold: 0.1 }
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, []);

  if (failed) {
    return (
      <div className="video-unsupported-note">
        ⚠️ Video can't be loaded —{' '}
        <a href={src} target="_blank" rel="noopener noreferrer" className="content-link">
          open it in a new tab
        </a>
      </div>
    );
  }

  return (
    <div className="video-player-wrapper">
      {audioOnly && (
        <div className="video-unsupported-note">
          ⚠️ This video's codec isn't supported by your browser (audio only) —{' '}
          <a href={src} target="_blank" rel="noopener noreferrer" className="content-link">
            open it in a new tab
          </a>
        </div>
      )}
      <video
        ref={videoRef}
        className={className}
        src={src}
        controls
        preload="metadata"
        playsInline
        onLoadedMetadata={(e) => {
          const video = e.target as HTMLVideoElement;
          // A decodable video track always reports its dimensions
          if (video.videoWidth === 0 && video.videoHeight === 0) {
            setAudioOnly(true);
          }
        }}
        onError={() => setFailed(true)}
      />
    </div>
  );
};

export default VideoPlayer;
