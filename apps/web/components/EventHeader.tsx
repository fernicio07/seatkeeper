import type { Listing } from '@seatkeeper/shared';
import { formatEventDate } from '@/lib/format';

// Server Component (no 'use client'): renders to HTML on the server and ships
// zero JavaScript. Event and seat never change during a checkout, so there's
// nothing for the client to hydrate here.
export function EventHeader({ listing }: { listing: Listing }) {
  return (
    <header className="event">
      <p className="eyebrow">{listing.venue}</p>
      <h1>{listing.eventName}</h1>
      <p className="muted">{formatEventDate(listing.eventDate)}</p>
      <dl className="seat">
        <div><dt>Section</dt><dd>{listing.section}</dd></div>
        <div><dt>Row</dt><dd>{listing.row}</dd></div>
        <div><dt>Seat</dt><dd>{listing.seat}</dd></div>
      </dl>
    </header>
  );
}
