import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Audit log for every sync run (per source).
 * Records sync type, outcome, record count, and any error message.
 */
export const syncLogsTable = pgTable("sync_logs", {
  id: uuid("id").primaryKey().defaultRandom(),

  /** Which source was synced */
  sourceType: text("source_type").notNull(),

  /** 'incremental' or 'full' */
  syncType: text("sync_type").notNull(),

  /** 'running' | 'completed' | 'failed' */
  status: text("status").notNull().default("running"),

  /** How many records were upserted during this run */
  recordsProcessed: integer("records_processed").notNull().default(0),

  /** Populated when status = 'failed' */
  errorMessage: text("error_message"),

  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const insertSyncLogSchema = createInsertSchema(syncLogsTable);
export const selectSyncLogSchema = createSelectSchema(syncLogsTable);
export type InsertSyncLog = z.infer<typeof insertSyncLogSchema>;
export type SyncLog = typeof syncLogsTable.$inferSelect;
