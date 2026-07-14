import {
  pgTable,
  uuid,
  text,
  doublePrecision,
  timestamp,
  jsonb,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Normalized records from all data sources (HubSpot, Stripe, Google Calendar).
 * The unique constraint on (source_type, external_id) enforces idempotency —
 * re-running a sync or re-firing a webhook will upsert, never duplicate.
 */
export const syncRecordsTable = pgTable(
  "sync_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Which data source produced this record */
    sourceType: text("source_type").notNull(), // 'hubspot' | 'stripe' | 'google_calendar'

    /** The record's ID in the source system */
    externalId: text("external_id").notNull(),

    /** Semantic type of the record */
    recordType: text("record_type").notNull(), // 'contact' | 'deal' | 'payment' | 'event'

    /** Human-readable title / name */
    title: text("title").notNull(),

    /** Optional description or notes */
    description: text("description"),

    /** Monetary amount (normalized to major currency units) */
    amount: doublePrecision("amount"),

    /** ISO 4217 currency code */
    currency: text("currency"),

    /** Status string from the source (e.g. "open", "succeeded", "confirmed") */
    status: text("status"),

    /** Contact or organizer email */
    email: text("email"),

    /** Start time (events) or created-at date for other records */
    startDate: timestamp("start_date", { withTimezone: true }),

    /** End time for calendar events */
    endDate: timestamp("end_date", { withTimezone: true }),

    /** Non-normalised source-specific fields kept for queries */
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),

    /** Complete original payload from the source for auditing */
    rawData: jsonb("raw_data")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),

    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("sync_records_source_external_idx").on(
      table.sourceType,
      table.externalId,
    ),
  ],
);

export const insertSyncRecordSchema = createInsertSchema(syncRecordsTable);
export const selectSyncRecordSchema = createSelectSchema(syncRecordsTable);
export type InsertSyncRecord = z.infer<typeof insertSyncRecordSchema>;
export type SyncRecord = typeof syncRecordsTable.$inferSelect;
