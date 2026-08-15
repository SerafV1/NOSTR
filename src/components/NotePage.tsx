import React, { useState, useEffect } from 'react';
import { NostrEventSigned } from '../types';
import { NostrCore, EventCache } from '../nostr/core';
import EventCard from './EventCard';

interface NotePageProps {
  noteId: string;
  relaysConnected: boolean;
  onNavigateToProfile: (pubkey: string) => void;
  onNavigateToNote?: (noteId: string) => void;
  onNavigateToTopic?: (topic: string) => void;
  onBack: () => void;
}

const NotePage: React.FC<NotePageProps> = ({ noteId, relaysConnected, onNavigateToProfile, onNavigateToNote, onNavigateToTopic, onBack }) => {
  const [note, setNote] = useState<NostrEventSigned | null>(null);
  // Root-first: index 0 is the top of the thread, last item is the note's
  // direct parent — a reply-to-a-reply needs the whole chain shown, not
  // just the one post immediately above it
  const [parentNotes, setParentNotes] = useState<NostrEventSigned[]>([]);
  const [replies, setReplies] = useState<NostrEventSigned[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // You almost always got here by clicking a note that is already in
    // memory. Show it immediately instead of blanking the page and waiting
    // on the network — the thread around it fills in behind it.
    const cached = EventCache.getEvent(noteId);
    setNote(cached || null);
    setParentNotes([]);
    setReplies([]);
    setLoading(!cached);

    // Landing here straight from a page refresh, the relay pool hasn't
    // finished (re)connecting yet — fetching before then would just find
    // nothing and show "Note not found" for a note that really does exist
    if (!relaysConnected) return;
    loadNote(!!cached);
  }, [noteId, relaysConnected]);

  const loadNote = async (haveCached: boolean) => {
    if (!haveCached) setLoading(true);
    try {
      // Fetch the note
      const fetchedNote = await (NostrCore as any).fetchEventById(noteId) || (haveCached ? EventCache.getEvent(noteId) : null);
      if (fetchedNote) {
        setNote(fetchedNote);
        // The note itself is on screen now — the thread around it loads
        // behind it rather than holding the whole page hostage
        setLoading(false);

        // NIP-10: prefer the 'e' tag marked 'reply' (the direct parent);
        // fall back to the last 'e' tag for notes using the older,
        // unmarked positional convention
        const findReplyTag = (ev: NostrEventSigned): string[] | undefined => {
          const eTags = ev.tags.filter((t) => t[0] === 'e');
          return eTags.find((t) => t[3] === 'reply') || eTags[eTags.length - 1];
        };

        // Replies don't depend on the ancestor walk below, so they're
        // started here and land whenever they land — chaining them after it
        // meant waiting out up to twenty sequential parent lookups first
        NostrCore.fetchReplies(noteId, 100)
          .then(setReplies)
          .catch(error => {
            console.error('Failed to fetch replies:', error);
            setReplies([]);
          });

        // If this note is itself a reply, walk all the way up the chain to
        // the root and show every ancestor for context — a reply-to-a-reply
        // needs the whole thread above it, not just the one direct parent
        const ancestors: NostrEventSigned[] = [];
        try {
          const seenIds = new Set<string>([fetchedNote.id]);
          let current = fetchedNote;
          for (let i = 0; i < 20; i++) {
            const replyTag = findReplyTag(current);
            if (!replyTag) break;
            const parentId = replyTag[1];
            if (seenIds.has(parentId)) break; // malformed/cyclic tags
            seenIds.add(parentId);
            // The tag's own relay hint (NIP-10: ['e', id, relayHint, marker])
            // matters here — a Fediverse-bridged ancestor often lives only
            // on the bridge's relay, nowhere in our default set
            const hintRelay = replyTag[2] ? [replyTag[2]] : undefined;
            const parent: NostrEventSigned | null = await (NostrCore as any).fetchEventById(parentId, hintRelay);
            if (!parent) break;
            ancestors.unshift(parent);
            current = parent;
          }
        } catch (error) {
          console.error('Failed to fetch parent note chain:', error);
        }
        setParentNotes(ancestors);
      } else {
        setNote(null);
        setParentNotes([]);
        setReplies([]);
      }
    } catch (error) {
      console.error('Failed to load note:', error);
      setNote(null);
      setParentNotes([]);
      setReplies([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="note-page">
      <div className="note-container">
        <button
          className="back-btn"
          onClick={onBack}
        >
          ← Back
        </button>

        {(loading || (!relaysConnected && !note)) && (
          <div className="loading">
            {!relaysConnected ? 'Connecting to relays...' : 'Loading note...'}
          </div>
        )}

        {!loading && !note && (
          <div className="empty-state">
            <p>Note not found</p>
          </div>
        )}

        {note && (
          <div className="note-thread">
            {parentNotes.length > 0 && (
              <div className="note-parent-context">
                {parentNotes.map((parent) => (
                  <React.Fragment key={parent.id}>
                    <EventCard
                      event={parent}
                      onNavigateToProfile={onNavigateToProfile}
                      onNavigateToNote={onNavigateToNote}
                      onNavigateToTopic={onNavigateToTopic}
                    />
                    <div className="note-parent-connector" />
                  </React.Fragment>
                ))}
              </div>
            )}
            <EventCard
              event={note}
              onNavigateToProfile={onNavigateToProfile}
              onNavigateToNote={onNavigateToNote}
              onNavigateToTopic={onNavigateToTopic}
              onRefresh={() => loadNote(true)}
            />

            {replies.length > 0 && (
              <>
                <div className="thread-divider">Replies</div>
                {replies.map((reply) => (
                  <EventCard
                    key={reply.id}
                    event={reply}
                    onNavigateToProfile={onNavigateToProfile}
                    onNavigateToNote={onNavigateToNote}
                    onNavigateToTopic={onNavigateToTopic}
                  />
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default NotePage;
