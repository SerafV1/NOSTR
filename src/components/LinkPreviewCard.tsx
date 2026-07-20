import React, { useEffect, useState } from 'react';
import { fetchLinkPreview, LinkMetadata } from '../utils/linkPreview';

interface LinkPreviewCardProps {
  url: string;
}

const LinkPreviewCard: React.FC<LinkPreviewCardProps> = ({ url }) => {
  const [preview, setPreview] = useState<LinkMetadata | null>(null);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setImageFailed(false);

    fetchLinkPreview(url).then(result => {
      if (!cancelled) setPreview(result);
    });

    return () => { cancelled = true; };
  }, [url]);

  // Nothing to show yet — no skeleton, the card just pops in once ready
  if (!preview) return null;

  let hostname = url;
  try {
    hostname = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    // Malformed URL — fall back to showing it as-is
  }

  const showImage = !!preview.image && !imageFailed;
  const hasRichContent = !!(preview.title || preview.description || showImage);

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={`link-preview-card ${hasRichContent ? '' : 'link-preview-bare'}`}
      onClick={(e) => e.stopPropagation()}
    >
      {showImage && (
        <img
          src={preview.image}
          alt=""
          className="link-preview-image"
          onError={() => setImageFailed(true)}
        />
      )}
      <div className="link-preview-body">
        <div className="link-preview-hostname">{preview.siteName || hostname}</div>
        {preview.title && <div className="link-preview-title">{preview.title}</div>}
        {preview.description && <div className="link-preview-description">{preview.description}</div>}
      </div>
    </a>
  );
};

export default LinkPreviewCard;
