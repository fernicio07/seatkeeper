'use client';

import { useEffect, useId, useRef } from 'react';
import { formatMoney } from '@/lib/format';

interface Props {
  fromPrice: number;
  toPrice: number;
  /** Called with the exact price printed on the button the fan pressed. */
  onAcknowledge: (shownPrice: number) => void;
  disabled?: boolean;
}

/**
 * Rendered INSTEAD of the pay button, so blocking is structural: there is no
 * pay control to reach until the fan consents. Focus moves here on mount so
 * keyboard and screen-reader users land on it (a labelled region + focus is
 * announced once; role="alert" on top would announce it twice).
 */
export function PriceChangeBanner({ fromPrice, toPrice, onAcknowledge, disabled }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const headingId = useId();
  useEffect(() => ref.current?.focus(), [fromPrice, toPrice]);

  const isDrop = toPrice < fromPrice;
  const diff = Math.abs(toPrice - fromPrice);

  return (
    <div ref={ref} className="notice warn price-change" role="region" aria-labelledby={headingId} tabIndex={-1}>
      <h3 id={headingId}>{isDrop ? 'Good news: the price dropped' : 'The price of this seat changed'}</h3>
      <p>
        <del>{formatMoney(fromPrice)}</del> → <strong>{formatMoney(toPrice)}</strong>{' '}
        <span className="muted">({isDrop ? '−' : '+'}{formatMoney(diff)})</span>
      </p>
      {/* The amount is IN the button: pressing it is consent to that number. */}
      <button type="button" className="primary" disabled={disabled} onClick={() => onAcknowledge(toPrice)}>
        Continue at {formatMoney(toPrice)}
      </button>
      <a className="text-link" href="/">Find other seats</a>
    </div>
  );
}
