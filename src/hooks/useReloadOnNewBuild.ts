import { useEffect } from 'react';

/**
 * Pick up a new version of the app without anybody pressing anything.
 *
 * A widget page is opened once and left running: OBS loads it when the
 * scene starts and never reloads it, so it keeps running whatever code it
 * was given that day. A fix shipped in the afternoon reached everybody on
 * the website and nobody in a stream overlay — which is exactly how a zap
 * that had been fixed went on missing from a broadcaster's chat.
 *
 * So the page asks, now and then, which bundle the server is handing out.
 * The built page names its own in a <script src="/assets/index-<hash>.js">,
 * and the hash changes with every build; a different one means what is on
 * screen is out of date.
 */
const BUNDLE = /assets\/index-[A-Za-z0-9_-]+\.js/;

/** Rare enough to cost nothing, often enough that a fix lands the same hour */
const CHECK_EVERY_MS = 5 * 60 * 1000;

/** Nothing is reloaded in the first minutes: a page that has just started is current */
const SETTLE_MS = 2 * 60 * 1000;

/**
 * A guard against reloading in a circle. If the server is handing out one
 * bundle while the page keeps starting up on another — a CDN mid-rollout,
 * say — this reloads once and then leaves it alone.
 */
const RELOADED_AT = 'razr_reloaded_for_build';
const RELOAD_NO_MORE_THAN_EVERY_MS = 30 * 60 * 1000;

/** What this page is running, as the page itself declares it */
const runningBundle = (): string | null => {
  for (const script of Array.from(document.querySelectorAll('script[src]'))) {
    const found = (script.getAttribute('src') || '').match(BUNDLE);
    if (found) return found[0];
  }
  return null;
};

const recently = (key: string, within: number): boolean => {
  try {
    const at = Number(sessionStorage.getItem(key) || 0);
    return at > 0 && Date.now() - at < within;
  } catch {
    return false;
  }
};

export function useReloadOnNewBuild(enabled: boolean = true): void {
  useEffect(() => {
    if (!enabled) return;
    // A development page has no hashed bundle to compare, and nothing to
    // gain: vite replaces what changes while it is open
    const running = runningBundle();
    if (!running) return;

    let dropped = false;

    const look = async () => {
      if (dropped) return;
      if (recently(RELOADED_AT, RELOAD_NO_MORE_THAN_EVERY_MS)) return;
      try {
        const answer = await fetch(`${window.location.origin}/`, { cache: 'no-store' });
        if (!answer.ok) return;
        const served = (await answer.text()).match(BUNDLE)?.[0];
        if (dropped || !served || served === running) return;
        try { sessionStorage.setItem(RELOADED_AT, String(Date.now())); } catch {
          // A browser that will not remember simply checks again later
        }
        window.location.reload();
      } catch {
        // Offline, or the page is being served from somewhere that will not
        // answer: there is nothing to do but ask again next time
      }
    };

    const start = setTimeout(() => {
      void look();
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      timer = setInterval(look, CHECK_EVERY_MS);
    }, SETTLE_MS);
    let timer: ReturnType<typeof setInterval> | undefined;

    return () => {
      dropped = true;
      clearTimeout(start);
      if (timer) clearInterval(timer);
    };
  }, [enabled]);
}
