import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';

export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-muted/20 px-6 py-20">
      <main className="flex w-full max-w-2xl flex-col items-center gap-8 text-center">
        <span className="rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground">
          Feature 1 · PRD &amp; Plan generator
        </span>

        <div className="flex flex-col gap-4">
          <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            Plan your product before you build it.
          </h1>
          <p className="text-lg text-muted-foreground text-pretty">
            InfraGenie asks the questions that matter — scale, traffic, budget, stack,
            data model, auth, and integrations — then generates a PRD, an architecture,
            and a task breakdown you can actually ship against.
          </p>
        </div>

        <div className="flex flex-col items-center gap-3 sm:flex-row">
          <Link href="/prd/new" className={buttonVariants({ size: 'lg' })}>
            Start a new PRD
          </Link>
        </div>

        <ul className="mt-4 grid w-full gap-3 text-left text-sm text-muted-foreground sm:grid-cols-3">
          <li className="rounded-lg border bg-background p-4">
            <span className="block font-medium text-foreground">1. Answer</span>
            A guided 7-step questionnaire captures your requirements.
          </li>
          <li className="rounded-lg border bg-background p-4">
            <span className="block font-medium text-foreground">2. Generate</span>
            A deterministic engine turns answers into a structured plan.
          </li>
          <li className="rounded-lg border bg-background p-4">
            <span className="block font-medium text-foreground">3. Build</span>
            Get a PRD, architecture, and prioritized task list.
          </li>
        </ul>
      </main>
    </div>
  );
}
