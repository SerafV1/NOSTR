import React, { useEffect, useState } from 'react';
import { fetchGroup } from '../nostr/groups';

interface GroupRefProps {
  /** The relay that holds the group — half of a NIP-29 group's name */
  relay: string;
  /** The group's `d` tag, which is the other half */
  id: string;
  /** Where a click leads, worked out by whoever drew this */
  path: string;
}

/** What has already been looked up, so a page of invitations asks once each */
const known = new Map<string, string>();

/**
 * An invitation to a group, drawn as the group.
 *
 * The address says which relay and which group, and nothing else — so the
 * chip said "Group", which is true of every group there has ever been. The
 * relay is asked what it is called, and until it answers the id stands in,
 * because a name that arrives late is better than a link that says nothing.
 */
const GroupRef: React.FC<GroupRefProps> = ({ relay, id, path }) => {
  const at = `${relay}'${id}`;
  const [name, setName] = useState<string>(() => known.get(at) || '');

  useEffect(() => {
    if (known.has(at)) return;
    let dropped = false;

    fetchGroup({ relay, id })
      .then(group => {
        const called = group?.name?.trim();
        if (!called) return;
        known.set(at, called);
        if (!dropped) setName(called);
      })
      .catch(() => {
        // A relay that will not say is not an error worth showing: the
        // invitation still opens
      });

    return () => { dropped = true; };
  }, [at, relay, id]);

  return (
    <a
      className="mention-link"
      href={path}
      title={at}
      onClick={(e) => e.stopPropagation()}
    >
      👥 {name || id}
    </a>
  );
};

export default GroupRef;
