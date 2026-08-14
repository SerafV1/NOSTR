/**
 * Shown when no contact list turns up anywhere before a follow. Creating one
 * is correct for a new account and destructive for an existing one — kind 3
 * is replaceable, so a fresh list replaces whatever the relays hold — and
 * only the person clicking knows which case this is.
 */
export const NO_CONTACT_LIST_PROMPT =
  'No follow list was found on your relays.\n\n' +
  'If this account is new, that is expected — continue.\n\n' +
  'If you already follow people, your relays just failed to hand the list over, ' +
  'and continuing would REPLACE it with a list containing only this one account. ' +
  'Cancel, check your relay connections, and try again.\n\n' +
  'Create a new follow list?';
