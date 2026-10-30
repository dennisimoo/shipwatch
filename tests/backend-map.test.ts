import { expect, test } from "bun:test";
import { detectServices, graphqlOperations, nextRoutes, routeShape } from "../src/backend-map";
import { immutableAsset } from "../src/detect";
import { checkBackoff, retryAfterSeconds, BackoffError } from "../src/network";

test("route shapes collapse IDs and jsluice expressions", () => {
  expect(routeShape("/api/users/EXPR/posts?limit=10")).toBe("/api/users/:id/posts");
  expect(routeShape("/api/items/42")).toBe("/api/items/:id");
  expect(routeShape("/api/doc/5f2b1c9e-1111-2222-3333-444455556666/")).toBe("/api/doc/:id");
  expect(routeShape("/v1/run-EXPR")).toBe("/v1/:id");
  expect(routeShape("/")).toBe("/");
});

test("Next.js routes come from app-router chunk names and the pages manifest", () => {
  expect(nextRoutes([
    "https://x.com/_next/static/chunks/app/(marketing)/pricing/page-abc123.js",
    "https://x.com/_next/static/chunks/app/page-abc123.js",
    "https://x.com/_next/static/chunks/app/dashboard/%5Bid%5D/page-abc123.js",
  ], ['self.__BUILD_MANIFEST={"/":["a.js"],"/blog/[slug]":["b.js"],"/_app":["c.js"],"/404":[]}'])).toEqual(
    ["/", "/blog/[slug]", "/dashboard/[id]", "/pricing"]);
});

test("services are recognised from hostnames and SDK markers only", () => {
  const names = detectServices("https://abcd.supabase.co/rest/v1\nhttps://us.i.posthog.com/e\nhttps://js.stripe.com/v3\nhttps://example.com/stripe").map((service) => service.name);
  expect(names).toEqual(["Supabase", "Stripe", "PostHog"]);
  expect(detectServices("supabase is great; posthog")).toEqual([]);
});

test("GraphQL operation names are extracted from bundled documents", () => {
  expect(graphqlOperations('const q=gql`query GetViewer { viewer { id } }`;const m="mutation CreatePost($input: X) { a }"'))
    .toEqual(["query GetViewer", "mutation CreatePost"]);
});

test("only hashed assets with long-lived cache headers are treated as immutable", () => {
  const hashed = "https://x.com/_next/static/chunks/main-0123456789abcdef.js";
  expect(immutableAsset(hashed, "public, max-age=31536000, immutable")).toBe(true);
  expect(immutableAsset(hashed, "public, max-age=0, must-revalidate")).toBe(false);
  expect(immutableAsset("https://x.com/app.js", "public, max-age=31536000, immutable")).toBe(false);
  expect(immutableAsset(hashed, "no-cache, max-age=31536000")).toBe(false);
});

test("rate limits and bot challenges become backoff, never content", () => {
  const response = (status: number, headers: Record<string, string>) => ({ status, headers, body: "", url: "https://x.com/", bytes: 0 });
  expect(() => checkBackoff(response(200, { "cf-mitigated": "challenge" }))).toThrow(BackoffError);
  expect(() => checkBackoff(response(429, { "retry-after": "120" }))).toThrow(BackoffError);
  expect(() => checkBackoff(response(503, {}))).not.toThrow();
  expect(() => checkBackoff(response(200, {}))).not.toThrow();
  expect(retryAfterSeconds("120", 900)).toBe(900);
  expect(retryAfterSeconds("7200", 900)).toBe(7200);
  expect(retryAfterSeconds("999999", 900)).toBe(21600);
  expect(retryAfterSeconds(undefined, 600)).toBe(600);
});
