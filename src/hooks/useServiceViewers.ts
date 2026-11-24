import { useEffect, useState } from 'react';
import { NostrCore } from '../nostr/core';
import { CredentialManager } from '../nostr/crypto';

/** NIP-98: an HTTP request signed for, here the opening of a socket */
const HTTP_AUTH_KIND = 27235;

/**
 * How many are watching, as the stream's own server counts them — for the
 * broadcaster only.
 *
 * A service built on zap-stream-core (zap.stream, streamstr) knows exactly
 * how many players are pulling the stream, and tells the owner over a socket
 * at `<service>/ws`; zap.stream's dashboard shows that number. What it puts
 * in the public event is something else: streamstr published
 * `current_participants: 0` while its own socket said six were watching.
 * Nobody but the owner may ask ("you can only access your own streams"), so
 * this opens only on the broadcaster's own stream, signs once for it, and
 * gives up quietly anywhere the service speaks no such thing.
 */
export function useServiceViewers(
  service: string | undefined,
  streamId: string | undefined,
  owners: string[],
  live: boolean,
  /**
   * Wait this long for another window of this browser to pass the number
   * on before opening a socket of its own. The viewers pop-up is opened from
   * the stream page, which already has one: a second would be a second
   * signature, and through an extension a second prompt.
   */
  waitForOthersMs = 0
): number | null {
  const [viewers, setViewers] = useState<number | null>(null);
  const me = CredentialManager.getPublicKey();
  const mine = !!me && owners.includes(me);

  useEffect(() => {
    setViewers(null);
    if (!service || !streamId || !mine || !live || !CredentialManager.canSign()) return;
    if (!/^https?:\/\//.test(service)) return;

    const wsUrl = `${service.replace(/^http/, 'ws').replace(/\/$/, '')}/ws`;
    let dropped = false;
    let heard = false;
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(`razr-server-viewers-${streamId}`);
      channel.onmessage = event => {
        if (typeof event.data === 'number' && !dropped) {
          heard = true;
          setViewers(event.data);
        }
      };
    } catch {
      // No channel: every window asks for itself
    }
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // Each connection is a signature, and through an extension a signature
    // is a prompt: a few reconnects, then it is left alone
    let attempts = 0;

    const connect = () => {
      if (dropped || attempts >= 3) return;
      attempts += 1;
      try {
        socket = new WebSocket(wsUrl);
      } catch {
        return;
      }
      socket.onopen = async () => {
        try {
          const token = await NostrCore.signAnyMode({
            kind: HTTP_AUTH_KIND,
            content: '',
            tags: [['u', wsUrl], ['method', 'GET']]
          });
          socket?.send(JSON.stringify({ type: 'Auth', data: { token: btoa(JSON.stringify(token)) } }));
        } catch {
          socket?.close();
        }
      };
      socket.onmessage = message => {
        try {
          const data = JSON.parse(String(message.data));
          if (data.type === 'AuthResponse' && data.data?.success) {
            attempts = 0;
            socket?.send(JSON.stringify({ type: 'SubscribeStream', data: { stream_id: streamId } }));
          } else if (data.type === 'StreamMetrics' && typeof data.data?.viewers === 'number') {
            if (!dropped) {
              setViewers(data.data.viewers);
              channel?.postMessage(data.data.viewers);
            }
          } else if (data.type === 'Error') {
            // Not ours after all, or not this kind of service: stop asking
            attempts = 3;
            socket?.close();
          }
        } catch {
          // Not a message this understands
        }
      };
      socket.onclose = () => {
        if (!dropped) retry = setTimeout(connect, 10000);
      };
      socket.onerror = () => { /* onclose follows */ };
    };

    const start = setTimeout(() => { if (!heard) connect(); }, waitForOthersMs);
    return () => {
      dropped = true;
      clearTimeout(start);
      channel?.close();
      clearTimeout(retry);
      socket?.close();
    };
  }, [service, streamId, mine, live]);

  return viewers;
}
