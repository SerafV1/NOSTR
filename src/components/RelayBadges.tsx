import React, { useEffect, useState } from 'react';
import { getRelayPool } from '../nostr/relay';
import { knownRelayIcon, loadRelayIcon, relayHost, relayIconSrc } from '../utils/relayIcons';

interface RelayBadgesProps {
  eventId: string;
  /** Redrawn when this changes — a note just published gains its relays late */
  refreshKey?: unknown;
}

/** How many to draw before the rest become a "+N" */
const VISIBLE = 5;

/**
 * A relay's own icon, falling back to its first letter. Which picture that
 * is — and why it is not simply the host's /favicon.ico — is decided in
 * utils/relayIcons.
 */
export const RelayMark: React.FC<{ url: string }> = ({ url }) => {
  const host = relayHost(url);
  const [named, setNamed] = useState<string | null>(() => knownRelayIcon(url));
  const [failed, setFailed] = useState(false);

  // Asked once per relay and remembered, so a feed of a hundred notes does
  // not ask the same handful of relays a hundred times
  useEffect(() => {
    if (named !== null) return;
    let cancelled = false;
    loadRelayIcon(url).then(icon => { if (!cancelled) setNamed(icon); });
    return () => { cancelled = true; };
  }, [url, named]);

  // What the relay named, when that is a format a browser will draw, and its
  // favicon otherwise; a letter if even that fails
  const src = relayIconSrc(url, named);

  // A failure belongs to the address that failed. Without this the favicon
  // falling through — which is what a relay serving a single-page site does,
  // answering /favicon.ico with a web page — left the letter standing even
  // after the relay's own icon arrived.
  useEffect(() => { setFailed(false); }, [src]);

  return (
    <span className="relay-mark" title={host}>
      {failed ? (
        <span className="relay-mark-letter">{host.charAt(0).toUpperCase()}</span>
      ) : (
        <img
          src={src}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
};

/**
 * Which relays this note was seen on: the ones that answered with it, and —
 * for a note written here — the ones that accepted it.
 *
 * Nostr has no single home for a note; it is on whichever relays happen to
 * carry it, and that is worth being able to see rather than guess.
 */
/** Notes already asked about, so a feed does not ask twice for the same one */
const asked = new Set<string>();

/**
 * Asking where a note lives, in batches.
 *
 * A feed can mount a dozen of these at once — reposted and quoted notes all
 * arrive embedded in something else, so none of them has been asked for.
 * One query per card would be a dozen queries to every relay in the same
 * moment; ids collected over a short pause go out as one.
 */
let pendingIds: string[] = [];
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
const waiting = new Set<() => void>();

const askWhereItLives = (eventId: string, done: () => void): void => {
  pendingIds.push(eventId);
  waiting.add(done);
  if (pendingTimer) return;

  pendingTimer = setTimeout(() => {
    const ids = pendingIds;
    const listeners = [...waiting];
    pendingIds = [];
    waiting.clear();
    pendingTimer = null;

    getRelayPool()
      // Asked for by name, so the answer is capped by how many were asked
      // about rather than by whatever a relay's default happens to be
      .fetchEvents([{ ids, limit: ids.length }], true)
      .catch(() => { /* the rows simply stay empty */ })
      .finally(() => listeners.forEach(listener => listener()));
  }, 400);
};

const RelayBadges: React.FC<RelayBadgesProps> = ({ eventId, refreshKey }) => {
  const [relays, setRelays] = useState<string[]>(() => getRelayPool().getSeenOn(eventId));

  // A note's relays are learned as answers arrive, so a card drawn the moment
  // the note appears often knows none yet
  useEffect(() => {
    let cancelled = false;
    const look = () => {
      if (!cancelled) setRelays(getRelayPool().getSeenOn(eventId));
    };
    look();
    const timer = setTimeout(look, 2000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [eventId, refreshKey]);

  // A reposted or quoted note arrives inside the thing that carries it, so it
  // was never asked for and nothing knows where it lives. Asking by id fills
  // that in — once per note, however many cards show it.
  useEffect(() => {
    if (relays.length > 0 || asked.has(eventId)) return;
    asked.add(eventId);
    let cancelled = false;
    askWhereItLives(eventId, () => {
      if (!cancelled) setRelays(getRelayPool().getSeenOn(eventId));
    });
    return () => { cancelled = true; };
  }, [eventId, relays.length]);

  if (relays.length === 0) return null;

  const shown = relays.slice(0, VISIBLE);
  const rest = relays.length - shown.length;

  return (
    <div
      className="relay-badges"
      title={`Seen on ${relays.length} relay${relays.length === 1 ? '' : 's'}:\n${relays.join('\n')}`}
    >
      {shown.map(url => <RelayMark key={url} url={url} />)}
      {rest > 0 && <span className="relay-badges-more">+{rest}</span>}
    </div>
  );
};

export default RelayBadges;
