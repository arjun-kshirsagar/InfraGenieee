// @vitest-environment jsdom

/**
 * `<DetectedStackCard>` — presentational contract tests.
 *
 * The card is the product's credibility surface, so these tests assert the
 * things that make it trustworthy rather than incidental markup:
 *   - it renders across all five meaningful shapes from real, schema-valid
 *     fixtures;
 *   - **every** `DetectionSignal` (path AND verbatim excerpt) is reachable in
 *     the DOM after one click on "How we know" — a hidden signal is hidden
 *     evidence;
 *   - the `unknown` state names no framework anywhere in the output;
 *   - it is purely presentational (no fetch/localStorage) and accessible.
 */

import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { stackDetectionSchema } from '@/types/deploy';
import { DetectedStackCard } from './detected-stack-card';
import {
  ALL_DETECTION_FIXTURES,
  EXPRESS_DETECTION,
  EXPRESS_REPO,
  MONOREPO_DETECTION,
  MONOREPO_REPO,
  NEXTJS_DETECTION,
  NEXTJS_REPO,
  UNKNOWN_DETECTION,
  UNKNOWN_REPO,
  VITE_DETECTION,
  VITE_REPO,
} from './detected-stack-card.fixtures';

afterEach(cleanup);

describe('fixtures are contract-valid', () => {
  it.each(ALL_DETECTION_FIXTURES)('$name detection passes stackDetectionSchema', ({ detection }) => {
    expect(stackDetectionSchema.safeParse(detection).success).toBe(true);
  });
});

describe('<DetectedStackCard> renders across every shape', () => {
  it.each(ALL_DETECTION_FIXTURES)('renders the $name fixture without throwing', ({ detection, repo }) => {
    render(<DetectedStackCard detection={detection} repo={repo} />);
    // The header always links out to the repo.
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', repo.canonicalUrl);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });
});

describe('Next.js (high confidence)', () => {
  it('shows the framework, verbatim version, runtime, shape and confidence', () => {
    render(<DetectedStackCard detection={NEXTJS_DETECTION} repo={NEXTJS_REPO} />);
    expect(screen.getByText('nextjs')).toBeInTheDocument();
    // version rendered verbatim as written in the manifest
    expect(screen.getByText('^15.2.0')).toBeInTheDocument();
    expect(screen.getByText('node')).toBeInTheDocument();
    expect(screen.getByText(/High confidence/i)).toBeInTheDocument();
    expect(screen.getByText(/server-rendered/i)).toBeInTheDocument();
  });

  it('renders "no managed services needed" for an empty needs list', () => {
    render(<DetectedStackCard detection={NEXTJS_DETECTION} repo={NEXTJS_REPO} />);
    expect(screen.getByText(/no managed services needed/i)).toBeInTheDocument();
  });
});

describe('Vite (static)', () => {
  it('renders the static gloss', () => {
    render(<DetectedStackCard detection={VITE_DETECTION} repo={VITE_REPO} />);
    expect(screen.getByText('vite')).toBeInTheDocument();
    expect(screen.getByText(/static site/i)).toBeInTheDocument();
  });
});

describe('Express + Postgres (needs badges)', () => {
  it('renders a badge per service need', () => {
    render(<DetectedStackCard detection={EXPRESS_DETECTION} repo={EXPRESS_REPO} />);
    expect(screen.getByText('Database')).toBeInTheDocument();
    expect(screen.getByText('Cache')).toBeInTheDocument();
    expect(screen.getByText('Background worker')).toBeInTheDocument();
  });
});

describe('monorepo', () => {
  it('shows the monorepo note prominently', () => {
    render(<DetectedStackCard detection={MONOREPO_DETECTION} repo={MONOREPO_REPO} />);
    expect(screen.getByText(/looks like a monorepo/i)).toBeInTheDocument();
    // monorepo flag surfaced in the summary grid too
    expect(screen.getByText('Yes')).toBeInTheDocument();
  });
});

describe('"How we know" — every signal is reachable evidence', () => {
  it('renders each signal\'s path AND verbatim excerpt after one click', async () => {
    const user = userEvent.setup();
    render(<DetectedStackCard detection={EXPRESS_DETECTION} repo={EXPRESS_REPO} />);

    // Reachable in ONE click — not a modal, not another tab.
    const trigger = screen.getByRole('button', { name: /how we know/i });
    await user.click(trigger);

    for (const signal of EXPRESS_DETECTION.signals) {
      // path — may appear more than once (multiple signals cite package.json)
      expect(screen.getAllByText(signal.path).length).toBeGreaterThan(0);
      // the verbatim excerpt must be present, un-truncated (a path-as-excerpt,
      // e.g. `Dockerfile`, legitimately appears more than once)
      expect(screen.getAllByText(signal.excerpt).length).toBeGreaterThan(0);
      // and the human inference
      expect(screen.getAllByText(signal.implies).length).toBeGreaterThan(0);
    }
  });

  it('is keyboard-operable (Enter toggles the panel)', async () => {
    const user = userEvent.setup();
    render(<DetectedStackCard detection={NEXTJS_DETECTION} repo={NEXTJS_REPO} />);
    const trigger = screen.getByRole('button', { name: /how we know/i });
    trigger.focus();
    expect(trigger).toHaveFocus();
    await user.keyboard('{Enter}');
    // an excerpt from a Next.js signal becomes visible
    expect(screen.getByText('"next": "^15.2.0",')).toBeInTheDocument();
  });

  it('distinguishes strong from weak signals with text (not colour alone)', async () => {
    const user = userEvent.setup();
    render(<DetectedStackCard detection={NEXTJS_DETECTION} repo={NEXTJS_REPO} />);
    await user.click(screen.getByRole('button', { name: /how we know/i }));
    expect(screen.getAllByText(/strong signal/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/weak signal/i).length).toBeGreaterThan(0);
  });
});

describe('unknown confidence is a first-class state, not an error', () => {
  it('names no framework anywhere in the rendered output', () => {
    const { container } = render(
      <DetectedStackCard detection={UNKNOWN_DETECTION} repo={UNKNOWN_REPO} />,
    );
    const text = container.textContent ?? '';
    // Assert we do NOT invent a stack we couldn't read.
    for (const banned of [
      'nextjs',
      'vite',
      'express',
      'Framework',
      'App shape',
      'Runtime',
    ]) {
      expect(text).not.toContain(banned);
    }
  });

  it('explains what we could not read, and points at the providers below', () => {
    render(<DetectedStackCard detection={UNKNOWN_DETECTION} repo={UNKNOWN_REPO} />);
    expect(screen.getByText(/couldn.t read this repository/i)).toBeInTheDocument();
    expect(screen.getByText(/all three providers/i)).toBeInTheDocument();
    // the caveat notes are shown
    expect(screen.getByText(/only read GitHub repositories/i)).toBeInTheDocument();
  });

  it('is not styled as a failure (no alert role hijack)', () => {
    render(<DetectedStackCard detection={UNKNOWN_DETECTION} repo={UNKNOWN_REPO} />);
    // notes render under a note landmark, not an error alert
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
