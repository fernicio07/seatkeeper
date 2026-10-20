import { notFound } from 'next/navigation';
import { EventHeader } from '@/components/EventHeader';
import { CheckoutPanel } from '@/components/CheckoutPanel';
import { HandoffLink } from '@/components/HandoffLink';
import { fetchCheckout } from '@/lib/api-server';

// The SSR half of the checkout screen. This runs on the Next server for every
// request: it resumes the session (the API re-validates expiry/price/hold) and
// renders event, seat, price and the starting countdown into the HTML. The
// fan sees a complete, correct screen before any JavaScript has run.
export default async function CheckoutPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ embed?: string }>;
}) {
  const { id } = await params;
  const embedded = (await searchParams).embed === '1';
  const data = await fetchCheckout(id);
  if (!data?.session || !data.listing) notFound();

  return (
    <main className="shell">
      <section className="card">
        <EventHeader listing={data.listing} />
        {/* Client island: also server-rendered for first paint, then hydrated. */}
        <CheckoutPanel initialSession={data.session} initialServerTime={data.serverTime} surface="web" />
        {!embedded && <HandoffLink sessionId={data.session.id} />}
      </section>
    </main>
  );
}
