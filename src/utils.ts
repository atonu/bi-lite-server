import { Request } from "express";

const rawFrontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
export const primaryFrontendUrl = rawFrontendUrl.split(",")[0].trim().replace(/\/$/, "");

/**
 * Dynamically extracts the active frontend URL from the request Origin or Referer header,
 * falling back to the configured primary Frontend URL.
 */
export const getFrontendUrl = (req: Request): string => {
  const origin = req.get("origin") || req.get("referer");
  if (origin) {
    return origin.replace(/\/$/, "");
  }
  return primaryFrontendUrl;
};
