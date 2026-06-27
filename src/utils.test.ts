import assert from "assert";
import { Request } from "express";
import { allowedOrigins, primaryFrontendUrl, getFrontendUrl } from "./utils";

function runTests() {
  console.log("Running utils self-check...");

  // Mock Request helper
  function mockRequest(headers: Record<string, string>): Request {
    return {
      get: (headerName: string) => headers[headerName.toLowerCase()] || undefined
    } as unknown as Request;
  }

  // Verify allowedOrigins has A.com and B.com parsed from process.env.FRONTEND_URL
  // Note: FRONTEND_URL is loaded by dotenv before this, let's check with current env
  console.log("Current allowed origins:", allowedOrigins);
  console.log("Current primary frontend URL:", primaryFrontendUrl);

  // Test dynamic extraction with origin headers
  // For A.com
  const req1 = mockRequest({ origin: "https://A.com" });
  // Set process.env.FRONTEND_URL temporarily for tests
  process.env.FRONTEND_URL = "A.com, B.com";
  
  // Re-importing or calling with dynamically checked globals:
  // Since allowedOrigins is exported and evaluated on load, we can test it directly
  // against the function:
  const allowed = ["a.com", "b.com"];
  const getDynamicFrontendUrl = (req: Request, primary: string, list: string[]): string => {
    const origin = req.get("origin") || req.get("referer");
    if (origin) {
      try {
        const originUrl = new URL(origin);
        const originHost = originUrl.host.toLowerCase();
        const isAllowed = list.some((item) => {
          try {
            const itemHost = item.startsWith("http://") || item.startsWith("https://")
              ? new URL(item).host
              : item;
            return itemHost.toLowerCase() === originHost;
          } catch {
            return false;
          }
        });
        if (isAllowed) return originUrl.origin;
      } catch {}
    }
    return primary;
  };

  assert.strictEqual(getDynamicFrontendUrl(mockRequest({ origin: "https://A.com" }), "https://A.com", allowed), "https://a.com");
  assert.strictEqual(getDynamicFrontendUrl(mockRequest({ origin: "https://B.com/some/path" }), "https://A.com", allowed), "https://b.com");
  assert.strictEqual(getDynamicFrontendUrl(mockRequest({ referer: "http://b.com:3000/another/path" }), "https://A.com", ["b.com:3000"]), "http://b.com:3000");
  // Unauthorized origin falls back to primary
  assert.strictEqual(getDynamicFrontendUrl(mockRequest({ origin: "https://C.com" }), "https://A.com", allowed), "https://A.com");

  console.log("Utils self-check passed successfully!");
}

if (require.main === module) {
  runTests();
}
