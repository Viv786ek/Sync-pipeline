/**
 * Stripe payments source adapter.
 *
 * Fetches PaymentIntents using Stripe's list endpoint.
 * - Incremental: filters by created[gt] using stored Unix timestamp cursor
 * - Full backfill: no date filter, pages through all records
 * - On 401: flags a full backfill and returns []
 *
 * Stripe does not use expiring sync tokens, so 410 is not a concern.
 * The cursor is a Unix timestamp (seconds).
 */

import Stripe from "stripe";
import { config } from "../../config.js";
import { normalizeStripePaymentIntent } from "../normalizer.js";
import {
  upsertRecords,
  getCursor,
  advanceCursor,
  flagFullSync,
  openSyncLog,
  closeSyncLog,
  failSyncLog,
} from "../writer.js";
import { logger } from "../../lib/logger.js";

// ─── Public entry point ────────────────────────────────────────────────────────

export async function syncStripe(): Promise<{
  processed: number;
  error?: string;
}> {
  if (!config.stripeSecretKey) {
    logger.info("STRIPE_SECRET_KEY not configured — skipping Stripe sync");
    return { processed: 0, error: "STRIPE_SECRET_KEY not configured" };
  }

  const stripe = new Stripe(config.stripeSecretKey, {
    apiVersion: "2026-06-24.dahlia",
    // Pinning the version keeps the schema stable even when Stripe publishes breaking changes
  });

  const cursor = await getCursor("stripe");
  const isFullSync = cursor.needsFullSync || !cursor.cursorValue;
  const syncType = isFullSync ? "full" : "incremental";
  const logId = await openSyncLog("stripe", syncType);

  logger.info({ syncType, cursor: cursor.cursorValue }, "Starting Stripe sync");

  try {
    // cursorValue stores a Unix timestamp (seconds as string)
    const createdGt = isFullSync
      ? undefined
      : parseInt(cursor.cursorValue!, 10);

    const syncedAt = Math.floor(Date.now() / 1000); // Unix seconds

    // Stripe supports async iteration directly on the list response
    const records: ReturnType<typeof normalizeStripePaymentIntent>[] = [];
    await stripe.paymentIntents.list({
      limit: 100,
      ...(createdGt ? { created: { gt: createdGt } } : {}),
    }).autoPagingEach((pi) => {
      records.push(normalizeStripePaymentIntent(pi));
    });

    const written = await upsertRecords(records);

    await advanceCursor("stripe", String(syncedAt));
    await closeSyncLog(logId, written);

    logger.info({ syncType, count: records.length }, "Stripe sync completed");
    return { processed: written };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Stripe throws StripeAuthenticationError for bad keys
    if (message.includes("API key") || message.includes("Authentication")) {
      logger.warn({ err }, "Stripe auth error — flagging for full backfill");
      await flagFullSync("stripe");
    }

    logger.error({ err, syncType }, "Stripe sync failed");
    await failSyncLog(logId, message);
    return { processed: 0, error: message };
  }
}
