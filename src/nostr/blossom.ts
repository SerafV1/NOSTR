import { NostrEvent, NostrEventSigned, EVENT_KINDS } from '../types';
import { NostrCrypto, CredentialManager, ExtensionManager } from './crypto';
import { loadBlossomServers } from '../utils/blossomServers';

export interface BlobDescriptor {
  url: string;
  sha256: string;
  size: number;
  type?: string;
}

/** One blob as a server lists it, and every server found holding it */
export interface StoredBlob extends BlobDescriptor {
  /** Seconds, as the server records it */
  uploaded?: number;
  servers: string[];
}

export interface ServerFailure {
  server: string;
  reason: string;
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * BUD-01 authorization: a kind 24242 event signed for one action, short
 * lived (5 min) so a leaked header cannot be replayed later. Upload names
 * the blob it is for; listing names nothing but the verb.
 */
async function signBlossomAuth(
  verb: 'upload' | 'list',
  extra: string[][] = []
): Promise<NostrEventSigned> {
  const isExtension = CredentialManager.isExtensionMode();
  const tags = [
    ['t', verb],
    ...extra,
    ['expiration', String(Math.floor(Date.now() / 1000) + 300)]
  ];
  const content = verb === 'upload' ? 'Upload blob' : 'List blobs';

  if (isExtension) {
    const eventTemplate = {
      kind: EVENT_KINDS.BLOSSOM_AUTH,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content
    };
    const signed = await ExtensionManager.signEvent(eventTemplate);
    if (!signed || !(signed as any).id || !(signed as any).sig) {
      throw new Error('Extension did not sign the authorization');
    }
    return signed as NostrEventSigned;
  }

  const privkey = CredentialManager.getPrivateKey();
  if (!privkey) throw new Error('Private key not found');
  const event: NostrEvent = { kind: EVENT_KINDS.BLOSSOM_AUTH, content, tags };
  return NostrCrypto.signEvent(event, privkey);
}

const signUploadAuth = (sha256: string) => signBlossomAuth('upload', [['x', sha256]]);

function toAuthHeader(signed: NostrEventSigned): string {
  const json = JSON.stringify(signed);
  // btoa only handles Latin1 — round-trip through encodeURIComponent for UTF-8 safety
  return `Nostr ${btoa(unescape(encodeURIComponent(json)))}`;
}

function putToServer(
  server: string,
  buffer: ArrayBuffer,
  contentType: string,
  authHeader: string,
  onProgress?: (pct: number) => void
): Promise<BlobDescriptor> {
  // XMLHttpRequest instead of fetch — it's the only way to get upload
  // progress events for the progress bar
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${server.replace(/\/$/, '')}/upload`);
    xhr.setRequestHeader('Authorization', authHeader);
    if (contentType) xhr.setRequestHeader('Content-Type', contentType);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText);
          resolve({ url: data.url, sha256: data.sha256, size: data.size, type: data.type });
        } catch {
          reject(new Error(`${server} returned an invalid response`));
        }
      } else {
        reject(new Error(`${server} rejected the upload (HTTP ${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error(`Network error uploading to ${server}`));
    xhr.send(buffer);
  });
}

export class BlossomClient {
  /**
   * Uploads a file to the user's configured media servers (Settings →
   * Media Servers). Pass `targetServer` to upload to one specific server
   * only (no fallback); otherwise every enabled server is tried in order
   * until one accepts the blob.
   */
  static async uploadFile(
    file: File,
    targetServer?: string,
    onProgress?: (pct: number) => void
  ): Promise<BlobDescriptor> {
    const buffer = await file.arrayBuffer();
    const hash = await sha256Hex(buffer);
    const signed = await signUploadAuth(hash);
    const authHeader = toAuthHeader(signed);

    const servers = targetServer
      ? [targetServer]
      : loadBlossomServers().filter(s => s.enabled).map(s => s.url);

    if (servers.length === 0) {
      throw new Error('No media server configured — add one in Settings → Media Servers');
    }

    let lastError: unknown = null;
    for (const server of servers) {
      try {
        return await putToServer(server, buffer, file.type, authHeader, onProgress);
      } catch (error) {
        console.warn(`[Blossom] Upload to ${server} failed:`, error);
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error('All media servers rejected the upload');
  }

  /**
   * Everything the configured servers hold for this account (BUD-02
   * `GET /list/<pubkey>`).
   *
   * A blob commonly sits on more than one server — an upload is offered to
   * each in turn — so they are merged by their hash, which is what names a
   * blob at all, and each one remembers where it was found.
   *
   * The endpoint is public in the spec, so it is asked plainly first and
   * only signed for when that is refused — a reader is not made to sign for
   * a list nobody was guarding. What "refused" looks like varies: measured,
   * nostr.download answers 401 and blossom.primal.net answers 400 with
   * "missing auth event", so any refusal is worth one signed retry.
   */
  static async list(pubkey: string): Promise<{ blobs: StoredBlob[]; failed: ServerFailure[] }> {
    const servers = loadBlossomServers().filter(s => s.enabled).map(s => s.url);
    const failed: ServerFailure[] = [];
    const byHash = new Map<string, StoredBlob>();

    const ask = async (server: string) => {
      const url = `${server.replace(/\/$/, '')}/list/${pubkey}`;
      let answer = await fetch(url);
      if (!answer.ok) {
        const auth = toAuthHeader(await signBlossomAuth('list'));
        answer = await fetch(url, { headers: { Authorization: auth } });
      }
      if (!answer.ok) throw new Error(`HTTP ${answer.status}`);
      const held = await answer.json();
      if (!Array.isArray(held)) throw new Error('answered with something other than a list');

      for (const blob of held) {
        if (!blob?.sha256) continue;
        const already = byHash.get(blob.sha256);
        if (already) {
          if (!already.servers.includes(server)) already.servers.push(server);
          continue;
        }
        byHash.set(blob.sha256, {
          sha256: blob.sha256,
          url: blob.url || `${server.replace(/\/$/, '')}/${blob.sha256}`,
          size: Number(blob.size) || 0,
          type: blob.type,
          uploaded: Number(blob.uploaded) || undefined,
          servers: [server]
        });
      }
    };

    await Promise.all(servers.map(server =>
      ask(server).catch(error => {
        failed.push({ server, reason: error instanceof Error ? error.message : String(error) });
      })
    ));

    const blobs = [...byHash.values()].sort((a, b) => (b.uploaded || 0) - (a.uploaded || 0));
    return { blobs, failed };
  }
}
