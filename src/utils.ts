import { Request } from "express";

const rawFrontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
export const allowedOrigins = rawFrontendUrl
  .split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);

const firstUrl = allowedOrigins[0] || "http://localhost:3000";
export const primaryFrontendUrl = firstUrl.startsWith("http://") || firstUrl.startsWith("https://")
  ? firstUrl
  : `https://${firstUrl}`;

/**
 * Dynamically extracts the active frontend URL from the request Origin or Referer header,
 * falling back to the configured primary Frontend URL.
 */
export const getFrontendUrl = (req: Request): string => {
  const origin = req.get("origin") || req.get("referer");
  if (origin) {
    try {
      const originUrl = new URL(origin);
      const originHost = originUrl.host.toLowerCase();

      // Check if this originHost matches any allowed origin's host
      const isAllowed = allowedOrigins.some((allowed) => {
        try {
          const allowedHost = allowed.startsWith("http://") || allowed.startsWith("https://")
            ? new URL(allowed).host
            : allowed;
          return allowedHost.toLowerCase() === originHost;
        } catch {
          return false;
        }
      });

      if (isAllowed) {
        return originUrl.origin;
      }
    } catch {
      // fallback if parsing fails
    }
  }
  return primaryFrontendUrl;
};
