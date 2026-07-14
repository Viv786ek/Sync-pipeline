/**
 * HubSpot CRM source adapter.
 *
 * Fetches contacts and deals using the CRM v3 Search API.
 * - Incremental: filters by lastmodifieddate > cursor timestamp
 * - Full backfill: no date filter, pages through all records
 * - On 401/410: flags a full backfill and returns []
 */

import { config } from "../../config.js";
import {
  normalizeHubSpotContact,
  normalizeHubSpotDeal,
} from "../normalizer.js";
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
import type { InsertSyncRecord } from "@workspace/db";

const BASE_URL = "https://api.hubapi.com";
const PAGE_SIZE = 100;

// ─── HTTP helper ──────────────────────────────────────────────────────────────

async function hsPost<T>(
  path: string,
  body: unknown,
  token: string,
): Promise<{ data: T; status: number }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as T;
  return { data, status: res.status };
}

// ─── Per-object-type fetch ─────────────────────────────────────────────────────

interface HubSpotSearchResponse {
  results: unknown[];
  paging?: { next?: { after?: string } };
}

async function fetchAll(
  objectType: "contacts" | "deals",
  token: string,
  afterTimestamp?: string, // ISO-8601 or undefined for full fetch
): Promise<{ records: InsertSyncRecord[]; staleToken: boolean }> {
  const properties =
    objectType === "contacts"
      ? ["firstname", "lastname", "email", "phone", "company", "jobtitle", "hs_lead_status", "lifecyclestage", "createdate", "lastmodifieddate", "hubspot_owner_id"]
      : ["dealname", "amount", "dealstage", "pipeline", "dealtype", "closedate", "createdate", "hs_lastmodifieddate", "hubspot_owner_id"];

  const modifiedProp =
    objectType === "contacts" ? "lastmodifieddate" : "hs_lastmodifieddate";

  let after: string | undefined;
  const records: InsertSyncRecord[] = [];

  do {
    const filters = afterTimestamp
      ? [
          {
            propertyName: modifiedProp,
            operator: "GT",
            value: String(new Date(afterTimestamp).getTime()),
          },
        ]
      : [];

    const body = {
      filterGroups: filters.length ? [{ filters }] : [],
      properties,
      limit: PAGE_SIZE,
      sorts: [{ propertyName: modifiedProp, direction: "ASCENDING" }],
      ...(after ? { after } : {}),
    };

    const { data, status } = await hsPost<HubSpotSearchResponse>(
      `/crm/v3/objects/${objectType}/search`,
      body,
      token,
    );

    if (status === 401 || status === 403) {
      logger.warn({ objectType, status }, "HubSpot auth error — will full-sync next run");
      return { records: [], staleToken: true };
    }

    if (status === 429) {
      // Rate limited — return what we have so far
      logger.warn({ objectType }, "HubSpot rate limit hit, partial result returned");
      break;
    }

    if (status !== 200) {
      throw new Error(`HubSpot ${objectType} search failed: HTTP ${status} — ${JSON.stringify(data)}`);
    }

    const normalized = (data.results ?? []).map((r) =>
      objectType === "contacts"
        ? normalizeHubSpotContact(r)
        : normalizeHubSpotDeal(r),
    );
    records.push(...normalized);
    after = data.paging?.next?.after;
  } while (after);

  return { records, staleToken: false };
}

// ─── Public entry point ────────────────────────────────────────────────────────

export async function syncHubSpot(): Promise<{
  processed: number;
  error?: string;
}> {
  if (!config.hubspotToken) {
    logger.info("HUBSPOT_TOKEN not configured — skipping HubSpot sync");
    return { processed: 0, error: "HUBSPOT_TOKEN not configured" };
  }

  const token = config.hubspotToken;
  const cursor = await getCursor("hubspot");
  const isFullSync = cursor.needsFullSync || !cursor.cursorValue;
  const syncType = isFullSync ? "full" : "incremental";
  const logId = await openSyncLog("hubspot", syncType);

  logger.info({ syncType, cursor: cursor.cursorValue }, "Starting HubSpot sync");

  try {
    const afterTimestamp = isFullSync ? undefined : cursor.cursorValue!;
    const syncedAt = new Date().toISOString();

    // Fetch contacts and deals in sequence (HubSpot has per-second rate limits)
    const { records: contactRecords, staleToken: contactsStale } =
      await fetchAll("contacts", token, afterTimestamp);

    const { records: dealRecords, staleToken: dealsStale } =
      await fetchAll("deals", token, afterTimestamp);

    if (contactsStale || dealsStale) {
      await flagFullSync("hubspot");
      await failSyncLog(logId, "Auth error — flagged for full backfill");
      return { processed: 0, error: "Auth error — flagged for full backfill" };
    }

    const allRecords = [...contactRecords, ...dealRecords];
    const written = await upsertRecords(allRecords);

    await advanceCursor("hubspot", syncedAt);
    await closeSyncLog(logId, written);

    logger.info(
      { syncType, contacts: contactRecords.length, deals: dealRecords.length },
      "HubSpot sync completed",
    );
    return { processed: written };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, syncType }, "HubSpot sync failed");
    await failSyncLog(logId, message);
    return { processed: 0, error: message };
  }
}
