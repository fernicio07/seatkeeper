import { startCheckout } from '@/app/actions';

interface Props {
  listingId: string;
  surface: 'web' | 'mobile';
  title: string;
  body: string;
  tone: 'danger' | 'neutral';
}

// A Server Action form: works before hydration, so recovery never waits on JS.
// Shared by EXPIRED and FAILED — both recover the same way (fresh session).
export function RestartCheckout({ listingId, surface, title, body, tone }: Props) {
  return (
    <div className={`notice ${tone === 'danger' ? 'danger' : ''}`}>
      <h3>{title}</h3>
      <p className="muted">{body}</p>
      <form action={startCheckout}>
        <input type="hidden" name="listingId" value={listingId} />
        <input type="hidden" name="surface" value={surface} />
        <button type="submit" className="primary">Check availability again</button>
      </form>
    </div>
  );
}
