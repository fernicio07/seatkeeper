// Server Component. A plain <a>: works before hydration and without JS.
// The link carries ONLY the session id — never price, version or status — so
// whichever surface opens it must resume through the server and re-validate.
// Works in both directions: the brief's examples are web → app AND
// "discover on mobile, complete on desktop".
export function HandoffLink({ sessionId, from }: { sessionId: string; from: 'web' | 'mobile' }) {
  const to = from === 'web'
    ? { href: `/mobile/checkout/${sessionId}`, label: '📱 Continue on your phone' }
    : { href: `/checkout/${sessionId}`, label: '💻 Continue on desktop' };
  return (
    <div className="handoff">
      <a className="secondary" href={to.href} target="_blank" rel="noopener">
        {to.label}
      </a>
      {from === 'web' && <a className="text-link" href={`/demo/${sessionId}`}>Side-by-side demo</a>}
    </div>
  );
}
