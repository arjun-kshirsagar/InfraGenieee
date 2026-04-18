import type { ReactNode } from 'react';

/**
 * A titled document section with consistent spacing. Optional `count` renders a
 * subtle badge (e.g. number of user stories). `id`s are rendered by callers,
 * not here.
 */
export function DocSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}
