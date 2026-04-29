import type { Metadata } from 'next';
import { NewPrdClient } from './new-prd-client';

export const metadata: Metadata = {
  title: 'New PRD — InfraGenie',
  description:
    'Describe your idea and answer a few quick questions. InfraGenie reasons out the PRD, architecture and plan for you.',
};

/**
 * `/prd/new` — Feature 1, step 1: the single-screen idea + context input that
 * replaced the deleted 7-step wizard.
 *
 * This server component only renders the client form. The form owns validation,
 * autosave and the Resume/Start-fresh flow; its `onComplete` seam is where the
 * downstream clarifier + generate flow (F3/F4) hooks in.
 */
export default function NewPrdPage() {
  return (
    <main className="w-full px-4 py-10 sm:px-6 sm:py-14">
      <NewPrdClient />
    </main>
  );
}
