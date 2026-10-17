import ArenaViewer from "./viewer";
export default async function ArenaPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ArenaViewer id={id} />;
}
