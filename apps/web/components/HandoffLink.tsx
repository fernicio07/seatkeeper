// Server Component. A plain <a>: works before hydration and without JS.
// The link carries ONLY the session id — never price, version or status — so
// whichever surface opens it must resume through the server and re-validate.
export function HandoffLink({ sessionId }: { sessionId: string }) {
  return (
    <div className="handoff">
      <a className="secondary" href={`/mobile/checkout/${sessionId}`} target="_blank" rel="noopener">
        📱 Continue on your phone
      </a>
      <a className="text-link" href={`/demo/${sessionId}`}>Side-by-side demo</a>
    </div>
  );
}
