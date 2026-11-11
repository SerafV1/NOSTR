import { useEffect } from 'react';

/** The name the site goes by, after a page's own title */
const SITE = 'RAZR';

/**
 * The title of the site itself, used by the page a visitor lands on. The
 * bare name says nothing to someone who has never heard it, and the title
 * is the line a search result is headed with.
 */
const SITE_TITLE = 'RAZR — a nostr client for notes, live streams and zaps';

/** What the site is, for any page with nothing more particular to say */
export const SITE_DESCRIPTION =
  'RAZR is a nostr client for the open social web: read and write notes, '
  + 'follow people across relays, watch live streams with chat and zaps, '
  + 'and send encrypted messages. No account, no email — your own key.';

export interface PageMeta {
  /**
   * The page's own title, without the site name — a person's name, a
   * stream's title. Left out while the page is still loading, which keeps
   * the tab from flickering through a placeholder.
   */
  title?: string;
  /** A sentence or two about this page in particular */
  description?: string;
  /**
   * Keep this page out of search results. For anything that is the
   * reader's own (messages, settings, notifications), a search page whose
   * address is a query someone typed, and the popped-out widgets, which
   * are a window of a page rather than a page.
   */
  noindex?: boolean;
}

/** One line, collapsed and cut to what a result actually shows */
const sentence = (text: string | undefined, limit = 300): string | undefined => {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
};

const tag = (
  selector: string,
  make: () => HTMLElement,
): HTMLElement => {
  const found = document.head.querySelector(selector);
  if (found) return found as HTMLElement;
  const fresh = make();
  document.head.appendChild(fresh);
  return fresh;
};

const named = (name: string, content: string): void => {
  const el = tag(`meta[name="${name}"]`, () => {
    const meta = document.createElement('meta');
    meta.setAttribute('name', name);
    return meta;
  });
  el.setAttribute('content', content);
};

const property = (property: string, content: string): void => {
  const el = tag(`meta[property="${property}"]`, () => {
    const meta = document.createElement('meta');
    meta.setAttribute('property', property);
    return meta;
  });
  el.setAttribute('content', content);
};

/**
 * A title, a description and a canonical address for the page being looked
 * at, written into the document as it is rendered.
 *
 * Everything here is one page as far as a server is concerned — every
 * address is answered with the same index.html — so without this, every
 * address a crawler asks for comes back with the same title and the same
 * four-word description, and a search engine files them all as one page
 * duplicated a thousand times. Google does run the scripts and reads the
 * title it finds afterwards, so writing it here is enough for search.
 *
 * It is not enough for a link preview: the crawlers behind those (the ones
 * that draw a card when a link is pasted into a chat) do not run scripts,
 * and see only what index.html already says. That needs the server's help.
 */
export const usePageMeta = (meta: PageMeta): void => {
  const { title, description, noindex } = meta;
  const line = sentence(description);

  useEffect(() => {
    const full = title ? `${title} · ${SITE}` : SITE_TITLE;
    document.title = full;

    const text = line || SITE_DESCRIPTION;
    named('description', text);
    property('og:title', full);
    property('og:description', text);

    // The address without its query or its fragment: the same page reached
    // with a tracking parameter on the end is not a second page, and saying
    // so keeps the two from competing with each other
    const canonicalHref = `${window.location.origin}${window.location.pathname}`;
    const canonical = tag('link[rel="canonical"]', () => {
      const link = document.createElement('link');
      link.setAttribute('rel', 'canonical');
      return link;
    });
    canonical.setAttribute('href', canonicalHref);
    property('og:url', canonicalHref);

    named('robots', noindex ? 'noindex, nofollow' : 'index, follow');
  }, [title, line, noindex]);
};

export default usePageMeta;
