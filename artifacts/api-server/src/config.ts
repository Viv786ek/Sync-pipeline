/**
 * Centralised environment-variable validation.
 *
 * Missing required vars throw at startup (fail fast).
 * Optional vars return undefined and the respective source adapter
 * will skip with a warning rather than crashing the pipeline.
 */

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function optional(key: string): string | undefined {
  return process.env[key] || undefined;
}

export const config = {
  /** Postgres connection string — provisioned automatically */
  databaseUrl: required("DATABASE_URL"),

  /** Listening port — injected by the platform runtime */
  port: parseInt(process.env.PORT ?? "5000", 10),

  nodeEnv: process.env.NODE_ENV ?? "development",

  /** HubSpot Private App token (pat-na1-…) */
  hubspotToken: optional("HUBSPOT_TOKEN"),

  /** Stripe secret key (sk_test_… or sk_live_…) */
  stripeSecretKey: optional("STRIPE_SECRET_KEY"),

  /**
   * Google OAuth2 credentials — stored as a JSON string containing
   * client_id, client_secret, and redirect_uri.
   */
  googleClientId: optional("GOOGLE_CLIENT_ID"),
  googleClientSecret: optional("GOOGLE_CLIENT_SECRET"),
  googleRedirectUri:
    optional("GOOGLE_REDIRECT_URI") ?? "http://localhost:5000/api/auth/google/callback",

  /** Google refresh token obtained after completing the OAuth flow */
  googleRefreshToken: optional("GOOGLE_REFRESH_TOKEN"),

  /** Calendar to sync (defaults to "primary") */
  googleCalendarId: optional("GOOGLE_CALENDAR_ID") ?? "primary",
};
