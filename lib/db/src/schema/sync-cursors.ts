import { pgTable, uuid, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Tracks the incremental-sync cursor for each data source.
 * One row per sourceType; updated after every successful sync.
 *
 * When `needsFullSync` is true the pipeline ignores `cursorValue` and
 * performs a complete backfill, then resets the flag on success.
 */
export const syncCursorsTable = pgTable("sync_cursors", {
  id: uuid("id").primaryKey().defaultRandom(),

  /** Data source identifier — must be unique */
  sourceType: text("source_type").notNull().unique(),

  /**
   * Opaque cursor value stored by each source adapter.
   * For HubSpot / Stripe this is an ISO-8601 timestamp.
   * For Google Calendar this is a nextSyncToken returned by the API.
   */
  cursorValue: text("cursor_value"),

  /**
   * When true the pipeline will run a full backfill on the next sync,
   * then reset this flag. Set to true when:
   *   - A 410 (sync token expired) is returned
   *   - A 401/403 is returned for incremental fetch but not for full fetch
   *   - `cursorValue` is NULL (first-ever sync)
   */
  needsFullSync: boolean("needs_full_sync").notNull().default(true),

  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertSyncCursorSchema = createInsertSchema(syncCursorsTable);
export const selectSyncCursorSchema = createSelectSchema(syncCursorsTable);
export type InsertSyncCursor = z.infer<typeof insertSyncCursorSchema>;
export type SyncCursor = typeof syncCursorsTable.$inferSelect;
