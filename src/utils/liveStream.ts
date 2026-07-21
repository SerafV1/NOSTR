import { nip19 } from 'nostr-tools';
import { NostrEventSigned } from '../types';

export type LiveStreamStatus = 'planned' | 'live' | 'ended';

export interface LiveStreamInfo {
  id: string;
  pubkey: string;
  dTag: string;
  title: string;
  summary: string;
  image: string;
  streamingUrl: string;
  status: LiveStreamStatus;
  starts?: number;
  currentParticipants?: number;
  hashtags: string[];
}

// NIP-53 live event (kind 30311) is addressable — parse its tags into a
// plain object once, instead of re-scanning event.tags everywhere it's used
export function parseLiveEvent(event: NostrEventSigned): LiveStreamInfo {
  const tag = (name: string) => event.tags.find(t => t[0] === name)?.[1];
  const status = tag('status');

  return {
    id: event.id,
    pubkey: event.pubkey,
    dTag: tag('d') || '',
    title: tag('title') || 'Untitled stream',
    summary: tag('summary') || '',
    image: tag('image') || '',
    streamingUrl: tag('streaming') || '',
    status: status === 'live' || status === 'planned' ? status : 'ended',
    starts: tag('starts') ? Number(tag('starts')) : undefined,
    currentParticipants: tag('current_participants') ? Number(tag('current_participants')) : undefined,
    hashtags: event.tags.filter(t => t[0] === 't').map(t => t[1])
  };
}

// Addressable events are identified by (kind, pubkey, d) rather than event
// id — an naddr is the stable, shareable reference across edits/relays
export function encodeLiveNaddr(kind: number, pubkey: string, dTag: string): string {
  return nip19.naddrEncode({ kind, pubkey, identifier: dTag });
}

export function decodeLiveNaddr(naddr: string): { kind: number; pubkey: string; identifier: string } | null {
  try {
    const decoded = nip19.decode(naddr);
    if (decoded.type !== 'naddr') return null;
    const { kind, pubkey, identifier } = decoded.data as { kind: number; pubkey: string; identifier: string };
    return { kind, pubkey, identifier };
  } catch {
    return null;
  }
}
