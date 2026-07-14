import { db, syncRecordsTable, syncCursorsTable, syncLogsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import type { InsertSyncRecord } from "@workspace/db";
import { logger } from "../lib/logger.js";

/**
 * Upserts a batch of normalized records using ON CONFLICT DO UPDATE.
 * The unique key is (source_type, external_id).
 *
 * This is the idempotency guarantee: running the same records twice
 * (e.g. webhook fired twice, job re-ran) will update, never duplicate.
 *
 * @returns Number of rows actually written
 */
export async function upsertRecords(
  records: InsertSyncRecord[],
): Promise<number> {
  if (records.length === 0) return 0;

  // Drizzle does not yet expose a typed onConflictDoUpdate helper for
  // arbitrary column sets, so we build a thin raw statement via the
  // drizzle sql template literal which is still safe (no user input here).
  await db
    .insert(syncRecordsTable)
    .values(records)
    .onConflictDoUpdate({
      target: [syncRecordsTable.sourceType, syncRecordsTable.externalId],
      set: {
        title: sql`excluded.title`,
        description: sql`excluded.description`,
        amount: sql`excluded.amount`,
        currency: sql`excluded.currency`,
        status: sql`excluded.status`,
        email: sql`excluded.email`,
        startDate: sql`excluded.start_date`,
        endDate: sql`excluded.end_date`,
        metadata: sql`excluded.metadata`,
        rawData: sql`excluded.raw_data`,
        syncedAt: sql`excluded.synced_at`,
        updatedAt: sql`excluded.updated_at`,
      },
    });

  return records.length;
}

// ─── Cursor helpers ────────────────────────────────────────────────────────────

/** Read or create the cursor row for a source. */
export async function getCursor(sourceType: string) {
  const rows = await db
    .select()
    .from(syncCursorsTable)
    .where(eq(syncCursorsTable.sourceType, sourceType))
    .limit(1);

  if (rows.length > 0) return rows[0];

  // First run: create row with needsFullSync = true
  const [created] = await db
    .insert(syncCursorsTable)
    .values({ sourceType, needsFullSync: true })
    .returning();
  return created;
}

/** Advance the cursor after a successful sync. */
export async function advanceCursor(
  sourceType: string,
  newCursorValue: string,
): Promise<void> {
  await db
    .update(syncCursorsTable)
    .set({
      cursorValue: newCursorValue,
      needsFullSync: false,
      lastSyncAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(syncCursorsTable.sourceType, sourceType));
}

/** Flag a source to run a full backfill on the next sync cycle. */
export async function flagFullSync(sourceType: string): Promise<void> {
  await db
    .update(syncCursorsTable)
    .set({ needsFullSync: true, updatedAt: new Date() })
    .where(eq(syncCursorsTable.sourceType, sourceType));

  logger.warn({ sourceType }, "Flagged source for full backfill on next sync");
}

// ─── Sync log helpers ──────────────────────────────────────────────────────────

/** Open a sync-log entry and return its id. */
export async function openSyncLog(
  sourceType: string,
  syncType: "incremental" | "full",
): Promise<string> {
  const [row] = await db
    .insert(syncLogsTable)
    .values({ sourceType, syncType, status: "running" })
    .returning({ id: syncLogsTable.id });
  return row.id;
}

/** Close a sync-log entry as completed. */
export async function closeSyncLog(
  logId: string,
  recordsProcessed: number,
): Promise<void> {
  await db
    .update(syncLogsTable)
    .set({
      status: "completed",
      recordsProcessed,
      completedAt: new Date(),
    })
    .where(eq(syncLogsTable.id, logId));
}

/** Close a sync-log entry as failed. */
export async function failSyncLog(
  logId: string,
  errorMessage: string,
): Promise<void> {
  await db
    .update(syncLogsTable)
    .set({
      status: "failed",
      errorMessage,
      completedAt: new Date(),
    })
    .where(eq(syncLogsTable.id, logId));
}
