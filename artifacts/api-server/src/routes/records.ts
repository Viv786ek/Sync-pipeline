/**
 * GET /api/records   — query normalized records with optional filters
 *
 * Query params:
 *   source      — 'hubspot' | 'stripe' | 'google_calendar'
 *   type        — 'contact' | 'deal' | 'payment' | 'event'
 *   limit       — max rows (default 50, max 500)
 *   offset      — pagination offset (default 0)
 *
 * GET /api/records/:id  — single record by UUID
 */

import { Router } from "express";
import { db, syncRecordsTable } from "@workspace/db";
import { eq, and, desc, type SQL } from "drizzle-orm";
import { logger } from "../lib/logger.js";

const router = Router();

router.get("/records", async (req, res) => {
  try {
    const { source, type, limit: limitStr, offset: offsetStr } = req.query as Record<string, string>;

    const limit = Math.min(parseInt(limitStr ?? "50", 10), 500);
    const offset = parseInt(offsetStr ?? "0", 10);

    const conditions: SQL[] = [];
    if (source) conditions.push(eq(syncRecordsTable.sourceType, source));
    if (type) conditions.push(eq(syncRecordsTable.recordType, type));

    const rows = await db
      .select()
      .from(syncRecordsTable)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(syncRecordsTable.syncedAt))
      .limit(limit)
      .offset(offset);

    res.json({ total: rows.length, limit, offset, records: rows });
  } catch (err) {
    logger.error({ err }, "Failed to fetch records");
    res.status(500).json({ error: "Could not fetch records" });
  }
});

router.get("/records/:id", async (req, res) => {
  try {
    const [record] = await db
      .select()
      .from(syncRecordsTable)
      .where(eq(syncRecordsTable.id, req.params.id))
      .limit(1);

    if (!record) {
      res.status(404).json({ error: "Record not found" });
      return;
    }

    res.json(record);
  } catch (err) {
    logger.error({ err }, "Failed to fetch record");
    res.status(500).json({ error: "Could not fetch record" });
  }
});

export default router;
