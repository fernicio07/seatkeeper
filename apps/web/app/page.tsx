import { notFound } from 'next/navigation';
import { EventHeader } from '@/components/EventHeader';
import { fetchListing } from '@/lib/api-server';
import { formatMoney } from '@/lib/format';
import { resetDemo, startCheckout } from './actions';

const DEMO_LISTING = 'lst_heat_1';

export default async function Home({ searchParams }: { searchParams: Promise<{ unavailable?: string }> }) {
  const data = await fetchListing(DEMO_LISTING);
  if (!data) notFound();
  const { listing, available } = data;
  const bounced = (await searchParams).unavailable === '1';

  return (
    <main className="shell">
      <section className="card">
        <EventHeader listing={listing} />
        <form action={startCheckout} className="panel">
          <input type="hidden" name="listingId" value={listing.id} />
          <p className="price">{formatMoney(listing.price)}</p>
          {!available && (
            <p className="notice" role="status">
              {bounced ? 'Someone else is checking out this seat right now. ' : 'This seat is held or sold. '}
              Holds last a few minutes. Check back soon.
            </p>
          )}
          <button type="submit" className="primary" disabled={!available}>
            {available ? 'Start checkout' : 'Seat unavailable'}
          </button>
        </form>
        {process.env.NODE_ENV !== 'production' && (
          <form action={resetDemo} className="dev-reset">
            <button type="submit" className="text-link">Reset demo (dev): put the seat back on sale</button>
          </form>
        )}
      </section>
    </main>
  );
}
