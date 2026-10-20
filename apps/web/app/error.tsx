'use client';

// Route-level error boundary (must be a Client Component). Catches failures
// rendering any page below it — e.g. the API is down during SSR — and shows
// a recoverable screen instead of Next's generic error page.
export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="shell">
      <section className="card">
        <div className="panel">
          <h1 className="error-title">We couldn&apos;t load your checkout</h1>
          <p className="muted">
            Loading a page never charges you. This is usually a brief connection problem.
          </p>
          <button className="primary" onClick={reset}>Try again</button>
        </div>
      </section>
    </main>
  );
}
