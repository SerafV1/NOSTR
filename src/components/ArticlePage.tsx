import React, { useEffect, useState } from 'react';
import { NostrEventSigned } from '../types';
import { NostrCore } from '../nostr/core';
import EventCard from './EventCard';

interface ArticlePageProps {
  kind: number;
  pubkey: string;
  identifier: string;
  relaysConnected: boolean;
  onNavigateToProfile: (pubkey: string) => void;
  onNavigateToNote: (noteId: string) => void;
  onNavigateToTopic?: (topic: string) => void;
}

/**
 * One long-form article (NIP-23), read in full.
 *
 * An article is addressable — kind, author and a `d` tag — so its author can
 * publish a corrected version at the same address, and this always shows the
 * newest one rather than whichever copy a relay kept. The card underneath is
 * the same card the feed uses, so an article can be replied to, liked,
 * reposted, zapped and bookmarked like anything else.
 */
const ArticlePage: React.FC<ArticlePageProps> = ({
  kind,
  pubkey,
  identifier,
  relaysConnected,
  onNavigateToProfile,
  onNavigateToNote,
  onNavigateToTopic
}) => {
  const [article, setArticle] = useState<NostrEventSigned | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading');

  useEffect(() => {
    if (!relaysConnected) return;
    let dropped = false;
    setState('loading');

    NostrCore.fetchEventByAddress(kind, pubkey, identifier)
      .then(event => {
        if (dropped) return;
        if (event) {
          setArticle(event);
          setState('ready');
        } else {
          setState('missing');
        }
      })
      .catch(() => { if (!dropped) setState('missing'); });

    return () => { dropped = true; };
  }, [kind, pubkey, identifier, relaysConnected]);

  return (
    <div className="article-page">
      {state === 'loading' && <div className="loading">Fetching the article…</div>}
      {state === 'missing' && (
        <div className="empty-state">
          <p>No relay here has this article.</p>
          <p className="settings-hint">
            It may live on relays this client does not read — adding the author's
            relay in Settings is what usually finds one.
          </p>
        </div>
      )}
      {state === 'ready' && article && (
        <EventCard
          event={article}
          focused
          onNavigateToProfile={onNavigateToProfile}
          onNavigateToNote={onNavigateToNote}
          onNavigateToTopic={onNavigateToTopic}
        />
      )}
    </div>
  );
};

export default ArticlePage;
