'use client';

import { useCallback, useState } from 'react';
import type { CheckoutResponse, CheckoutSession } from '@seatkeeper/shared';
import { checkoutApi } from '@/lib/api-client';
import { formatMoney } from '@/lib/format';
import { Countdown } from './Countdown';
import { useHydrated } from './useHydrated';

interface Props {
  initialSession: CheckoutSession;
  initialServerTime: number;
}

/**
 * The interactive island. Server-rendered for first paint (props in, HTML out),
 * then hydrated. It holds a *copy* of server state and only ever replaces it
 * wholesale with what the API returns — it never computes status or price itself.
 */
export function CheckoutPanel({ initialSession, initialServerTime }: Props) {
  const [session, setSession] = useState(initialSession);
  const [serverTime, setServerTime] = useState(initialServerTime);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hydrated = useHydrated();

  const apply = useCallback((res: CheckoutResponse) => {
    if (res.session) setSession(res.session);
    setServerTime(res.serverTime);
    setError(res.error ?? null);
  }, []);

  const run = async (op: () => Promise<CheckoutResponse>) => {
    setBusy(true);
    try {
      apply(await op());
    } catch {
      setError('NETWORK_ERROR');
    } finally {
      setBusy(false);
    }
  };

  // Countdown hit zero locally → ask the server. It decides, not us.
  const refresh = useCallback(() => checkoutApi.get(session.id).then(apply), [session.id, apply]);

  // Buttons are inert until React has attached handlers. Rendering them
  // disabled (rather than clickable-but-dead) is honest about that.
  const interactive = hydrated !== null && !busy;

  return (
    <div className="panel">
      {/* TODO(step 5): price-change banner + expiry recovery UX (owned by me). */}
      <p className="price">{formatMoney(session.currentPrice)}</p>

      {session.status === 'ACTIVE' && (
        <>
          <Countdown expiresAt={session.expiresAt} serverTime={serverTime} onExpire={refresh} />
          <button
            className="primary"
            disabled={!interactive}
            onClick={() =>
              run(() =>
                checkoutApi.pay(session.id, {
                  expectedVersion: session.version,
                  acceptedPrice: session.currentPrice,
                }),
              )
            }
          >
            Continue to payment
          </button>
        </>
      )}

      {session.status === 'PENDING_PAYMENT' && (
        <>
          <p className="muted">Paying with Visa •••• 4242 (stub)</p>
          <button
            className="primary"
            disabled={!interactive}
            onClick={() =>
              run(() =>
                checkoutApi.complete(session.id, {
                  expectedVersion: session.version,
                  idempotencyKey: session.idempotencyKey,
                }),
              )
            }
          >
            Place order · {formatMoney(session.currentPrice)}
          </button>
        </>
      )}

      {session.status === 'COMPLETED' && <p className="notice success">You&apos;re going! Order confirmed.</p>}
      {session.status === 'EXPIRED' && <p className="notice">This checkout expired and the seat was released.</p>}
      {session.status === 'FAILED' && <p className="notice danger">Payment was declined.</p>}

      {error && <p className="notice danger" role="alert">{error}</p>}

      <p className={`hydration ${hydrated ? 'live' : 'pending'}`} aria-hidden>
        {!hydrated
          ? 'Server-rendered · hydrating…'
          : hydrated.ms !== null
            ? `Interactive · hydrated ${hydrated.ms}ms after navigation`
            : 'Interactive · client-side navigation'}
      </p>
    </div>
  );
}
