import { notFound } from 'next/navigation';
import { EventHeader } from '@/components/EventHeader';
import { fetchListing } from '@/lib/api-server';
import { formatMoney } from '@/lib/format';
import { startCheckout } from './actions';

const DEMO_LISTING = 'lst_heat_1';

export default async function Home() {
  const listing = await fetchListing(DEMO_LISTING);
  if (!listing) notFound();

  return (
    <main className="shell">
      <section className="card">
        <EventHeader listing={listing} />
        <form action={startCheckout} className="panel">
          <input type="hidden" name="listingId" value={listing.id} />
          <p className="price">{formatMoney(listing.price)}</p>
          <button type="submit" className="primary">Start checkout</button>
        </form>
      </section>
    </main>
  );
}
