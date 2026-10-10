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
export function isReplyEvent(event: NostrEventSigned): boolean {
  const quoted = new Set(
    event.tags.filter(t => t[0] === 'q' && t[1]).map(t => t[1])
  );
  return event.tags.some(t =>
    t[0] === 'e' && t[1] && t[3] !== 'mention' && !quoted.has(t[1]));
}
