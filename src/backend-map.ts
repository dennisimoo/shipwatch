import { gunzipSync } from "node:zlib";
import { db, now } from "./db";
import { extract, type Reference } from "./api-references";
import { hash } from "./detect";
import { sameSite } from "./network";

/** A known outside service, recognised by hostnames referenced in or embedded in client code. */
interface ServiceRule {
  name: string;
  category: string;
  pattern: RegExp;
}

// Small, hand-written rules (not the GPL Wappalyzer data). Patterns match hostnames or SDK markers in bundles.
export const serviceRules: ServiceRule[] = [
  { name: "Supabase", category: "Database", pattern: /\b[a-z0-9-]+\.supabase\.(?:co|in)\b|@supabase\/supabase-js/ },
  { name: "Firebase", category: "Database", pattern: /\b[a-z0-9-]+\.(?:firebaseio\.com|firebaseapp\.com)\b|firestore\.googleapis\.com|identitytoolkit\.googleapis\.com/ },
  { name: "Convex", category: "Database", pattern: /\b[a-z0-9-]+\.convex\.(?:cloud|site)\b/ },
  { name: "Appwrite", category: "Database", pattern: /\bcloud\.appwrite\.io\b/ },
  { name: "Hasura", category: "Database", pattern: /\b[a-z0-9-]+\.hasura\.app\b/ },
  { name: "InstantDB", category: "Database", pattern: /\bapi\.instantdb\.com\b/ },
  { name: "Clerk", category: "Sign-in", pattern: /\bclerk\.[a-z0-9.-]+\.(?:com|dev|app)\b|\.clerk\.accounts\.dev\b|@clerk\/clerk-js/ },
  { name: "Auth0", category: "Sign-in", pattern: /\b[a-z0-9-]+(?:\.[a-z]{2})?\.auth0\.com\b/ },
  { name: "WorkOS", category: "Sign-in", pattern: /\bapi\.workos\.com\b|\bauthkit\.app\b/ },
  { name: "Stytch", category: "Sign-in", pattern: /\b(?:test|api)\.stytch\.com\b/ },
  { name: "Google Sign-In", category: "Sign-in", pattern: /\baccounts\.google\.com\/gsi\b/ },
  { name: "Sign in with Apple", category: "Sign-in", pattern: /\bappleid\.(?:cdn-)?apple\.com\b/ },
  { name: "Stripe", category: "Payments", pattern: /\b(?:js|api|checkout|buy)\.stripe\.com\b/ },
  { name: "Paddle", category: "Payments", pattern: /\bcdn\.paddle\.com\b/ },
  { name: "Lemon Squeezy", category: "Payments", pattern: /\b(?:app|assets)\.lemonsqueezy\.com\b/ },
  { name: "Polar", category: "Payments", pattern: /\b(?:api|sandbox-api)\.polar\.sh\b/ },
  { name: "PostHog", category: "Analytics", pattern: /\b(?:[a-z]{2}\.)?(?:i\.)?posthog\.com\b/ },
  { name: "Google Analytics", category: "Analytics", pattern: /\bwww\.googletagmanager\.com\b|\bgoogle-analytics\.com\b/ },
  { name: "Segment", category: "Analytics", pattern: /\b(?:cdn|api)\.segment\.(?:com|io)\b/ },
  { name: "Mixpanel", category: "Analytics", pattern: /\b(?:api(?:-js)?|cdn)\.mxpnl\.com\b|\bapi(?:-eu)?\.mixpanel\.com\b/ },
  { name: "Amplitude", category: "Analytics", pattern: /\bapi2?\.amplitude\.com\b/ },
  { name: "Microsoft Clarity", category: "Analytics", pattern: /\bwww\.clarity\.ms\b/ },
  { name: "Plausible", category: "Analytics", pattern: /\bplausible\.io\b/ },
  { name: "Vercel Analytics", category: "Analytics", pattern: /\/_vercel\/(?:insights|speed-insights)\// },
  { name: "Meta Pixel", category: "Analytics", pattern: /\bconnect\.facebook\.net\b/ },
  { name: "LinkedIn Insight", category: "Analytics", pattern: /\bsnap\.licdn\.com\b/ },
  { name: "Sentry", category: "Monitoring", pattern: /\bo\d+\.ingest\.(?:[a-z]{2}\.)?sentry\.io\b|\bbrowser\.sentry-cdn\.com\b/ },
  { name: "Datadog", category: "Monitoring", pattern: /\bbrowser-intake-[a-z0-9-]+\.datadoghq\.com\b|\bwww\.datadoghq-browser-agent\.com\b/ },
  { name: "LogRocket", category: "Monitoring", pattern: /\b(?:cdn|r)\.lr-(?:ingest|in|intake)\.(?:io|com)\b/ },
  { name: "Highlight", category: "Monitoring", pattern: /\bpub\.highlight\.(?:run|io)\b/ },
  { name: "OpenAI", category: "AI", pattern: /\bapi\.openai\.com\b/ },
  { name: "Anthropic", category: "AI", pattern: /\bapi\.anthropic\.com\b/ },
  { name: "ElevenLabs", category: "AI", pattern: /\bapi\.elevenlabs\.io\b/ },
  { name: "Deepgram", category: "AI", pattern: /\bapi\.deepgram\.com\b/ },
  { name: "Replicate", category: "AI", pattern: /\bapi\.replicate\.com\b/ },
  { name: "Pusher", category: "Realtime", pattern: /\bws-[a-z0-9]+\.pusher\.com\b|\bsockjs-[a-z0-9]+\.pusher\.com\b/ },
  { name: "Ably", category: "Realtime", pattern: /\b(?:realtime|rest)\.ably\.io\b/ },
  { name: "Liveblocks", category: "Realtime", pattern: /\bapi\.liveblocks\.io\b/ },
  { name: "LiveKit", category: "Realtime", pattern: /\b[a-z0-9-]+\.livekit\.cloud\b/ },
  { name: "Intercom", category: "Support", pattern: /\bwidget\.intercom\.io\b|\bapi-iam\.intercom\.io\b/ },
  { name: "Crisp", category: "Support", pattern: /\bclient\.crisp\.chat\b/ },
  { name: "Algolia", category: "Search", pattern: /\b[a-z0-9]+-dsn\.algolia\.net\b|\.algolianet\.com\b/ },
  { name: "Mapbox", category: "Maps", pattern: /\bapi\.mapbox\.com\b/ },
  { name: "Google Maps", category: "Maps", pattern: /\bmaps\.googleapis\.com\b/ },
  { name: "Cloudinary", category: "Media", pattern: /\bres\.cloudinary\.com\b/ },
  { name: "Mux", category: "Media", pattern: /\bstream\.mux\.com\b/ },
  { name: "UploadThing", category: "Media", pattern: /\butfs\.io\b|\bufs\.sh\b/ },
  { name: "LaunchDarkly", category: "Feature flags", pattern: /\b(?:app|clientstream|events)\.launchdarkly\.com\b/ },
  { name: "Statsig", category: "Feature flags", pattern: /\b(?:featuregates|api)\.statsig\.com\b|\bstatsigapi\.net\b/ },
  { name: "Cloudflare Turnstile", category: "Bot protection", pattern: /\bchallenges\.cloudflare\.com\b/ },
  { name: "reCAPTCHA", category: "Bot protection", pattern: /\bwww\.google\.com\/recaptcha\b|\bwww\.recaptcha\.net\b/ },
  { name: "Typeform", category: "Forms", pattern: /\bform\.typeform\.com\b|\bembed\.typeform\.com\b/ },
  { name: "Cal.com", category: "Scheduling", pattern: /\bapp\.cal\.com\b/ },
  { name: "Calendly", category: "Scheduling", pattern: /\b(?:assets\.)?calendly\.com\b/ },
];

const frameworkRules: [string, RegExp][] = [
  ["Next.js", /\/_next\/static\//],
  ["Nuxt", /\/_nuxt\//],
  ["Astro", /\/_astro\//],
  ["SvelteKit", /\/_app\/immutable\//],
  ["Gatsby", /\/(?:webpack-runtime|framework)-[a-f0-9]{8,}\.js/],
  ["Vite", /\/assets\/[\w-]+-[A-Za-z0-9_-]{8}\.(?:m?js|css)$/],
];

const callTypes = /^(?:fetch|XMLHttpRequest\.open|\$\.(?:get|post|ajax|getJSON)|axios(?:\.\w+)?|ky(?:\.\w+)?|ofetch)$/;
const navigationTypes = /^(?:locationAssignment|locationReplacement|window\.open|location\.href)$/;

export interface Endpoint { path: string; methods: string[]; params: string[] }
export interface ApiHost { origin: string; firstParty: boolean; endpoints: Endpoint[] }
export interface BackendMap {
  url: string;
  hosting: string[];
  frameworks: string[];
  pages: string[];
  apis: ApiHost[];
  services: { name: string; category: string }[];
  otherHosts: string[];
  graphql: string[];
  websockets: string[];
  sourceMaps: number;
  bundles: number;
  incomplete: boolean;
  generatedAt: number;
}

/** Turns concrete or templated paths into stable route shapes: /users/EXPR/42 → /users/:id/:id. */
export function routeShape(path: string): string {
  return (path.split(/[?#]/)[0] || "/")
    .replace(/EXPR/g, ":id")
    .split("/")
    .map((segment) =>
      /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24,}|:id)$/i.test(segment)
        ? ":id"
        : segment.includes(":id") ? ":id" : segment,
    )
    .join("/")
    .replace(/\/+$/, "") || "/";
}

/** Page routes from Next.js chunk names (app router) and the public pages-router build manifest. */
export function nextRoutes(assetUrls: string[], manifests: string[]): string[] {
  const routes = new Set<string>();
  for (const address of assetUrls) {
    const match = /\/_next\/static\/chunks\/app\/(.*?)\/?(?:page|layout)-[A-Za-z0-9_-]+\.js/.exec(address);
    if (match) {
      const route = "/" + decodeURIComponent(match[1]).split("/")
        .filter((segment) => !/^\(.*\)$/.test(segment) && !segment.startsWith("@"))
        .join("/");
      routes.add(route.replace(/\/$/, "") || "/");
    }
  }
  for (const source of manifests)
    for (const match of source.matchAll(/"(\/[^"\s]{0,200})"\s*:\s*\[/g))
      if (!/^\/_(?:app|error|document)$|^\/404$|^\/500$/.test(match[1])) routes.add(match[1]);
  return [...routes].sort();
}

export function graphqlOperations(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/\b(query|mutation|subscription)\s+([A-Z][A-Za-z0-9_]{2,80})\s*[({]/g))
    names.add(`${match[1]} ${match[2]}`);
  return [...names];
}

export function detectServices(text: string): { name: string; category: string }[] {
  return serviceRules.filter((rule) => rule.pattern.test(text)).map(({ name, category }) => ({ name, category }));
}

interface Capture { url: string; evidence: string }

/** Builds a map of what a site's client code talks to, from its latest archived bundles. */
export async function buildBackendMap(companyUrl: string, captures: Capture[], deadline = Date.now() + 25000): Promise<BackendMap> {
  const assetUrls: string[] = [];
  const hosting = new Set<string>();
  const apis = new Map<string, Map<string, { methods: Set<string>; params: Set<string> }>>();
  const pages = new Set<string>();
  const otherHosts = new Set<string>();
  const graphql = new Set<string>();
  const websockets = new Set<string>();
  const manifests: string[] = [];
  let corpus = "";
  let sourceMaps = 0;
  let bundles = 0;
  let incomplete = false;
  for (const capture of captures) {
    const evidence = JSON.parse(capture.evidence) as {
      content?: { url: string; hash: string }[]; hosting?: string[]; uninspected?: string[];
    };
    for (const name of evidence.hosting ?? []) hosting.add(name);
    if (evidence.uninspected?.length) incomplete = true;
    for (const asset of evidence.content ?? []) {
      assetUrls.push(asset.url);
      if (/\.css(?:\?|$)/.test(asset.url)) continue;
      const row = db.query("SELECT body FROM bundle_bodies WHERE hash=?").get(asset.hash) as { body: Uint8Array } | null;
      if (!row) { incomplete = true; continue; }
      bundles++;
      const source = gunzipSync(row.body).toString();
      if (/\/(?:_buildManifest|_ssgManifest)\.js/.test(asset.url)) manifests.push(source);
      if (/[#@]\s*sourceMappingURL=(?!data:)\S+\.map/.test(source)) sourceMaps++;
      for (const name of graphqlOperations(source)) graphql.add(name);
      for (const match of source.matchAll(/["'`](wss?:\/\/[a-z0-9.-]+(?::\d+)?)/gi)) websockets.add(match[1].toLowerCase());
      for (const match of source.matchAll(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}(?:\/[\w./-]{0,60})?|@[a-z-]+\/[a-z-]+-js\b/gi))
        corpus += match[0] + "\n";
      let references: Reference[] = [];
      if (Date.now() < deadline) {
        try { references = await extract(asset.hash); } catch { incomplete = true; }
      } else incomplete = true;
      for (const reference of references) {
        let target: URL;
        try { target = new URL(reference.url, capture.url); } catch { continue; }
        if (!["https:", "http:"].includes(target.protocol)) continue;
        corpus += target.origin + target.pathname + "\n";
        const firstParty = sameSite(companyUrl, target.href);
        const isCall = (reference.type && callTypes.test(reference.type)) ||
          /\/(?:api|graphql|trpc|rpc|v\d+)(?:\/|$)/.test(target.pathname) || /^api\./.test(target.hostname);
        const isPage = !isCall && firstParty && (!reference.type || navigationTypes.test(reference.type)) &&
          !/\.[a-z0-9]{2,5}$/i.test(target.pathname);
        if (isPage) { pages.add(routeShape(target.pathname)); continue; }
        if (!isCall || (/\.(?:json|txt|xml|svg|png|jpe?g|gif|webp|avif|mp3|mp4|webm|woff2?|wasm|glb|gltf|riv|lottie)$/i.test(target.pathname) &&
          !/\/(?:api|v\d+)\//.test(target.pathname))) { if (!firstParty) otherHosts.add(target.hostname); continue; }
        if (!firstParty && detectServices(target.href).length) continue;
        const host = apis.get(target.origin) ?? new Map();
        apis.set(target.origin, host);
        const shape = routeShape(target.pathname);
        const entry = host.get(shape) ?? { methods: new Set<string>(), params: new Set<string>() };
        host.set(shape, entry);
        if (reference.method) entry.methods.add(reference.method.toUpperCase());
        for (const name of [...target.searchParams.keys(), ...reference.queryParams, ...reference.bodyParams])
          if (/^[\w.-]{1,40}$/.test(name) && name !== "EXPR") entry.params.add(name);
      }
    }
  }
  for (const route of nextRoutes(assetUrls, manifests)) pages.add(route);
  const services = detectServices(corpus);
  const known = new Set(services.flatMap((service) =>
    [...otherHosts].filter((hostname) => detectServices(hostname).some((match) => match.name === service.name))));
  const firstPartyOrigin = (origin: string) => sameSite(companyUrl, origin);
  return {
    url: companyUrl,
    hosting: [...hosting],
    frameworks: frameworkRules.filter(([, pattern]) => assetUrls.some((address) => pattern.test(address))).map(([name]) => name).slice(0, 1),
    pages: [...pages].filter((page) => page.length <= 120).sort().slice(0, 60),
    apis: [...apis].map(([origin, endpoints]) => ({
      origin,
      firstParty: firstPartyOrigin(origin),
      endpoints: [...endpoints].map(([path, entry]) => ({
        path, methods: [...entry.methods].sort(), params: [...entry.params].sort().slice(0, 12),
      })).sort((left, right) => left.path.localeCompare(right.path)).slice(0, 150),
    })).sort((left, right) => Number(right.firstParty) - Number(left.firstParty) || right.endpoints.length - left.endpoints.length),
    services,
    otherHosts: [...otherHosts].filter((hostname) => !known.has(hostname) && !sameSite(companyUrl, `https://${hostname}/`)).sort().slice(0, 30),
    graphql: [...graphql].sort().slice(0, 60),
    websockets: [...websockets].sort().slice(0, 10),
    sourceMaps,
    bundles,
    incomplete,
    generatedAt: now(),
  };
}

const building = new Map<string, Promise<BackendMap>>();

/** Cached per company and current capture set; rebuilds only when the latest captures change. */
export async function backendMap(companyId: string): Promise<BackendMap | null> {
  const company = db.query("SELECT url FROM companies WHERE id=?").get(companyId) as { url: string } | null;
  if (!company) return null;
  const captures = db.query(`SELECT b.url,b.evidence FROM bundle_captures b
    JOIN targets t ON t.company_id=b.company_id AND t.url=b.url AND t.enabled=1
    WHERE b.company_id=? AND b.last_seen=(SELECT MAX(last_seen) FROM bundle_captures x WHERE x.company_id=b.company_id AND x.url=b.url)
    ORDER BY b.url`).all(companyId) as Capture[];
  if (!captures.length) return null;
  const key = "backend:" + companyId;
  const version = hash(JSON.stringify(captures.map((capture) => capture.evidence)));
  const saved = db.query("SELECT value FROM metadata WHERE key=?").get(key) as { value: string } | null;
  if (saved) {
    const cached = JSON.parse(saved.value) as { version: string; map: BackendMap };
    if (cached.version === version) return cached.map;
  }
  let pending = building.get(companyId);
  if (!pending) {
    pending = buildBackendMap(company.url, captures).then((map) => {
      db.query("INSERT OR REPLACE INTO metadata VALUES (?,?)").run(key, JSON.stringify({ version, map }));
      return map;
    }).finally(() => building.delete(companyId));
    building.set(companyId, pending);
  }
  return pending;
}
