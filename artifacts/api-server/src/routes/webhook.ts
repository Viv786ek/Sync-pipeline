/**
 * Webhook endpoint for HubSpot CRM events.
 *
 * HubSpot can POST subscription events when contacts or deals change.
 * Each event contains the object type + id; we re-fetch the full record
 * from HubSpot and upsert it — so the same webhook firing twice produces
 * the same result (idempotent by design).
 *
 * Security: In production, verify the X-HubSpot-Signature header.
 * See: https://developers.hubspot.com/docs/api/webhooks#security
 */

import { Router } from "express";
import { config } from "../config.js";
import { normalizeHubSpotContact, normalizeHubSpotDeal } from "../pipeline/normalizer.js";
import { upsertRecords } from "../pipeline/writer.js";
import { logger } from "../lib/logger.js";

const router = Router();

/** POST /api/webhooks/hubspot */
router.post("/webhooks/hubspot", async (req, res) => {
  // Respond 200 immediately to satisfy HubSpot's 5-second ack requirement
  res.sendStatus(200);

  const events: Array<{
    subscriptionType?: string;
    objectId?: number;
    objectType?: string;
  }> = Array.isArray(req.body) ? req.body : [req.body];

  if (!config.hubspotToken) {
    logger.warn("HubSpot webhook received but HUBSPOT_TOKEN not configured — skipping");
    return;
  }

  const token = config.hubspotToken;

  for (const event of events) {
    const { subscriptionType, objectId } = event;
    if (!objectId) continue;

    try {
      // Determine object type from subscriptionType (e.g. "contact.creation")
      const isContact =
        !subscriptionType || subscriptionType.startsWith("contact");
      const objectTypePath = isContact ? "contacts" : "deals";

      const properties = isContact
        ? "firstname,lastname,email,phone,company,jobtitle,hs_lead_status,lifecyclestage,createdate,lastmodifieddate,hubspot_owner_id"
        : "dealname,amount,dealstage,pipeline,dealtype,closedate,createdate,hs_lastmodifieddate,hubspot_owner_id";

      const res2 = await fetch(
        `https://api.hubapi.com/crm/v3/objects/${objectTypePath}/${objectId}?properties=${properties}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      if (!res2.ok) {
        logger.warn(
          { objectId, objectTypePath, status: res2.status },
          "HubSpot webhook re-fetch failed",
        );
        continue;
      }

      const record = await res2.json();
      const normalized = isContact
        ? normalizeHubSpotContact(record)
        : normalizeHubSpotDeal(record);

      await upsertRecords([normalized]);

      logger.info(
        { objectId, objectTypePath, subscriptionType },
        "Webhook record upserted",
      );
    } catch (err) {
      logger.error({ err, objectId, subscriptionType }, "Webhook processing error");
    }
  }
});

export default router;
