import type { Metadata } from 'next';
import { DocumentList } from '@/components/prd/document/document-list';

export const metadata: Metadata = {
  title: 'Your PRDs — InfraGenie',
  description: 'Saved PRD documents generated on this browser.',
};

export const dynamic = 'force-dynamic';

/** Thin wrapper. The saved-documents list lives in localStorage, so all work
 *  happens in the client `DocumentList`. */
export default function PrdListPage() {
  return (
    <main className="flex flex-1 flex-col">
      <DocumentList />
    </main>
  );
}
