import React, { useEffect, useState } from 'react';
import { NostrEventSigned } from '../types';
import { NostrCore, EventCache } from '../nostr/core';
import QuotedNoteCard from './QuotedNoteCard';
import RelayBadges from './RelayBadges';

interface InlineQuotedNoteProps {
  noteId: string;
  onNavigateToProfile: (pubkey: string) => void;
  onNavigateToNote?: (noteId: string) => void;
}

/**
 * A note referred to in a chat message, shown as the note itself.
 *
 * Sharing a post into a stream chat left a "View note" button and nothing to
 * read — the one thing the message was about took a trip to another page to
 * see. Until it arrives the button is still what is shown, since a chat
 * should not sit waiting on a relay.
 */
const InlineQuotedNote: React.FC<InlineQuotedNoteProps> = ({
  noteId,
  onNavigateToProfile,
  onNavigateToNote
}) => {
  const [note, setNote] = useState<NostrEventSigned | null>(() => EventCache.getEvent(noteId) || null);

  useEffect(() => {
    if (note) return;
    let cancelled = false;
    NostrCore.fetchEventById(noteId).then(found => {
      if (found && !cancelled) setNote(found);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  if (!note) {
    return (
      <button
        type="button"
        className="mention-link"
        onClick={(e) => { e.stopPropagation(); onNavigateToNote?.(noteId); }}
      >
        📝 View note
      </button>
    );
  }

  return (
    <span className="inline-quoted-note" onClick={(e) => e.stopPropagation()}>
      <QuotedNoteCard
        event={note}
        onNavigateToProfile={onNavigateToProfile}
        onNavigateToNote={onNavigateToNote}
      />
      <RelayBadges eventId={note.id} />
    </span>
  );
};

export default InlineQuotedNote;
