import { notFound } from 'next/navigation';
import { EventHeader } from '@/components/EventHeader';
import { CheckoutPanel } from '@/components/CheckoutPanel';
import { HandoffLink } from '@/components/HandoffLink';
import { fetchCheckout } from '@/lib/api-server';

// The simulated mobile surface. Deliberately shares NO client state with web:
// it receives a bare session id (the "deep link") and resumes from the server,
// exactly like a native app opening a universal link would.
export default async function MobileCheckoutPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ embed?: string }>;
}) {
  const { id } = await params;
  const embedded = (await searchParams).embed === '1';
  const data = await fetchCheckout(id, 'mobile');
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
          <CheckoutPanel key={data.session.id} initialSession={data.session} initialServerTime={data.serverTime} surface="mobile" />
          {!embedded && <HandoffLink sessionId={data.session.id} from="mobile" />}
        </div>
      </div>
    </main>
  );
}
