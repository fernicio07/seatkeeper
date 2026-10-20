'use server';

import { redirect } from 'next/navigation';
import { createCheckout } from '@/lib/api-server';

// A Server Action: the <form> posts here even before (or without) client JS.
// The session is created server-side and the browser only ever learns its id.
export async function startCheckout(formData: FormData) {
  const listingId = String(formData.get('listingId') ?? '');
  const { session } = await createCheckout(listingId);
  if (!session) throw new Error('No session returned');
  redirect(`/checkout/${session.id}`);
}
