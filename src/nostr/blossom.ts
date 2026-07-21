import { NostrEvent, NostrEventSigned, EVENT_KINDS } from '../types';
import { NostrCrypto, CredentialManager, ExtensionManager } from './crypto';
import { loadBlossomServers } from '../utils/blossomServers';

export interface BlobDescriptor {
  url: string;
  sha256: string;
  size: number;
  type?: string;
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// BUD-02 upload authorization: a kind 24242 event signed just for this
// blob's hash, short-lived (5 min) so a leaked header can't be replayed later
async function signUploadAuth(sha256: string): Promise<NostrEventSigned> {
  const isExtension = CredentialManager.isExtensionMode();
  const tags = [
    ['t', 'upload'],
    ['x', sha256],
    ['expiration', String(Math.floor(Date.now() / 1000) + 300)]
  ];

  if (isExtension) {
    const eventTemplate = {
      kind: EVENT_KINDS.BLOSSOM_AUTH,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: 'Upload blob'
    };
    const signed = await ExtensionManager.signEvent(eventTemplate);
    if (!signed || !(signed as any).id || !(signed as any).sig) {
      throw new Error('Extension did not sign the upload authorization');
    }
    return signed as NostrEventSigned;
  }

  const privkey = CredentialManager.getPrivateKey();
  if (!privkey) throw new Error('Private key not found');
  const event: NostrEvent = {
    kind: EVENT_KINDS.BLOSSOM_AUTH,
    content: 'Upload blob',
    tags
  };
  return NostrCrypto.signEvent(event, privkey);
}

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
}
