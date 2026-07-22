import React, { useState, useEffect } from 'react';
import { NostrEventSigned } from '../types';
import { NostrCore } from '../nostr/core';
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
  const [parentNote, setParentNote] = useState<NostrEventSigned | null>(null);
  const [replies, setReplies] = useState<NostrEventSigned[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Landing here straight from a page refresh, the relay pool hasn't
    // finished (re)connecting yet — fetching before then would just find
    // nothing and show "Note not found" for a note that really does exist
    if (!relaysConnected) return;
    loadNote();
  }, [noteId, relaysConnected]);

  const loadNote = async () => {
    setLoading(true);
    try {
      // Fetch the note
      const fetchedNote = await (NostrCore as any).fetchEventById(noteId);
      if (fetchedNote) {
        setNote(fetchedNote);

        // If this note is itself a reply, show the post it's replying to
        // above it for context — NIP-10: prefer the 'e' tag marked
        // 'reply' (the direct parent); fall back to the last 'e' tag for
        // notes using the older, unmarked positional convention
        const eTags = fetchedNote.tags.filter((t: string[]) => t[0] === 'e');
        const replyTag = eTags.find((t: string[]) => t[3] === 'reply') || eTags[eTags.length - 1];
        if (replyTag) {
          try {
            const parent = await (NostrCore as any).fetchEventById(replyTag[1]);
            setParentNote(parent);
          } catch (error) {
            console.error('Failed to fetch parent note:', error);
            setParentNote(null);
          }
        } else {
          setParentNote(null);
        }

        // Fetch replies to this note
        try {
          const fetchedReplies = await NostrCore.fetchReplies(noteId, 100);
          setReplies(fetchedReplies);
        } catch (error) {
          console.error('Failed to fetch replies:', error);
          setReplies([]);
        }
      } else {
        setNote(null);
        setParentNote(null);
        setReplies([]);
      }
    } catch (error) {
      console.error('Failed to load note:', error);
      setNote(null);
      setParentNote(null);
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

        {(loading || !relaysConnected) && (
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
            {parentNote && (
              <div className="note-parent-context">
                <EventCard
                  event={parentNote}
                  onNavigateToProfile={onNavigateToProfile}
                  onNavigateToNote={onNavigateToNote}
                  onNavigateToTopic={onNavigateToTopic}
                />
                <div className="note-parent-connector" />
              </div>
            )}
            <EventCard
              event={note}
              onNavigateToProfile={onNavigateToProfile}
              onNavigateToNote={onNavigateToNote}
              onNavigateToTopic={onNavigateToTopic}
              onRefresh={loadNote}
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
