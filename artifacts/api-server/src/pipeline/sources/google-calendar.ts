/**
 * Google Calendar source adapter.
 *
 * Uses direct HTTPS calls to the Calendar REST API (no SDK) for a
 * fully self-contained bundle.
 *
 * Incremental strategy:
 *   - First run:          full sync, save nextSyncToken returned by API
 *   - Subsequent runs:    pass syncToken to API; API returns only changed events
 *   - On HTTP 410:        syncToken expired → full backfill, save new syncToken
 *   - On 401/403:         log error, flag full-sync, return []
 *
 * The cursor stored in sync_cursors is the nextSyncToken (not a timestamp).
 */

import { config } from "../../config.js";
import { normalizeGoogleCalendarEvent } from "../normalizer.js";
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

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

// ─── OAuth2 token refresh ──────────────────────────────────────────────────────

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  error?: string;
  error_description?: string;
}

async function getAccessToken(): Promise<string> {
  if (!config.googleClientId || !config.googleClientSecret || !config.googleRefreshToken) {
    throw new Error(
      "Google Calendar requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN",
    );
  }

  const params = new URLSearchParams({
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    refresh_token: config.googleRefreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const json = (await res.json()) as TokenResponse;

  if (!res.ok || json.error) {
    throw new Error(
      `Failed to refresh Google access token: ${json.error} — ${json.error_description}`,
    );
  }

  return json.access_token;
}

// ─── Events list helper ────────────────────────────────────────────────────────

interface CalendarEventsResponse {
  items?: unknown[];
  nextPageToken?: string;
  nextSyncToken?: string;
  error?: { code: number; message: string };
}

type FetchEventsResult =
  | { ok: true; events: unknown[]; nextSyncToken: string }
  | { ok: false; expiredToken: boolean; status: number };

async function fetchEvents(
  calendarId: string,
  accessToken: string,
  syncToken?: string,
): Promise<FetchEventsResult> {
  const events: unknown[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;

  do {
    const params = new URLSearchParams({
      singleEvents: "true",
      orderBy: "updated",
      maxResults: "250",
    });

    if (syncToken && !pageToken) {
      // syncToken and pageToken are mutually exclusive on the first page
      params.set("syncToken", syncToken);
    }
    if (pageToken) {
      params.set("pageToken", pageToken);
    }
    if (!syncToken) {
      // Full fetch: include deleted events so we can track them
      params.set("showDeleted", "true");
    }

    const url = `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (res.status === 410) {
      return { ok: false, expiredToken: true, status: 410 };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, expiredToken: false, status: res.status };
    }

    const json = (await res.json()) as CalendarEventsResponse;

    if (!res.ok) {
      throw new Error(
        `Google Calendar API error: HTTP ${res.status} — ${json.error?.message ?? "unknown"}`,
      );
    }

    events.push(...(json.items ?? []));
    pageToken = json.nextPageToken;
    nextSyncToken = json.nextSyncToken;
  } while (pageToken);

  if (!nextSyncToken) {
    throw new Error("Google Calendar response missing nextSyncToken");
  }

  return { ok: true, events, nextSyncToken };
}

// ─── Public entry point ────────────────────────────────────────────────────────

export async function syncGoogleCalendar(): Promise<{
  processed: number;
  error?: string;
}> {
  if (!config.googleClientId || !config.googleClientSecret || !config.googleRefreshToken) {
    logger.info(
      "GOOGLE_REFRESH_TOKEN not configured — skipping Google Calendar sync. " +
        "Visit /api/auth/google/init to complete OAuth and obtain a refresh token.",
    );
    return {
      processed: 0,
      error:
        "Google Calendar not configured — complete OAuth at /api/auth/google/init",
    };
  }

  const cursor = await getCursor("google_calendar");
  const isFullSync = cursor.needsFullSync || !cursor.cursorValue;
  const syncType = isFullSync ? "full" : "incremental";
  const logId = await openSyncLog("google_calendar", syncType);

  logger.info(
    { syncType, hasSyncToken: !!cursor.cursorValue },
    "Starting Google Calendar sync",
  );

  try {
    const accessToken = await getAccessToken();

    const result = await fetchEvents(
      config.googleCalendarId,
      accessToken,
      isFullSync ? undefined : cursor.cursorValue!,
    );

    if (!result.ok) {
      if (result.expiredToken) {
        // 410: sync token expired — fall back to full backfill
        logger.warn("Google Calendar sync token expired — running full backfill");
        await flagFullSync("google_calendar");
        await failSyncLog(logId, "Sync token expired — flagged for full backfill");
        return { processed: 0, error: "Sync token expired — retry triggered" };
      }
      // 401/403: auth issue
      await flagFullSync("google_calendar");
      await failSyncLog(logId, `Auth error HTTP ${result.status}`);
      return { processed: 0, error: `Google Calendar auth error: HTTP ${result.status}` };
    }

    // Filter out cancelled events from normalisation (they won't have useful data)
    const validEvents = (result.events as Array<{ status?: string }>).filter(
      (e) => e.status !== "cancelled",
    );

    const normalized = validEvents.map(normalizeGoogleCalendarEvent);
    const written = await upsertRecords(normalized);

    await advanceCursor("google_calendar", result.nextSyncToken);
    await closeSyncLog(logId, written);

    logger.info(
      { syncType, total: result.events.length, written },
      "Google Calendar sync completed",
    );
    return { processed: written };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, syncType }, "Google Calendar sync failed");
    await failSyncLog(logId, message);
    return { processed: 0, error: message };
  }
}
