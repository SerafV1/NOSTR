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
  let path = '';
  let favicon: string | null = null;
  try {
    const parsed = new URL(url);
    hostname = parsed.hostname.replace(/^www\./, '');
    path = decodeURIComponent(parsed.pathname).replace(/\/$/, '');
    // The site's own icon, which it serves to anyone — unlike its page,
    // which some sites hand out only to crawlers they recognise
    favicon = `https://www.google.com/s2/favicons?domain=${parsed.hostname}&sz=64`;
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
      {/* Without title or picture the card was a bare hostname, which reads
          as a preview that failed. The site's icon and the path it points at
          at least say where the link goes. */}
      {!hasRichContent && favicon && (
        <img src={favicon} alt="" className="link-preview-favicon" />
      )}
      <div className="link-preview-body">
        <div className="link-preview-hostname">{preview.siteName || hostname}</div>
        {preview.title && <div className="link-preview-title">{preview.title}</div>}
        {preview.description && <div className="link-preview-description">{preview.description}</div>}
        {!hasRichContent && path && path !== '/' && (
          <div className="link-preview-path">{path}</div>
        )}
      </div>
    </a>
  );
};

export default LinkPreviewCard;
