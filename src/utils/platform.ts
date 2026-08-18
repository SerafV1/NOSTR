/**
 * Android is where a signer app can be reached at all, so it decides whether
 * the Amber section is worth showing.
 */
export const isAndroid = (): boolean =>
  typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);
