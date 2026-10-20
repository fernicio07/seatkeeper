import type { CheckoutResponse } from '@seatkeeper/shared';

type Surface = 'web' | 'mobile';

// Browser-side calls go through Next's same-origin /api rewrite.
async function call(path: string, body?: unknown): Promise<CheckoutResponse> {
  const res = await fetch(`/api${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  // Error responses still carry { session, serverTime } — callers re-render from them.
  return res.json();
}

export const checkoutApi = {
  /** reason=revalidate: focus/countdown refreshes — not counted as a resume. */
  get: (id: string, surface: Surface, reason: 'open' | 'revalidate') =>
    call(`/checkout/${id}?surface=${surface}&reason=${reason}`),
  pay: (id: string, body: { expectedVersion: number; acceptedPrice: number }) =>
    call(`/checkout/${id}/pay`, body),
  complete: (id: string, body: { expectedVersion: number; idempotencyKey: string; acceptedPrice: number }) =>
    call(`/checkout/${id}/complete`, body),
};

export type ClientEvent = 'price_banner_shown' | 'price_banner_acknowledged';

/**
 * Fire-and-forget. keepalive lets the request outlive a navigation (e.g. the
 * fan acknowledges and immediately leaves); failures are swallowed because
 * analytics must never affect checkout.
 */
export function trackEvent(
  name: ClientEvent,
  sessionId: string,
  surface: Surface,
  props?: Record<string, unknown>,
): void {
  void fetch('/api/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, sessionId, surface, props }),
    keepalive: true,
  }).catch(() => {});
}
