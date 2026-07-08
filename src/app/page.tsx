import Link from 'next/link';
import { FileText, Calculator, Rocket, ArrowRight } from 'lucide-react';

import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

/** The three InfraGenie features, in product order. Each is a self-contained
 *  entry point — you can start from any of them. */
const FEATURES = [
  {
    href: '/prd/new',
    badge: 'Feature 1',
    icon: FileText,
    title: 'PRD & Plan generator',
    body: 'Describe your idea and answer a few quick questions. The AI infers your data model, architecture and a prioritized task breakdown you can ship against.',
    cta: 'Start a new PRD',
  },
  {
    href: '/cost',
    badge: 'Feature 2',
    icon: Calculator,
    title: 'Deployment cost predictor',
    body: 'Compare what your app costs to run across AWS, Google Cloud, Azure, Vercel and DigitalOcean — seeded from your PRD, with real, cited vendor prices.',
    cta: 'Estimate costs',
  },
  {
    href: '/deploy',
    badge: 'Feature 3',
    icon: Rocket,
    title: 'One-click deploy',
    body: 'Paste your repository URL. We read it, detect your stack, and tell you which of Vercel, Netlify and Render fits best — with a button into each provider’s own flow.',
    cta: 'Analyze a repo',
  },
] as const;

export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-muted/20 px-6 py-20">
      <main className="flex w-full max-w-5xl flex-col items-center gap-10 text-center">
        <div className="flex flex-col gap-4">
          <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            Plan it, price it, ship it.
          </h1>
          <p className="mx-auto max-w-2xl text-lg text-muted-foreground text-pretty">
            InfraGenie is your pre-build &amp; deploy companion. Turn an idea into a PRD, see what it
            costs to run across the major clouds, and deploy your repo to the provider that fits
            best — all in one place.
          </p>
        </div>

        <ul className="grid w-full gap-4 text-left sm:grid-cols-3">
          {FEATURES.map((feature) => {
            const Icon = feature.icon;
            return (
              <li key={feature.href}>
                <Card className="h-full">
                  <CardContent className="flex h-full flex-col gap-3 py-5">
                    <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                      <Icon className="size-4 text-primary" aria-hidden />
                      {feature.badge}
                    </span>
                    <h2 className="text-lg font-semibold tracking-tight">{feature.title}</h2>
                    <p className="flex-1 text-sm text-muted-foreground text-pretty">
                      {feature.body}
                    </p>
                    <Link
                      href={feature.href}
                      className={buttonVariants({ variant: 'outline', size: 'sm' }) + ' gap-1.5 self-start'}
                    >
                      {feature.cta}
                      <ArrowRight className="size-4" aria-hidden />
                    </Link>
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>

        <Link href="/prd/new" className={buttonVariants({ size: 'lg' })}>
          Start a new PRD
        </Link>
      </main>
    </div>
  );
}
