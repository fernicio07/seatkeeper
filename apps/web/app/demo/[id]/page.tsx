import { RaceButton } from '@/components/RaceButton';

// Review aid: both surfaces at once. Each iframe is a separate document with
// its own React root and memory — the only thing they share is the session id,
// which is an honest simulation of two devices.
export default async function DemoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <>
    {process.env.NODE_ENV !== 'production' && (
      <div className="demo-toolbar">
        <RaceButton />
      </div>
    )}
    <main className="demo">
      <section>
        <h2>Web</h2>
        <iframe src={`/checkout/${id}?embed=1`} title="Web surface" className="frame-web" />
      </section>
      <section>
        <h2>Mobile</h2>
        <iframe src={`/mobile/checkout/${id}`} title="Mobile surface" className="frame-mobile" />
      </section>
    </main>
    </>
  );
}
