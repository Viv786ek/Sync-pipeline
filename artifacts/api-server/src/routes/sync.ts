/**
 * POST /api/sync/run        — trigger a sync for all or specific sources
 * GET  /api/sync/status     — current cursor + last log per source
 * GET  /api/sync/logs       — paginated sync log history
 */

import { Router } from "express";
import { db, syncCursorsTable, syncLogsTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { runSync, type SourceName } from "../pipeline/orchestrator.js";
import { logger } from "../lib/logger.js";

const router = Router();

const VALID_SOURCES: SourceName[] = ["hubspot", "stripe", "google_calendar"];

/** POST /api/sync/run */
router.post("/sync/run", async (req, res) => {
  const { sources } = req.body as { sources?: string[] };

  const toSync: SourceName[] = sources
    ? (sources.filter((s) => VALID_SOURCES.includes(s as SourceName)) as SourceName[])
    : VALID_SOURCES;

  if (toSync.length === 0) {
    res.status(400).json({
      error: `Invalid sources. Valid values: ${VALID_SOURCES.join(", ")}`,
    });
    return;
  }

  logger.info({ sources: toSync }, "Sync triggered via API");

  // Run async — respond immediately with job metadata, result arrives via logs
  // For the demo, we wait for the result and return it synchronously.
  try {
    const result = await runSync(toSync);
    res.json({
      ok: true,
      sources: result.sources,
      totalProcessed: result.totalProcessed,
      errors: result.errors,
      durationMs: result.durationMs,
    });
  } catch (err) {
    logger.error({ err }, "Unexpected error in sync run");
    res.status(500).json({ error: "Sync failed unexpectedly" });
  }
});

/** GET /api/sync/status */
router.get("/sync/status", async (_req, res) => {
  try {
    const cursors = await db.select().from(syncCursorsTable);

    const lastLogs = await db
      .select()
      .from(syncLogsTable)
      .orderBy(desc(syncLogsTable.startedAt))
      .limit(20);

    // Attach the most-recent log per source
    const latestBySource: Record<string, (typeof lastLogs)[number]> = {};
    for (const log of lastLogs) {
      if (!latestBySource[log.sourceType]) {
        latestBySource[log.sourceType] = log;
      }
    }

    const status = VALID_SOURCES.map((source) => {
      const cursor = cursors.find((c) => c.sourceType === source);
      const latestLog = latestBySource[source];
      return {
        source,
        cursor: cursor?.cursorValue ?? null,
        needsFullSync: cursor?.needsFullSync ?? true,
        lastSyncAt: cursor?.lastSyncAt ?? null,
        lastRun: latestLog
          ? {
              syncType: latestLog.syncType,
              status: latestLog.status,
              recordsProcessed: latestLog.recordsProcessed,
              error: latestLog.errorMessage,
              startedAt: latestLog.startedAt,
              completedAt: latestLog.completedAt,
            }
          : null,
      };
    });

    res.json({ sources: status });
  } catch (err) {
    logger.error({ err }, "Failed to fetch sync status");
    res.status(500).json({ error: "Could not fetch sync status" });
  }
});

/** GET /api/sync/logs?limit=50 */
router.get("/sync/logs", async (req, res) => {
  try {
    const limit = Math.min(parseInt((req.query.limit as string) ?? "50", 10), 200);
    const logs = await db
      .select()
      .from(syncLogsTable)
      .orderBy(desc(syncLogsTable.startedAt))
      .limit(limit);
    res.json({ logs });
  } catch (err) {
    logger.error({ err }, "Failed to fetch sync logs");
    res.status(500).json({ error: "Could not fetch sync logs" });
  }
});

export default router;
