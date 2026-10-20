'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { deriveCheckoutView, type CheckoutResponse, type CheckoutSession } from '@seatkeeper/shared';
import { checkoutApi } from '@/lib/api-client';
import { formatMoney } from '@/lib/format';
import { Countdown } from './Countdown';
import { PriceChangeBanner } from './PriceChangeBanner';
import { RestartCheckout } from './RestartCheckout';
import { useAcceptedPrice } from '@/lib/useAcceptedPrice';
import { useHydrated } from './useHydrated';

interface Props {
  initialSession: CheckoutSession;
  initialServerTime: number;
  surface: 'web' | 'mobile';
}

/**
 * The interactive island. Server-rendered for first paint (props in, HTML out),
 * then hydrated. It holds a *copy* of server state and only ever replaces it
 * wholesale with what the API returns — it never computes status or price itself.
 *
 * Render-from-state: what's on screen is deriveCheckoutView(session,
 * acceptedPrice). Error codes are only a transient message; a 409 still carries
 * the fresh session, and re-deriving from it shows the right screen.
 */
export function CheckoutPanel({ initialSession, initialServerTime, surface }: Props) {
  const [session, setSession] = useState(initialSession);
  const [serverTime, setServerTime] = useState(initialServerTime);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Local countdown reached zero; the server hasn't confirmed yet.
  const [confirming, setConfirming] = useState(false);
  // This surface's own complete call came back as an idempotent replay:
  // the order was already placed (by the other surface).
  const [alreadyPurchased, setAlreadyPurchased] = useState(false);
  const hydrated = useHydrated();
  const { acceptedPrice, acknowledge } = useAcceptedPrice(session.priceAtStart);
  const view = deriveCheckoutView(session, acceptedPrice);

  const apply = useCallback((res: CheckoutResponse) => {
    if (res.session) setSession(res.session);
    setServerTime(res.serverTime);
    setError(res.error ?? null);
    setConfirming(false);
  }, []);

  const run = async (op: () => Promise<CheckoutResponse>) => {
    setBusy(true);
    try {
      const res = await op();
      apply(res);
      return res;
    } catch {
      setError('NETWORK_ERROR');
    } finally {
      setBusy(false);
    }
  };

  // Countdown hit zero locally → ask the server. It decides, not us.
  // Concurrent triggers share one in-flight request: returning to a tab fires
  // both `visibilitychange` and `focus`, which would otherwise double-fetch.
  const inFlight = useRef<Promise<void> | null>(null);
  const refresh = useCallback(() => {
    inFlight.current ??= checkoutApi
      .get(session.id, surface)
      .then(apply)
      .catch(() => setError('NETWORK_ERROR'))
      .finally(() => {
        inFlight.current = null;
      });
    return inFlight.current;
  }, [session.id, surface, apply]);

  // Re-validate whenever this surface becomes active again. While it was in
  // the background the other surface may have paid, completed, or the price
  // may have moved — its local copy can't be trusted.
  useEffect(() => {
    const onActive = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('focus', onActive);
    document.addEventListener('visibilitychange', onActive);
    return () => {
      window.removeEventListener('focus', onActive);
      document.removeEventListener('visibilitychange', onActive);
    };
  }, [refresh]);

  // Buttons are inert until React has attached handlers. Rendering them
  // disabled (rather than clickable-but-dead) is honest about that.
  const interactive = hydrated !== null && !busy;

  return (
    <div className="panel" data-surface={surface}>
      {/* While the banner is up, it owns price communication. */}
      {view.kind !== 'PRICE_CHANGED' && <p className="price">{formatMoney(session.currentPrice)}</p>}

      {/* Only while the hold can actually expire. PRICE_CHANGED can now also be a
          PENDING_PAYMENT session, whose hold is frozen — no countdown there. */}
      {session.status === 'ACTIVE' &&
        (confirming ? (
          <p className="confirming" role="status">Confirming your hold…</p>
        ) : (
          // Keeps ticking under the banner: the hold really is still running.
          <Countdown
            expiresAt={session.expiresAt}
            serverTime={serverTime}
            onExpire={() => {
              setConfirming(true);
              void refresh();
            }}
          />
        ))}

      {view.kind === 'PRICE_CHANGED' && (
        <PriceChangeBanner
          fromPrice={view.fromPrice}
          toPrice={view.toPrice}
          onAcknowledge={acknowledge}
          disabled={!interactive}
          sessionId={session.id}
          surface={surface}
        />
      )}

      {view.kind === 'READY' && (
        <button
          className="primary"
          disabled={!interactive || confirming}
          onClick={() =>
            run(() =>
              checkoutApi.pay(session.id, {
                expectedVersion: session.version,
                acceptedPrice, // what the fan agreed to — never session.currentPrice
              }),
            )
          }
        >
          {busy ? 'Holding your price…' : 'Continue to payment'}
        </button>
      )}

      {view.kind === 'PENDING_PAYMENT' && (
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
                  acceptedPrice,
                }),
              ).then((res) => {
                if (res?.replayed && res.session?.status === 'COMPLETED') setAlreadyPurchased(true);
              })
            }
          >
            {busy ? 'Placing order…' : `Place order · ${formatMoney(session.currentPrice)}`}
          </button>
        </>
      )}

      {view.kind === 'COMPLETED' && (
        <div className="notice success">
          <h3>{alreadyPurchased ? 'Already purchased' : "You're going! Order confirmed."}</h3>
          {alreadyPurchased && <p>This order was already placed from another device. You were charged once.</p>}
          {/* Same id on every surface: the visible proof there is exactly one order. */}
          <p className="order-id">Order {session.orderId ?? '—'}</p>
        </div>
      )}

      {view.kind === 'EXPIRED' && (
        <RestartCheckout
          listingId={session.listingId}
          surface={surface}
          tone="neutral"
          title="Your hold on this seat ended"
          body="Holds are temporary so seats stay available to every fan. The seat may still be available, at today's price."
        />
      )}

      {view.kind === 'FAILED' && (
        <RestartCheckout
          listingId={session.listingId}
          surface={surface}
          tone="danger"
          title="Payment was declined"
          body="You weren't charged. Start a new checkout to try again."
        />
      )}

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
