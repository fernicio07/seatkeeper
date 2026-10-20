import 'server-only';
import type { CheckoutResponse, Listing } from '@seatkeeper/shared';

// Server Components talk to the API directly (server-to-server), not via the
// /api rewrite — that proxy exists for the browser.
const API_URL = process.env.API_URL ?? 'http://127.0.0.1:4000';

export type Surface = 'web' | 'mobile';

export async function fetchCheckout(id: string, surface: Surface): Promise<CheckoutResponse | null> {
  // no-store: a resume must always re-validate. Caching this response would
  // reintroduce exactly the stale price/expiry bugs the server is guarding.
  const res = await fetch(`${API_URL}/checkout/${encodeURIComponent(id)}?surface=${surface}`, {
    cache: 'no-store',
  });
  if (res.status === 404) return null;
  return res.json();
}

/** 409 SEAT_UNAVAILABLE is an expected outcome, not an exception. */
export async function createCheckout(listingId: string): Promise<CheckoutResponse> {
  const res = await fetch(`${API_URL}/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ listingId }),
    cache: 'no-store',
  });
  if (!res.ok && res.status !== 409) throw new Error(`Create checkout failed: ${res.status}`);
  return res.json();
}

export async function fetchListing(id: string): Promise<{ listing: Listing; available: boolean } | null> {
  const res = await fetch(`${API_URL}/listings/${encodeURIComponent(id)}`, { cache: 'no-store' });
  return res.ok ? res.json() : null;
}

export async function resetDemo(): Promise<void> {
  await fetch(`${API_URL}/dev/reset`, { method: 'POST', cache: 'no-store' });
}
