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
