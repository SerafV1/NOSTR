import { EventCache } from '../nostr/core';
import { getRelayPool } from '../nostr/relay';
import { DirectMessageCore } from '../nostr/dm';

/**
 * What the app is holding, sampled while it runs.
 *
 * Reports of the tab reaching gigabytes after being left open for hours have
 * not reproduced on short test sessions with small accounts, and a snapshot
 * says nothing about growth. So the page keeps its own record: every five
 * minutes, the size of each thing it holds, for the last four hours. Whatever
 * climbs steadily down that list is the thing that leaks, and Settings shows
 * it with a button to copy it.
 *
 * Kept in memory only: it describes this tab, and is gone when the tab is.
 */
export interface MemorySample {
  /** Minutes since the page loaded */
  minute: number;
  /** The page's JavaScript heap, where the browser will say (Chromium does) */
  heapMB: number | null;
  domNodes: number;
  pictures: number;
  videos: number;
  frames: number;
  events: number;
  profiles: number;
  addressable: number;
  relays: number;
  connected: number;
  subscriptions: number;
  relaySubscriptions: number;
  seenOn: number;
  openedMessages: number;
}

const EVERY_MS = 5 * 60 * 1000;
const KEEP = 48;
const startedAt = Date.now();
const samples: MemorySample[] = [];

export function takeMemorySample(): MemorySample {
  const memory = (performance as any).memory;
  const cache = EventCache.stats();
  const pool = getRelayPool().stats();
  const sample: MemorySample = {
    minute: Math.round((Date.now() - startedAt) / 60000),
    heapMB: memory?.usedJSHeapSize ? +(memory.usedJSHeapSize / 1048576).toFixed(1) : null,
    domNodes: document.getElementsByTagName('*').length,
    pictures: document.getElementsByTagName('img').length,
    videos: document.getElementsByTagName('video').length,
    frames: document.getElementsByTagName('iframe').length,
    ...cache,
    ...pool,
    openedMessages: DirectMessageCore.openedCount()
  };
  return sample;
}

export function readMemoryTrail(): MemorySample[] {
  return [...samples];
}

/** Started once, for the life of the page */
export function watchMemory(): void {
  const record = () => {
    samples.push(takeMemorySample());
    if (samples.length > KEEP) samples.shift();
  };
  // A first one early, so even a short session has a starting point
  setTimeout(record, 30000);
  setInterval(record, EVERY_MS);
}

/** The record as plain text, for sending to whoever is looking into it */
export function memoryTrailText(): string {
  const rows = [...samples, takeMemorySample()];
  const columns: (keyof MemorySample)[] = [
    'minute', 'heapMB', 'domNodes', 'pictures', 'videos', 'frames',
    'events', 'profiles', 'addressable',
    'relays', 'connected', 'subscriptions', 'relaySubscriptions', 'seenOn', 'openedMessages'
  ];
  return [
    columns.join('\t'),
    ...rows.map(row => columns.map(c => row[c] ?? '-').join('\t'))
  ].join('\n');
}
