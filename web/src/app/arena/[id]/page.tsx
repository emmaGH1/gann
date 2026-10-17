export default async function Arena({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <main>
    <h1>gann run viewer</h1>
    <p>Viewer UI is pending separate design review. This page does not claim a run exists or a payment occurred.</p>
    {/^[0-9a-f-]{36}$/i.test(id) ? <p><a href={`/api/session/${encodeURIComponent(id)}`}>Read the sanitized session snapshot</a></p> : <p>Invalid session identifier.</p>}
    <p>Payment fulfillment is disabled in this foundation build.</p>
  </main>;
}
