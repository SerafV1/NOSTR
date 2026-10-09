import { EVENT_KINDS } from '../types';
import { nip19 } from 'nostr-tools';

/**
 * A note, a person — pointed at through a web page instead of through nostr.
 * njump, primal, snort, iris, coracle and the rest all carry the same bech32
 * address in the link they hand out, and someone who pastes one means the
 * note, not the page it happens to be readable on.
 */
const ENTITY_SOURCE = '(?:note1|nevent1|npub1|nprofile1)[023456789acdefghjklmnpqrstuvwxyz]{20,}';
const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/;

/**
 * The nostr address a web link carries, if it carries one at all.
 *
 * It has to be in the path, not in the host. A blossom server gives every
 * account a subdomain of its own, so a picture posted from Amethyst arrives
 * as https://npub1….blossom.band/<hash>.jpg — a file on a server, not a web
 * page about that person. Read whole, the npub in the hostname turned the
 * picture into a mention, and the post lost the photograph it was written
 * around.
 */
export function nostrRefFromUrl(url: string): string | null {
  let carried = url;
  try {
    const { pathname, search, hash } = new URL(url);
    carried = `${pathname}${search}${hash}`;
  } catch {
    // Not something the browser will parse as a URL — read it whole, as before
  }

  const found = carried.match(new RegExp(ENTITY_SOURCE, 'i'));
  if (!found) return null;

  const ref = found[0].toLowerCase();
  try {
    const { type } = nip19.decode(ref);
    return type === 'note' || type === 'nevent' || type === 'npub' || type === 'nprofile' ? ref : null;
  } catch {
    // Anything whose checksum does not hold is not an address, whatever it
    // looked like inside the path
    return null;
  }
}

/**
 * Rewrite those links as the references they are, so everything downstream —
 * the quote card, the mention, the stream — reads them the way it reads a
 * note written by a client that speaks nostr addresses. Links that carry
 * nothing are left exactly as they were.
 */
export function foldNostrWebLinks(content: string): string {
  if (!content || !/https?:\/\//i.test(content)) return content;

  return content.replace(
    new RegExp(`https?:\\/\\/[^\\s<>"']*${ENTITY_SOURCE}[^\\s<>"']*`, 'gi'),
    (match) => {
      // A sentence's full stop can sit against the end of a link; it belongs
      // to the sentence, not the address
      const tail = match.match(TRAILING_PUNCTUATION)?.[0] || '';
      const url = tail ? match.slice(0, -tail.length) : match;
      const ref = nostrRefFromUrl(url);
      return ref ? `nostr:${ref}${tail}` : match;
    }
  );
}

/** A reference as written, without the `nostr:` or the `@` in front of it */
const bareRef = (ref: string): string => ref.replace(/^@/, '').replace(/^nostr:/i, '');

/** What an addressable reference points at, by kind */
export const ADDRESSABLE_KINDS: Record<number, string> = {
  30023: '📄 Article',
  30311: '📺 View stream',
  34550: '🗂 Community',
  39000: '👥 Group'
};

/**
 * An `naddr1…` and what can be done with it.
 *
 * A stream, an article and a group each have a page here, so those open; a
 * hundred and twenty characters of bech32 in the middle of a sentence is
 * unreadable either way, so the rest at least say what they are.
 */
export function describeAddressRef(
  ref: string
): {
  naddr: string;
  label: string;
  openable: boolean;
  path: string;
  /** Set for a group, so whoever draws it can ask the relay its name */
  group?: { relay: string; id: string };
} | null {
  try {
    const naddr = bareRef(ref);
    const decoded = nip19.decode(naddr);
    if (decoded.type !== 'naddr') return null;
    const { kind, identifier, relays } = decoded.data as {
      kind: number;
      identifier: string;
      relays?: string[];
    };

    // A group (NIP-29) lives on one relay and is named by its `d` tag, so an
    // invitation is only openable when the address says which relay — that
    // is half of the group's name. Invitations were arriving before this app
    // had groups at all, and stayed as a dead "👥 Group" label ever since.
    const groupRelay = kind === EVENT_KINDS.GROUP_METADATA
      ? (relays || []).find(url => /^wss?:\/\//i.test(url))
      : undefined;

    const path = kind === 30311
      ? `/live/${naddr}`
      : kind === 30023
        ? `/a/${naddr}`
        : groupRelay && identifier
          ? `/s/${encodeURIComponent(groupRelay.replace(/^wss:\/\//, '').replace(/\/$/, ''))}/${encodeURIComponent(identifier)}`
          : '';

    return {
      naddr,
      label: ADDRESSABLE_KINDS[kind] || '🔗 nostr address',
      openable: Boolean(path),
      path,
      ...(groupRelay && identifier ? { group: { relay: groupRelay, id: identifier } } : {})
    };
  } catch {
    return null;
  }
}

/**
 * Where to stop a long note so nothing is cut in half.
 *
 * A card shows the first five hundred characters and offers the rest behind
 * "Show more". Cut by counting alone, the five hundredth character lands in
 * the middle of whatever happens to be there — and what is often there is a
 * reference: `nostr:nprofile1…` is over a hundred characters long, a naddr
 * or an nevent much the same. Half of one resolves to nobody, so the mention
 * that should have been somebody's name was printed as a line of bech32 with
 * the end missing.
 *
 * So the cut moves back to the start of anything it would have split — a
 * nostr reference or a link — and then back again to the nearest space, so a
 * word is not halved either.
 */
const SPLITTABLE = new RegExp(
  `(?:nostr:)?${ENTITY_SOURCE}|(?:naddr1|nsec1)[023456789acdefghjklmnpqrstuvwxyz]{20,}|https?:\\/\\/\\S+`,
  'gi'
);

/** How far back a word boundary is worth looking for */
const TIDY_WITHIN = 80;

export function cutLength(text: string, limit: number): number {
  if (text.length <= limit) return text.length;

  let cut = limit;
  for (const match of text.matchAll(SPLITTABLE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    // Straddling the cut: keep all of it or none of it
    if (start < cut && end > cut) {
      cut = start;
      break;
    }
  }

  const space = text.lastIndexOf(' ', cut);
  const line = text.lastIndexOf('\n', cut);
  const boundary = Math.max(space, line);
  if (boundary > 0 && cut - boundary <= TIDY_WITHIN) return boundary;
  return cut;
}
