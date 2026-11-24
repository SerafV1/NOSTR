import { NostrCrypto } from './crypto';
import { getRelayPool } from './relay';

/**
 * The stream server's viewer count, carried to a widget that cannot ask for
 * it.
 *
 * Only the broadcaster may read that count, by signing in to the server,
 * and a signature lasts a few minutes (measured: two minutes accepted, ten
 * not). The copy of the widget inside OBS is signed out, and an extension
 * there would be a prompt every few minutes for as long as the stream ran.
 *
 * So the broadcaster's own window — the stream page, or the pop-up — passes
 * the number on as an ephemeral event, signed by a key this browser makes
 * for the purpose and keeps to itself. Signing with it asks nobody. The link
 * handed to OBS names that key, and the widget believes only it.
 */
export const VIEWER_COUNT_KIND = 25311;

const KEY_STORE = 'razr_viewer_count_key';

const counterKey = (): string | null => {
  try {
    let key = localStorage.getItem(KEY_STORE);
    if (!key) {
      key = NostrCrypto.generatePrivateKey();
      localStorage.setItem(KEY_STORE, key);
    }
    return key;
  } catch {
    return null;
  }
};

/** The key's public half, for the OBS link */
export const viewerCounterPubkey = (): string | null => {
  const key = counterKey();
  return key ? NostrCrypto.getPublicKey(key) : null;
};

/** Say the number for this stream; the widget listening takes it from here */
export async function passOnViewerCount(address: string, viewers: number): Promise<void> {
  const key = counterKey();
  if (!key) return;
  try {
    const event = NostrCrypto.signEvent(
      { kind: VIEWER_COUNT_KIND, content: '', tags: [['a', address], ['viewers', String(viewers)]] } as never,
      key
    );
    await getRelayPool().publishEvent(event);
  } catch {
    // The next number tries again
  }
}
