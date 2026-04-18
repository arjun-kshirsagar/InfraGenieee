import { DocumentView } from '@/components/prd/document/document-view';

/**
 * Client-rendered PRD document route. Documents live in `localStorage` (there is
 * no `GET /api/prd/:id` in v1), so all loading happens inside `DocumentView`
 * after mount. This server component only unwraps the route param and hands the
 * id down. Because there is no server data, we opt the route out of static
 * generation.
 */

export const dynamic = 'force-dynamic';

export default async function PrdDocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <main className="flex flex-1 flex-col">
      <DocumentView id={id} />
    </main>
  );
}
