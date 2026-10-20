'use server';

import { redirect } from 'next/navigation';
import { createCheckout } from '@/lib/api-server';

// Fixed map, not a path taken from the form: a client-supplied redirect
// target would be an open redirect.
const SURFACE_PATHS = { web: '/checkout', mobile: '/mobile/checkout' } as const;

// A Server Action: the <form> posts here even before (or without) client JS.
// The session is created server-side and the browser only ever learns its id.
// Used both to start and to restart (expiry/decline recovery) — a restart is
// just a brand-new session for the same listing, at today's price, landing on
// the same surface the fan is already using.
export async function startCheckout(formData: FormData) {
  const listingId = String(formData.get('listingId') ?? '');
  const surface = formData.get('surface') === 'mobile' ? 'mobile' : 'web';
  const { session } = await createCheckout(listingId);
  if (!session) throw new Error('No session returned');
  redirect(`${SURFACE_PATHS[surface]}/${session.id}`);
}
