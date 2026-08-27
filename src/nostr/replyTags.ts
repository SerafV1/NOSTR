import { NostrEventSigned } from '../types';
import { EVENT_KINDS } from '../types';

/**
 * The tags that put a reply into its conversation, and tell the people in it.
 *
 * Two shapes, because nostr has two. A reply to an ordinary note is NIP-10:
 * the thread's root and the note answered, each marked, plus a 'p' for
 * everyone taking part. A reply to a NIP-22 comment is itself a comment:
 * the root scope in capitals, the parent in lower case.
 *
 * The 'p' tags are not decoration. A client finds what was said to someone by
 * asking relays for their 'p' tag, so a reply carrying none is a reply the
 * person answered is never told about.
 */
export function replyTags(
  parent: NostrEventSigned,
  ownPubkey?: string | null
): { tags: string[][]; people: Set<string> } {
  const tags: string[][] = [];
  const people = new Set<string>();

  if (parent.kind === EVENT_KINDS.COMMENT) {
    // A comment with no root scope of its own is itself the top of the thread
    const rootId = parent.tags.find(t => t[0] === 'E')?.[1] || parent.id;
    const rootKind = parent.tags.find(t => t[0] === 'K')?.[1] || String(parent.kind);
    const rootAuthor = parent.tags.find(t => t[0] === 'P')?.[1] || parent.pubkey;

    tags.push(['E', rootId], ['K', rootKind], ['P', rootAuthor]);
    tags.push(['e', parent.id], ['k', String(parent.kind)], ['p', parent.pubkey]);
    people.add(parent.pubkey);
    people.add(rootAuthor);
  } else {
    const markedRoot = parent.tags.find(t => t[0] === 'e' && t[3] === 'root')?.[1];
    // Notes written before markers existed carry the root first and the
    // parent last, by position alone
    const firstE = parent.tags.find(t => t[0] === 'e')?.[1];
    const rootId = markedRoot || firstE || parent.id;

    if (rootId === parent.id) {
      tags.push(['e', parent.id, '', 'root']);
    } else {
      tags.push(['e', rootId, '', 'root']);
      tags.push(['e', parent.id, '', 'reply']);
    }

    people.add(parent.pubkey);
    for (const tag of parent.tags) {
      if (tag[0] === 'p' && /^[0-9a-f]{64}$/i.test(tag[1] || '')) people.add(tag[1]);
    }

    // Nobody needs telling about their own reply
    if (ownPubkey) people.delete(ownPubkey);
    people.forEach(pubkey => tags.push(['p', pubkey]));
  }

  return { tags, people };
}
