'use client';

import { useEffect, useRef, useState } from 'react';
import { formatRemaining } from '@/lib/format';

interface Props {
  expiresAt: number;
  serverTime: number; // API clock when this session snapshot was produced
  onExpire?: () => void;
}

/**
 * Hydration-safe countdown.
 *
 * 1. First render (server AND client hydration) uses only props:
 *    expiresAt - serverTime. Both sides compute the same string, so there's no
 *    mismatch. Reading Date.now() during render would differ between the
 *    server render and hydration a few hundred ms later.
 * 2. Ticking starts in useEffect (client only). We anchor to the API's clock,
 *    not the browser's: deadline = localNow + (expiresAt - serverTime). The
 *    fan's laptop clock can be minutes off; this only depends on elapsed time.
 *    Residual error ≈ time between the API response and hydration, and it errs
 *    generous. The countdown is advisory; the server enforces expiry.
 */
export function Countdown({ expiresAt, serverTime, onExpire }: Props) {
  const [remaining, setRemaining] = useState(Math.max(0, expiresAt - serverTime));
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  useEffect(() => {
    const deadline = Date.now() + (expiresAt - serverTime);
    let fired = false;
    const tick = () => {
      const r = Math.max(0, deadline - Date.now());
      setRemaining(r);
      if (r === 0 && !fired) {
        fired = true;
        onExpireRef.current?.();
      }
    };
    tick();
    const handle = setInterval(tick, 250);
    return () => clearInterval(handle);
  }, [expiresAt, serverTime]);

  const urgent = remaining <= 60_000;
  return (
    // role=timer is implicitly aria-live="off": announcing every second would
    // drown a screen reader. The label gives context when it's focused/read.
    <p className={`countdown${urgent ? ' urgent' : ''}`} role="timer" aria-label="Time left to complete checkout">
      Seat held for <strong>{formatRemaining(remaining)}</strong>
    </p>
  );
}
