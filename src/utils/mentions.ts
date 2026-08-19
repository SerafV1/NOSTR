import { nip19 } from 'nostr-tools';

/**
 * A message is typed with readable handles — "@Tony" — while what gets
 * published has to carry a real reference, or the person tagged is not
 * actually tagged at all. This turns the one into the other, and reports who
 * ended up mentioned so the event can carry their 'p' tags.
 *
 * Only handles the writer picked are converted: an "@someone" typed by hand,
 * with nobody behind it, is left alone as ordinary text.
 */
export function resolveMentionHandles(
  text: string,
  handles: Map<string, string>
): { content: string; mentioned: string[] } {
  let content = text;
  const mentioned: string[] = [];

  // Longest first, so "@Tony" cannot eat the start of "@TonyB"
  const byLength = [...handles.entries()].sort((a, b) => b[0].length - a[0].length);

  for (const [handle, pubkey] of byLength) {
    const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Followed by a space, punctuation or the end — otherwise "@Tony" would
    // match inside "@TonyB" and leave a stray "B"
    const pattern = new RegExp(`@${escaped}(?=[\\s.,!?;:]|$)`, 'g');
    if (!pattern.test(content)) continue;

    pattern.lastIndex = 0;
    content = content.replace(pattern, `nostr:${nip19.npubEncode(pubkey)}`);
    mentioned.push(pubkey);
  }

  return { content, mentioned };
}

/**
 * Where an "@query" being typed starts, and what has been typed so far.
 *
 * It counts only at the start of the text or right after whitespace, and may
 * not contain whitespace itself — otherwise an email address, or a sentence
 * that happens to contain an @, would open the suggestion list.
 */
export function detectMentionTrigger(
  text: string,
  cursor: number
): { start: number; query: string } | null {
  const uptoCursor = text.slice(0, cursor);
  const at = uptoCursor.lastIndexOf('@');
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(uptoCursor[at - 1])) return null;
  const query = uptoCursor.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}

/**
 * The handle to show for a name: its first word, stripped of anything that
 * would not survive being read back out of the text.
 */
export function handleFromName(name: string, fallback: string): string {
  return name.split(/\s+/)[0].replace(/[^\p{L}\p{N}_.-]/gu, '') || fallback;
}
