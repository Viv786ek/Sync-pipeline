/**
 * Sync orchestrator.
 *
 * Runs all source adapters concurrently with Promise.allSettled so a
 * failure in one source never blocks the others.
 *
 * Each adapter is entirely responsible for its own error handling and
 * DB logging; the orchestrator only aggregates the results.
 */

import { syncHubSpot } from "./sources/hubspot.js";
import { syncStripe } from "./sources/stripe.js";
import { syncGoogleCalendar } from "./sources/google-calendar.js";
import { logger } from "../lib/logger.js";

export type SourceName = "hubspot" | "stripe" | "google_calendar";

export interface SourceResult {
  source: SourceName;
  processed: number;
  error?: string;
}

export interface OrchestratorResult {
  sources: SourceResult[];
  totalProcessed: number;
  errors: { source: SourceName; error: string }[];
  durationMs: number;
}

const ADAPTERS: Record<SourceName, () => Promise<{ processed: number; error?: string }>> = {
  hubspot: syncHubSpot,
  stripe: syncStripe,
  google_calendar: syncGoogleCalendar,
};

/**
 * Run all (or a subset of) sources in parallel.
 *
 * @param sources – which sources to sync. Defaults to all three.
 */
export async function runSync(
  sources: SourceName[] = ["hubspot", "stripe", "google_calendar"],
): Promise<OrchestratorResult> {
  const start = Date.now();

  logger.info({ sources }, "Orchestrator starting sync");

  // Promise.allSettled ensures all adapters run regardless of individual failures
  const settled = await Promise.allSettled(
    sources.map(async (name) => {
      const result = await ADAPTERS[name]();
      return { source: name, ...result };
    }),
  );

  const sourceResults: SourceResult[] = settled.map((s, i) => {
    const name = sources[i];
    if (s.status === "fulfilled") {
      return s.value;
    }
    // Adapter threw an uncaught exception — surface it without crashing the run
    const error =
      s.reason instanceof Error ? s.reason.message : String(s.reason);
    logger.error({ source: name, error }, "Adapter threw unexpectedly");
    return { source: name, processed: 0, error };
  });

  const durationMs = Date.now() - start;
  const totalProcessed = sourceResults.reduce((sum, r) => sum + r.processed, 0);
  const errors = sourceResults
    .filter((r): r is SourceResult & { error: string } => !!r.error)
    .map(({ source, error }) => ({ source, error }));

  logger.info(
    { totalProcessed, errors: errors.length, durationMs },
    "Orchestrator sync completed",
  );

  return { sources: sourceResults, totalProcessed, errors, durationMs };
}
