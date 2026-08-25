/**
 * A written record of every time the timeline changes, and why.
 *
 * The feed has been seen adding a post without the "show new posts" button
 * being pressed, and three attempts to reason out which path did it have each
 * been wrong — the last two were disproved by measurement. Every candidate is
 * a state change that happens seconds apart while nobody is looking at a
 * console, so this writes down what actually happened instead.
 *
 * Kept short and cheap. It is a diagnostic and meant to be removed once the
 * path is known.
 */
const KEY = 'nostr_feed_trail';
const LIMIT = 60;

export const noteFeedChange = (reason: string, detail: string): void => {
  try {
    const at = new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    });
    const kept = JSON.parse(localStorage.getItem(KEY) || '[]') as string[];
    kept.push(`${at} ${reason} — ${detail}`);
    localStorage.setItem(KEY, JSON.stringify(kept.slice(-LIMIT)));
  } catch {
    // Storage being unavailable must not break the feed
  }
};

export const readFeedTrail = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]') as string[];
  } catch {
    return [];
  }
};

export const clearFeedTrail = (): void => {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing to clear
  }
};
