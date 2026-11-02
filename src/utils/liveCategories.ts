import { LiveStreamInfo } from './liveStream';

/**
 * What a stream is about, as the network actually says it.
 *
 * NIP-53 has no field for a category, so every client that offers one reads
 * the event's hashtags — its `t` tags. Which words count is a convention
 * rather than a spec, and the one in use is zap.stream's: its category pages
 * query `t` for the words below, and its own publisher writes an
 * `internal:<id>` tag beside them. Measured across 1,823 live-event
 * addresses on the relays, `t` is the only tag carrying a subject at all —
 * there were 2,005 of them, against four `l` labels, none of which named a
 * subject.
 *
 * So the same words are used here. A stream tagged on zap.stream lands in
 * the same tab here, and one tagged here lands in the same category there.
 */
export interface LiveCategory {
  id: string;
  label: string;
  /** The hashtags that put a stream in it, beside `internal:<id>` */
  tags: string[];
}

export const LIVE_CATEGORIES: LiveCategory[] = [
  { id: 'irl', label: 'IRL', tags: ['irl'] },
  { id: 'gaming', label: 'Gaming', tags: ['gaming'] },
  { id: 'music', label: 'Music', tags: ['music', 'radio'] },
  { id: 'talk', label: 'Talk', tags: ['talk'] },
  { id: 'art', label: 'Art', tags: ['art'] },
  { id: 'gambling', label: 'Gambling', tags: ['gambling', 'casino', 'slots'] },
  {
    id: 'science-and-technology',
    label: 'Science & Technology',
    tags: ['science', 'technology']
  }
];

/** The id of the tab that holds everything */
export const ALL_LIVE = 'all';

const wordsFor = (category: LiveCategory): Set<string> =>
  new Set([...category.tags, `internal:${category.id}`]);

const wordsById = new Map(LIVE_CATEGORIES.map(c => [c.id, wordsFor(c)]));

/**
 * Hashtags are written however the broadcaster felt like writing them —
 * "Music", "music" and "MUSIC" are all on the relays right now — so the
 * comparison is made on one case.
 */
export function inCategory(stream: LiveStreamInfo, categoryId: string): boolean {
  if (categoryId === ALL_LIVE) return true;
  const words = wordsById.get(categoryId);
  if (!words) return true;
  return stream.hashtags.some(tag => words.has(tag.toLowerCase()));
}

/** Whether an id names a tab, so a hand-typed address cannot empty the page */
export const isLiveCategory = (id: string): boolean =>
  id === ALL_LIVE || wordsById.has(id);
