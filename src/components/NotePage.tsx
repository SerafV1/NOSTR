import React, { useState, useEffect } from 'react';
import { NostrEventSigned } from '../types';
import { NostrCore } from '../nostr/core';
import EventCard from './EventCard';
import ComposeNote from './ComposeNote';

interface NotePageProps {
  noteId: string;
  onNavigateToProfile: (pubkey: string) => void;
  onNavigateToNote?: (noteId: string) => void;
  onNavigateToTopic?: (topic: string) => void;
  onBack: () => void;
}

const NotePage: React.FC<NotePageProps> = ({ noteId, onNavigateToProfile, onNavigateToNote, onNavigateToTopic, onBack }) => {
  const [note, setNote] = useState<NostrEventSigned | null>(null);
  const [replies, setReplies] = useState<NostrEventSigned[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadNote();
  }, [noteId]);

  const loadNote = async () => {
    setLoading(true);
    try {
      // Fetch the note
      const fetchedNote = await (NostrCore as any).fetchEventById(noteId);
      if (fetchedNote) {
        setNote(fetchedNote);
        
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
        setReplies([]);
      }
    } catch (error) {
      console.error('Failed to load note:', error);
      setNote(null);
      setReplies([]);
    } finally {
      setLoading(false);
    }
  };

  const handleNotePublished = (event: NostrEventSigned) => {
    setReplies([event, ...replies]);
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

        {loading && (
          <div className="loading">
            Loading note...
          </div>
        )}

        {!loading && !note && (
          <div className="empty-state">
            <p>Note not found</p>
          </div>
        )}

        {note && (
          <>
            <div className="note-main">
              <EventCard
                event={note}
                onNavigateToProfile={onNavigateToProfile}
                onNavigateToNote={onNavigateToNote}
                onNavigateToTopic={onNavigateToTopic}
              />
            </div>

            <div className="reply-section">
              <h3>Reply to this note</h3>
              <ComposeNote 
                replyTo={note.id}
                onPublished={handleNotePublished}
              />
            </div>

            {replies.length > 0 && (
              <div className="replies-section">
                <h3>Replies ({replies.length})</h3>
                <div className="replies-list">
                  {replies.map((reply) => (
                    <EventCard
                      key={reply.id}
                      event={reply}
                      onNavigateToProfile={onNavigateToProfile}
                      onNavigateToNote={onNavigateToNote}
                      onNavigateToTopic={onNavigateToTopic}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default NotePage;
