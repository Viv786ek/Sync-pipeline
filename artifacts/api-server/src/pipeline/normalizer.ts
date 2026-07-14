import type { InsertSyncRecord } from "@workspace/db";

/** Shape produced by every source adapter before writing to the DB */
export interface RawRecord {
  sourceType: "hubspot" | "stripe" | "google_calendar";
  externalId: string;
  recordType: "contact" | "deal" | "payment" | "event";
  title: string;
  description?: string | null;
  amount?: number | null;
  currency?: string | null;
  status?: string | null;
  email?: string | null;
  startDate?: Date | null;
  endDate?: Date | null;
  metadata?: Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rawData: any;
}

/**
 * Maps a source-adapter record to a DB-ready insert payload.
 * All field coercions happen here so adapters stay thin.
 */
export function normalize(raw: RawRecord): InsertSyncRecord {
  const now = new Date();
  return {
    sourceType: raw.sourceType,
    externalId: raw.externalId,
    recordType: raw.recordType,
    title: raw.title.trim() || `[no title] ${raw.externalId}`,
    description: raw.description ?? null,
    amount: raw.amount ?? null,
    currency: raw.currency?.toUpperCase() ?? null,
    status: raw.status ?? null,
    email: raw.email ?? null,
    startDate: raw.startDate ?? null,
    endDate: raw.endDate ?? null,
    metadata: raw.metadata ?? {},
    rawData: raw.rawData ?? {},
    syncedAt: now,
    updatedAt: now,
  };
}

// ─── HubSpot helpers ──────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeHubSpotContact(contact: any): InsertSyncRecord {
  const p = contact.properties ?? {};
  const firstName = (p.firstname ?? "").trim();
  const lastName = (p.lastname ?? "").trim();
  const fullName = [firstName, lastName].filter(Boolean).join(" ");

  return normalize({
    sourceType: "hubspot",
    externalId: String(contact.id),
    recordType: "contact",
    title: fullName || p.email || contact.id,
    description: [p.jobtitle, p.company].filter(Boolean).join(" at ") || null,
    status: p.hs_lead_status ?? null,
    email: p.email ?? null,
    startDate: p.createdate ? new Date(p.createdate) : null,
    metadata: {
      lifecyclestage: p.lifecyclestage,
      company: p.company,
      phone: p.phone,
      hubspot_owner_id: p.hubspot_owner_id,
    },
    rawData: contact,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeHubSpotDeal(deal: any): InsertSyncRecord {
  const p = deal.properties ?? {};
  const amount = p.amount ? parseFloat(p.amount) : null;

  return normalize({
    sourceType: "hubspot",
    externalId: String(deal.id),
    recordType: "deal",
    title: p.dealname ?? `Deal ${deal.id}`,
    amount: isNaN(amount as number) ? null : amount,
    currency: "USD",
    status: p.dealstage ?? null,
    startDate: p.createdate ? new Date(p.createdate) : null,
    endDate: p.closedate ? new Date(p.closedate) : null,
    metadata: {
      pipeline: p.pipeline,
      dealtype: p.dealtype,
      hubspot_owner_id: p.hubspot_owner_id,
    },
    rawData: deal,
  });
}

// ─── Stripe helpers ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeStripePaymentIntent(pi: any): InsertSyncRecord {
  // Stripe amounts are in the smallest currency unit (cents for USD)
  const amount = typeof pi.amount === "number" ? pi.amount / 100 : null;

  return normalize({
    sourceType: "stripe",
    externalId: pi.id,
    recordType: "payment",
    title: pi.description ?? `Payment ${pi.id}`,
    amount,
    currency: pi.currency ?? null,
    status: pi.status ?? null,
    email: pi.receipt_email ?? null,
    startDate: pi.created ? new Date(pi.created * 1000) : null,
    metadata: {
      customer: pi.customer,
      payment_method: pi.payment_method,
      capture_method: pi.capture_method,
      confirmation_method: pi.confirmation_method,
    },
    rawData: pi,
  });
}

// ─── Google Calendar helpers ──────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeGoogleCalendarEvent(event: any): InsertSyncRecord {
  // Events can have dateTime (timed) or date (all-day)
  const startRaw = event.start?.dateTime ?? event.start?.date;
  const endRaw = event.end?.dateTime ?? event.end?.date;

  return normalize({
    sourceType: "google_calendar",
    externalId: event.id,
    recordType: "event",
    title: event.summary ?? `Event ${event.id}`,
    description: event.description ?? null,
    status: event.status ?? null,
    email: event.organizer?.email ?? null,
    startDate: startRaw ? new Date(startRaw) : null,
    endDate: endRaw ? new Date(endRaw) : null,
    metadata: {
      location: event.location,
      htmlLink: event.htmlLink,
      attendeeCount: event.attendees?.length ?? 0,
      calendarId: event.organizer?.email,
      recurringEventId: event.recurringEventId,
    },
    rawData: event,
  });
}
