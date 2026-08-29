import React, { useEffect, useState } from 'react';
import { Nip05Verdict, rememberedNip05, verifyNip05 } from '../utils/nip05';

interface Nip05HandleProps {
  /** The address as the account writes it — "seraf@razr.social" */
  nip05: string;
  /** The account claiming it, which the domain has to name back */
  pubkey: string;
  className?: string;
  /** Draw the address itself, or only the mark beside something else */
  markOnly?: boolean;
}

/**
 * An address with the domain's own answer beside it.
 *
 * A tick where the domain names this account, a warning where it names a
 * different one — that is someone else's address being worn — and a quiet
 * dash where the domain could not be reached at all, which says nothing
 * about the address either way and must not look like an accusation.
 *
 * The answer is remembered for a day, so a feed read twice asks nobody
 * twice, and nothing is asked until an address is actually on screen.
 */
const Nip05Handle: React.FC<Nip05HandleProps> = ({ nip05, pubkey, className, markOnly }) => {
  const [verdict, setVerdict] = useState<Nip05Verdict | null>(
    () => rememberedNip05(nip05, pubkey)
  );

  useEffect(() => {
    // What is already known needs no request at all
    const known = rememberedNip05(nip05, pubkey);
    if (known) {
      setVerdict(known);
      return;
    }

    let cancelled = false;
    setVerdict(null);
    void verifyNip05(nip05, pubkey).then(answer => {
      if (!cancelled) setVerdict(answer);
    });
    return () => { cancelled = true; };
  }, [nip05, pubkey]);

  // NIP-05 uses "_" for the domain itself, which reads as "_@razr.social"
  // everywhere it is printed. It means razr.social.
  const shown = nip05.startsWith('_@') ? nip05.slice(2) : nip05;

  const mark = verdict === 'ok' ? (
    <span className="nip05-mark ok" title={`${shown} answers for this account`}>✓</span>
  ) : verdict === 'bad' ? (
    <span
      className="nip05-mark bad"
      title={`${shown} does not answer for this account — the domain names somebody else, or nobody`}
    >
      ⚠
    </span>
  ) : verdict === 'unreachable' ? (
    <span
      className="nip05-mark unknown"
      title={`${shown} could not be checked — the domain did not answer, or does not allow it to be read from here`}
    >
      ?
    </span>
  ) : null;

  if (markOnly) return mark;

  return (
    <span className={['nip05-handle', className].filter(Boolean).join(' ')}>
      {shown}
      {mark}
    </span>
  );
};

export default Nip05Handle;
