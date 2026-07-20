/**
 * Utility functions for the NOSTR app
 */

/**
 * Format date to human-readable format
 */
export function formatDate(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'now';
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;

  return date.toLocaleDateString();
}

/**
 * Truncate text to a maximum length
 */
export function truncateText(text: string, maxLength: number = 100): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

/**
 * Format public key to short address (npub format)
 */
export function formatAddress(pubkey: string, length: number = 12): string {
  if (pubkey.startsWith('npub1')) {
    return pubkey.substring(0, length) + '...';
  }
  return pubkey.substring(0, length) + '...';
}

/**
 * Extract hashtags from content
 */
export function extractHashtags(content: string): string[] {
  const hashtagRegex = /#[\w\u0080-\uffff]+/g;
  const matches = content.match(hashtagRegex) || [];
  return matches.map(tag => tag.substring(1).toLowerCase());
}

/**
 * Extract mentions from content
 */
export function extractMentions(content: string): string[] {
  const mentionRegex = /@([\w\u0080-\uffff]+)/g;
  const mentions: string[] = [];
  let match;

  while ((match = mentionRegex.exec(content)) !== null) {
    mentions.push(match[1]);
  }

  return mentions;
}

/**
 * Format large numbers
 */
export function formatNumber(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K';
  }
  return num.toString();
}

/**
 * Get color based on pubkey
 */
export function getColorFromPubkey(pubkey: string): string {
  const colors = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A',
    '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E2'
  ];
  const index = parseInt(pubkey.substring(0, 8), 16) % colors.length;
  return colors[index];
}

/**
 * Validate URL
 */
export function isValidUrl(str: string): boolean {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy to clipboard
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Debounce function
 */
export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout>;

  return function executedFunction(...args: Parameters<T>) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };

    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}
