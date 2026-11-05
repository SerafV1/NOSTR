import { NostrEventSigned } from '../types';

/**
 * Telling a quote from a reply.
 *
 * Both carry an `e` tag naming the note they are about, so a reply list
 * built from "everything that mentions this id" collects quotes too — and
 * somebody quoting a post appeared underneath it as though they had answered
 * it. Two things say otherwise, and between them they catch every quote seen
 * in the wild that carries an `e` tag at all: NIP-18's `q` tag, and NIP-10's
 * "mention" marker.
 *
 * Measured over 1,406 notes published in six hours: twenty quoted another
 * note, fourteen of those named it only with a `q` tag — which never looked
 * like a reply — and the remaining six carried an `e` tag, every one of them
 * either a `q` tag as well or marked "mention".
 *
 * A note can be both at once: a reply to one note that quotes another, which
 * Primal writes as markers [mention, reply, root]. So this is always asked
 * about a particular note, never about the event as a whole.
 */
export function isQuoteOf(event: NostrEventSigned, noteId: string): boolean {
  return event.tags.some(t => t[0] === 'q' && t[1] === noteId)
    || event.tags.some(t => t[0] === 'e' && t[1] === noteId && t[3] === 'mention');
}

/**
 * Whether this is an answer to something, rather than a post of its own.
 *
 * An `e` tag alone does not make a reply: a note that quotes another carries
 * one too, and reading every `e` tag as an answer took quotes out of the
 * Posts tab and filed them under Replies.
 */
/**
 * The note this one is a direct answer to. NIP-10 marks it 'reply', with
 * the top of the thread marked 'root'; older notes use the positional
 * convention where the last 'e' tag is the parent.
 */
export function directParentId(event: NostrEventSigned): string | null {
  const eTags = event.tags.filter(t => t[0] === 'e');
  if (eTags.length === 0) return null;
  const marked = eTags.find(t => t[3] === 'reply');
  if (marked) return marked[1] || null;
  const root = eTags.find(t => t[3] === 'root');
  // Only a root marker means this answers the top of the thread directly
  if (root && eTags.length === 1) return root[1] || null;
  return eTags[eTags.length - 1][1] || null;
}

/**
 * What a reaction, a repost or a zap receipt is about: the last `e` tag.
 * NIP-25 says so for a reaction, and the others follow the same
 * convention — the thread's other ids are carried alongside it.
 */
export function targetOfResponse(event: NostrEventSigned): string | null {
  const eTags = event.tags.filter(t => t[0] === 'e' && t[1]);
  return eTags.length ? eTags[eTags.length - 1][1] : null;
}

export function isReplyEvent(event: NostrEventSigned): boolean {
  const quoted = new Set(
    event.tags.filter(t => t[0] === 'q' && t[1]).map(t => t[1])
  );
  return event.tags.some(t =>
    t[0] === 'e' && t[1] && t[3] !== 'mention' && !quoted.has(t[1]));
}
