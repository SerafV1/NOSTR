/**
 * Checking whether a nostr address (NIP-05) belongs to the account showing
 * it off.
 *
 * `seraf@razr.social` is only a claim: the account writes it into its own
 * profile, and anybody can write anything there. It is worth something only
 * when the domain says the same thing back — a file at
 * `https://razr.social/.well-known/nostr.json?name=seraf` naming the same
 * key. Until this, the app printed every such claim as if it were true.
 *
 * Three answers, not two. An address the domain contradicts is a different
 * thing from one the domain never answered for: a server that is down, a
 * host that blocks cross-origin reads, a name that has since moved. The
 * first is worth warning about; the second only means "not known".
 */

export type Nip05Verdict = 'ok' | 'bad' | 'unreachable';

/** What NIP-05 allows on the left of the '@' */
const LOCAL_PART = /^[a-z0-9\-_.]+$/i;

const CACHE_KEY = 'nostr_nip05_checks';
/** A verified address is checked again the next day */
const GOOD_FOR_MS = 24 * 60 * 60 * 1000;
/**
 * A failed one much sooner: a domain being fixed, or a name just added,
 * should not read as wrong for a whole day
 */
const BAD_FOR_MS = 60 * 60 * 1000;

/**
 * How many domains are asked at once. A feed can put fifty addresses on
 * screen in one go, and firing fifty cross-origin requests at once is how a
 * page ends up waiting on the slowest of them for everything.
 */
const AT_ONCE = 4;

interface Remembered {
  verdict: Nip05Verdict;
  at: number;
}

const held = new Map<string, Remembered>();
const running = new Map<string, Promise<Nip05Verdict>>();
const waiting: (() => void)[] = [];
let active = 0;

const keyFor = (address: string, pubkey: string) => `${address.toLowerCase()}|${pubkey}`;

const readStore = (): Record<string, Remembered> => {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') as Record<string, Remembered>;
  } catch {
    return {};
  }
};

let store: Record<string, Remembered> | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

const remember = (key: string, verdict: Nip05Verdict): void => {
  const entry: Remembered = { verdict, at: Date.now() };
  held.set(key, entry);
  if (!store) store = readStore();
  store[key] = entry;
  // Written in one go rather than on every answer — a feed load settles
  // dozens of these within a second of each other
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(store));
    } catch {
      // Storage full or unavailable: the checks still work, they just have
      // to be made again next time
    }
  }, 500);
};

const stillGood = (entry: Remembered): boolean => {
  const age = Date.now() - entry.at;
  return age < (entry.verdict === 'ok' ? GOOD_FOR_MS : BAD_FOR_MS);
};

/** What was decided about this address before, if it was decided recently */
export function rememberedNip05(address: string, pubkey: string): Nip05Verdict | null {
  const key = keyFor(address, pubkey);
  const inMemory = held.get(key);
  if (inMemory) return stillGood(inMemory) ? inMemory.verdict : null;

  if (!store) store = readStore();
  const kept = store[key];
  if (!kept) return null;
  if (!stillGood(kept)) return null;
  held.set(key, kept);
  return kept.verdict;
}

const takeATurn = async (): Promise<void> => {
  if (active < AT_ONCE) {
    active += 1;
    return;
  }
  await new Promise<void>(resolve => waiting.push(resolve));
  active += 1;
};

const giveUpTurn = (): void => {
  active -= 1;
  waiting.shift()?.();
};

const ask = async (address: string, pubkey: string): Promise<Nip05Verdict> => {
  const [name, domain] = address.split('@');
  if (!name || !domain || !LOCAL_PART.test(name) || domain.includes('/')) return 'bad';

  await takeATurn();
  try {
    const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`;
    // NIP-05 says not to follow redirects: the whole point is that this
    // domain answers for this name, not that it can point somewhere else
    const answer = await fetch(url, { redirect: 'error' });
    if (!answer.ok) return 'unreachable';

    const body = await answer.json() as { names?: Record<string, string> };
    const names = body?.names;
    if (!names || typeof names !== 'object') return 'unreachable';

    // The name as written, then however it was capitalised: the spec allows
    // only lowercase, but plenty of profiles carry "Name@domain" and plenty
    // of domains list it either way
    const wanted = name.toLowerCase();
    const found = names[name]
      ?? names[wanted]
      ?? Object.entries(names).find(([listed]) => listed.toLowerCase() === wanted)?.[1];

    if (!found) return 'bad';
    return found.toLowerCase() === pubkey.toLowerCase() ? 'ok' : 'bad';
  } catch {
    // Offline, blocked by the domain's own CORS rules, redirected, or the
    // file is not JSON at all — none of which says the address is a lie
    return 'unreachable';
  } finally {
    giveUpTurn();
  }
};

/**
 * The account an address belongs to, asked of the domain itself.
 *
 * The other direction from the check above: there, an account claims an
 * address and the domain confirms it; here, only the address is known and
 * the domain says whose it is. That is what makes "seraf@razr.social" usable
 * anywhere a key would be.
 */
export async function pubkeyForNip05(address: string): Promise<string | null> {
  const [name, domain] = address.trim().replace(/^@/, '').split('@');
  if (!name || !domain || !LOCAL_PART.test(name) || domain.includes('/')) return null;

  try {
    const answer = await fetch(
      `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`,
      { redirect: 'error' }
    );
    if (!answer.ok) return null;
    const body = await answer.json() as { names?: Record<string, string> };
    const names = body?.names;
    if (!names) return null;

    const wanted = name.toLowerCase();
    const found = names[name]
      ?? names[wanted]
      ?? Object.entries(names).find(([listed]) => listed.toLowerCase() === wanted)?.[1];
    return typeof found === 'string' && /^[0-9a-f]{64}$/i.test(found) ? found.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Whether this address answers for this account. Asked once per address and
 * kept, so a feed scrolled twice does not ask a domain twice.
 */
export function verifyNip05(address: string, pubkey: string): Promise<Nip05Verdict> {
  const key = keyFor(address, pubkey);
  const known = rememberedNip05(address, pubkey);
  if (known) return Promise.resolve(known);

  const already = running.get(key);
  if (already) return already;

  const attempt = ask(address, pubkey).then(verdict => {
    remember(key, verdict);
    running.delete(key);
    return verdict;
  });
  running.set(key, attempt);
  return attempt;
}
