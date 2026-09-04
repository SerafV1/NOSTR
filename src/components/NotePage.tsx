import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
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

  /**
   * Keeping the opened note where the eye is.
   *
   * A reply is opened with its thread above it, and that thread arrives one
   * post at a time, each one pushing the reply further down a page that was
   * sitting at the top. Clicking an answer in notifications landed on
   * whatever the conversation started with, and the answer itself — the
   * thing that was clicked — was somewhere below the fold.
   *
   * So the opened note is held in the middle of the screen while its
   * ancestors and their pictures land above it, and the moment the reader
   * scrolls anywhere themselves, this stops and stays stopped.
   */
  const focusRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const anchoring = useRef(true);
  const placedAt = useRef<number | null>(null);

  /**
   * Whatever actually scrolls around the note. Not the main panel, as this
   * first assumed and measured wrong: the page inside it does its own
   * scrolling, and which element that is has changed before now.
   */
  const scroller = (): HTMLElement | null => {
    let el = focusRef.current?.parentElement || null;
    while (el) {
      const how = getComputedStyle(el).overflowY;
      if ((how === 'auto' || how === 'scroll') && el.scrollHeight > el.clientHeight) return el;
      el = el.parentElement;
    }
    return (document.scrollingElement as HTMLElement | null);
  };

  const centreOnFocus = () => {
    const focus = focusRef.current;
    if (!anchoring.current || !focus) return;
    const room = scroller()?.clientHeight ?? 0;
    // A post longer than the window cannot be centred — its middle on the
    // screen's middle hides its beginning — so a long one is read from
    // the top instead
    focus.scrollIntoView({ block: focus.offsetHeight > room ? 'start' : 'center' });
    placedAt.current = scroller()?.scrollTop ?? null;
  };

  // A different note is a fresh start, whatever the reader did on the last one
  useEffect(() => { anchoring.current = true; placedAt.current = null; }, [noteId]);

  useLayoutEffect(() => {
    // With nothing above it the note is already the first thing on the page
    if (!note || parentNotes.length === 0) return;
    centreOnFocus();
    // The answers to it count as much as the posts above: while they are
    // still on their way there is nothing under the note to scroll past, so
    // centring puts it at the bottom of the screen — which is where it sat,
    // with its replies below the fold, until they arrive and it is placed
    // again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note?.id, parentNotes.length, replies.length]);

  // Pictures arrive after the posts they are in, and every one of them
  // moves what is under it — above the note or below, both change where it
  // has to sit
  useEffect(() => {
    const thread = threadRef.current;
    if (!thread || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => centreOnFocus());
    observer.observe(thread);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note?.id, parentNotes.length, replies.length]);

  // The reader taking over ends it — including a scroll inside the page's
  // own scrolling panel, which is why this listens on the way down
  useEffect(() => {
    const onScroll = () => {
      const at = scroller()?.scrollTop;
      if (at === undefined || placedAt.current === null) return;
      if (Math.abs(at - placedAt.current) > 8) anchoring.current = false;
    };
    window.addEventListener('scroll', onScroll, true);
    return () => window.removeEventListener('scroll', onScroll, true);
  }, []);

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

        /**
         * What a comment is a comment on, where that is an addressable event.
         *
         * NIP-22 answers an article, a stream or a wiki page by its address
         * rather than by an id: `a` for the thing itself, `A` for the root of
         * the conversation. Walking `e` tags alone, a comment on an article
         * opened with nothing above it — the article never appeared, which is
         * exactly what somebody clicking through from notifications came for.
         */
        const findAddressTag = (ev: NostrEventSigned): string[] | undefined =>
          ev.tags.find(t => t[0] === 'a' && t[1]) || ev.tags.find(t => t[0] === 'A' && t[1]);

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
            if (!replyTag) {
              // No id to follow, but perhaps an address: an article, a
              // stream, anything addressable that was commented on
              const addressTag = findAddressTag(current);
              if (!addressTag) break;
              const [addressKind, addressAuthor, addressD = ''] = addressTag[1].split(':');
              if (!addressKind || !addressAuthor) break;
              if (seenIds.has(addressTag[1])) break;
              seenIds.add(addressTag[1]);
              const addressed = await NostrCore.fetchEventByAddress(
                Number(addressKind), addressAuthor, addressD
              );
              if (!addressed) break;
              ancestors.unshift(addressed);
              setParentNotes([...ancestors]);
              current = addressed;
              continue;
            }
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
          <div className="note-thread" ref={threadRef}>
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
            <div className="thread-focus" ref={focusRef}>
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
