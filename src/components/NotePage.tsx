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

/**
 * The note this one is a direct answer to. NIP-10 marks it 'reply', with
 * the top of the thread marked 'root'; older notes use the positional
 * convention where the last 'e' tag is the parent.
 */
const directParentId = (ev: NostrEventSigned): string | null => {
  const eTags = ev.tags.filter(t => t[0] === 'e');
  if (eTags.length === 0) return null;
  const marked = eTags.find(t => t[3] === 'reply');
  if (marked) return marked[1] || null;
  const root = eTags.find(t => t[3] === 'root');
  // Only a root marker means this answers the top of the thread directly
  if (root && eTags.length === 1) return root[1] || null;
  return eTags[eTags.length - 1][1] || null;
};

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
        // Asked twice over, and nothing that arrives is taken away again.
        // The quick round draws the conversation as soon as the first relays
        // answer; the thorough one behind it waits for all of them and fills
        // in whatever they were slow with — a reply that lives on one distant
        // relay used to hold up the whole page while it was waited for.
        const addReplies = (found: NostrEventSigned[]) => {
          if (found.length === 0) return;
          setReplies(prev => {
            const byId = new Map(prev.map(reply => [reply.id, reply]));
            for (const reply of found) byId.set(reply.id, reply);
            return Array.from(byId.values())
              .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
          });
        };

        NostrCore.fetchReplies(noteId, 100)
          .then(addReplies)
          .catch(error => console.error('Failed to fetch replies:', error));

        NostrCore.fetchReplies(noteId, 100, true)
          .then(async found => {
            if (found.length > 0) return found;
            // Nothing at all: arriving from the notifications page, the pool
            // is still busy with that page's own queries, and a conversation
            // that is merely late reads exactly like one that is not there
            await new Promise(resolve => setTimeout(resolve, 2000));
            return NostrCore.fetchReplies(noteId, 100, true);
          })
          .then(addReplies)
          .catch(error => console.error('Failed to fetch replies:', error));

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
            // Render each ancestor the moment it resolves. Waiting for the
            // whole chain meant a reply-to-a-reply sat with no context above
            // it until every lookup finished, and the thread only "fell into
            // place" seconds later.
            setParentNotes([...ancestors]);
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

  // The relay filter is '#e', and NIP-10 has a nested reply carry the
  // thread's root as well — so what comes back is the whole subtree. Only
  // what answers *this* note belongs in the list: a reply to a reply reads
  // as an answer to the post when shown alongside the direct ones. Open the
  // reply itself and the chain above it, plus its own replies, are there.
  const knownReplyIds = new Set(replies.map(r => r.id));
  const directReplies = replies
    .filter(reply => {
      const parent = directParentId(reply);
      // Unknown parent means the branch it belongs to wasn't fetched;
      // it still references this note, so showing it beats dropping it
      return !parent || parent === noteId || !knownReplyIds.has(parent);
    })
    .sort((a, b) => (a.created_at || 0) - (b.created_at || 0));

  return (
    <div className="note-page">
      <div className="note-container">
        <button className="back-btn" onClick={onBack}>
          <span className="back-btn-arrow" aria-hidden="true">←</span>
          Back
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
            {/* The one that was opened — the rest of the thread is context
                around it, so it is the only part shown at full size */}
            <div className="thread-focus">
              <EventCard
                event={note}
                focused
                onNavigateToProfile={onNavigateToProfile}
                onNavigateToNote={onNavigateToNote}
                onNavigateToTopic={onNavigateToTopic}
                onRefresh={() => loadNote(true)}
              />
            </div>

            {directReplies.length > 0 && (
              <>
                <div className="thread-divider">Replies</div>
                {directReplies.map(reply => (
                  <div className="thread-reply" key={reply.id}>
                    <EventCard
                      event={reply}
                      onNavigateToProfile={onNavigateToProfile}
                      onNavigateToNote={onNavigateToNote}
                      onNavigateToTopic={onNavigateToTopic}
                    />
                  </div>
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
