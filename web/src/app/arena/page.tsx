import { redirect } from "next/navigation";

// Compatibility entry point for plugin dashboard URLs (/arena?id=...).
export default async function ArenaEntry({ searchParams }: {
  searchParams: Promise<{ id?: string | string[] }>;
}) {
  const { id } = await searchParams;
  if (typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    redirect(`/arena/${id.toLowerCase()}`);
  }
  return <main>
    <h1>gann run viewer</h1>
    <p>Start a test through the Gann PayBox plugin, then open the viewer link it returns.</p>
    <p>No run was selected. This page does not start an agent or a payment.</p>
  </main>;
}
