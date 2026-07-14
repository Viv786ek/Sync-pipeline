/**
 * Google Calendar OAuth2 flow.
 *
 * Step 1 — GET /api/auth/google/init
 *   Returns the Google consent-page URL. Open it in a browser.
 *
 * Step 2 — GET /api/auth/google/callback?code=<code>
 *   Exchanges the code for tokens, returns the refresh_token.
 *   Copy it and set GOOGLE_REFRESH_TOKEN in your environment.
 *
 * Why manual token copy instead of auto-storage?
 *   Storing secrets in a DB column risks exposure via SQL dumps.
 *   The refresh token is a long-lived credential; keeping it in a
 *   platform secret / env var is the safer production pattern.
 */

import { Router } from "express";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";

const router = Router();

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

/** GET /api/auth/google/init — return the consent-page URL */
router.get("/auth/google/init", (req, res) => {
  if (!config.googleClientId) {
    res.status(503).json({ error: "GOOGLE_CLIENT_ID not configured" });
    return;
  }

  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: config.googleRedirectUri,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",   // request a refresh token
    prompt: "consent",         // force re-consent so Google issues refresh_token
  });

  const url = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;

  res.json({
    message:
      "Open this URL in a browser, sign in, approve access, then check the /api/auth/google/callback response for your refresh_token.",
    authUrl: url,
  });
});

/** GET /api/auth/google/callback — exchange code for tokens */
router.get("/auth/google/callback", async (req, res) => {
  const code = req.query.code as string | undefined;
  const error = req.query.error as string | undefined;

  if (error) {
    logger.warn({ error }, "Google OAuth was denied by the user");
    res.status(400).json({ error: `Google OAuth denied: ${error}` });
    return;
  }

  if (!code) {
    res.status(400).json({ error: "Missing code parameter" });
    return;
  }

  if (!config.googleClientId || !config.googleClientSecret) {
    res.status(503).json({ error: "Google OAuth credentials not configured" });
    return;
  }

  try {
    const params = new URLSearchParams({
      code,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uri: config.googleRedirectUri,
      grant_type: "authorization_code",
    });

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    const tokens = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      error?: string;
      error_description?: string;
    };

    if (!tokenRes.ok || tokens.error) {
      logger.error({ tokens }, "Token exchange failed");
      res.status(400).json({
        error: `Token exchange failed: ${tokens.error} — ${tokens.error_description}`,
      });
      return;
    }

    logger.info({ hasRefreshToken: !!tokens.refresh_token }, "Google OAuth completed");

    res.json({
      message: tokens.refresh_token
        ? "OAuth successful! Copy the refresh_token below and set it as GOOGLE_REFRESH_TOKEN in your environment variables, then redeploy."
        : "OAuth successful but no refresh_token was returned. Re-run /api/auth/google/init to force a new consent screen.",
      refresh_token: tokens.refresh_token ?? null,
      access_token_preview: tokens.access_token?.slice(0, 20) + "…",
      expires_in: tokens.expires_in,
      scope: tokens.scope,
    });
  } catch (err) {
    logger.error({ err }, "Google OAuth callback error");
    res.status(500).json({ error: "OAuth callback failed" });
  }
});

export default router;
