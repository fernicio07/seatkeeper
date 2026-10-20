import type { CheckoutResponse } from '@seatkeeper/shared';

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
  get: (id: string) => call(`/checkout/${id}`),
  pay: (id: string, body: { expectedVersion: number; acceptedPrice: number }) =>
    call(`/checkout/${id}/pay`, body),
  complete: (id: string, body: { expectedVersion: number; idempotencyKey: string; acceptedPrice: number }) =>
    call(`/checkout/${id}/complete`, body),
};
