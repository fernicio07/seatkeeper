// Formatting that runs on BOTH server and client must produce identical
// strings, or React reports a hydration mismatch. Intl defaults to the
// runtime's locale and time zone — the Node server and the fan's browser
// almost never agree — so every formatter pins both explicitly.

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function formatMoney(cents: number): string {
  return money.format(cents / 100);
}

// Event times are shown in the venue's zone, not the viewer's: a 7:30pm
// tip-off is 7:30pm on the ticket wherever you're buying from.
const eventDate = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'America/New_York',
  timeZoneName: 'short',
});

export function formatEventDate(iso: string): string {
  return eventDate.format(new Date(iso));
}

/** m:ss, rounded UP so we never show 0:00 while time technically remains. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
