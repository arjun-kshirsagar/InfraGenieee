import type { Metadata } from 'next';
import { WizardShell } from '@/components/prd/wizard-shell';

export const metadata: Metadata = {
  title: 'New PRD — InfraGenie',
  description:
    'Answer a short questionnaire and InfraGenie generates a PRD, architecture, and task plan.',
};

/**
 * Thin server component. All interactivity lives in the client `WizardShell`
 * (draft state, autosave, navigation), keeping this route a lightweight wrapper.
 */
export default function NewPrdPage() {
  return (
    <main className="flex flex-1 flex-col">
      <header className="border-b bg-muted/30">
        <div className="mx-auto w-full max-w-5xl px-6 py-6">
          <h1 className="text-2xl font-semibold tracking-tight">Plan your product</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Answer a few questions about scale, budget, stack, and data. We&apos;ll turn
            them into a PRD, an architecture, and a task plan.
          </p>
        </div>
      </header>
      <WizardShell />
    </main>
  );
}
