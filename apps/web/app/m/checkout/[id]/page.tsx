import { notFound } from 'next/navigation';
import { EventHeader } from '@/components/EventHeader';
import { CheckoutPanel } from '@/components/CheckoutPanel';
import { fetchCheckout } from '@/lib/api-server';

// The simulated mobile surface. Deliberately shares NO client state with web:
// it receives a bare session id (the "deep link") and resumes from the server,
// exactly like a native app opening a universal link would.
export default async function MobileCheckoutPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await fetchCheckout(id);
  if (!data?.session || !data.listing) notFound();

  return (
    <main className="phone-stage">
      <div className="phone">
        <div className="phone-status" aria-hidden>
          <span>9:41</span>
          <span>Seatkeeper</span>
          <span>●●●</span>
        </div>
        <div className="phone-screen">
          <p className="resumed-from">Resumed from a link · session {id.slice(3, 11)}</p>
          <EventHeader listing={data.listing} />
          <CheckoutPanel initialSession={data.session} initialServerTime={data.serverTime} surface="mobile" />
        </div>
      </div>
    </main>
  );
}
