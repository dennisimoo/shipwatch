import { expect, test } from "bun:test";
import OpenAI from "openai";
import { spyOn } from "bun:test";
import * as network from "../src/network";

process.env.DATABASE_PATH = ":memory:";
const { certificateSubdomains } = await import("../src/subdomains");
const { optionsFrom, pageContent, recommend, selectedUrls, shortlist } =
  await import("../src/discovery");

test("host shortlisting respects the inspection budget and rejects invented hosts", async () => {
  let responseHosts = ["app.acme.com", "api.acme.com"];
  const client = new OpenAI({ apiKey: "test", fetch: async () => Response.json({
    id: "test", object: "response", status: "completed", output: [{ type: "message", role: "assistant",
      content: [{ type: "output_text", text: JSON.stringify({ hosts: responseHosts }), annotations: [] }] }],
  }) });
  const hosts = ["aaa.acme.com", "app.acme.com", "api.acme.com", "test.acme.com"];
  expect(await shortlist(hosts, "https://acme.com", 2, client)).toEqual(responseHosts);
  expect(await shortlist(hosts, "https://acme.com", 0, client)).toEqual([]);
  responseHosts = ["evil.com"];
  await expect(shortlist(hosts, "https://acme.com", 2, client)).rejects.toThrow("Invalid candidate shortlist");
});

test("direct certificate fallback validates and deduplicates in-scope names", async () => {
  const fetch = spyOn(network, "fetchPublic").mockResolvedValue({
    url: "https://crt.sh/", status: 200, headers: {}, bytes: 100,
    body: JSON.stringify([{ name_value: "*.acme.com\nAPP.acme.com\nother.com\nacme.com.evil.com" }]),
  });
  try {
    expect(await certificateSubdomains("acme.com")).toEqual(["app.acme.com"]);
    fetch.mockResolvedValue({ url: "https://crt.sh/", status: 503, headers: {}, bytes: 0, body: "" });
    await expect(certificateSubdomains("acme.com")).rejects.toThrow("unavailable");
  } finally { fetch.mockRestore(); }
});

test("discovery budgets are bounded numbers with a minimum of one", () => {
  expect(optionsFrom({})).toEqual({ domainLimit: 3, candidateLimit: 12 });
  expect(optionsFrom({ domainLimit: 1, candidateLimit: 30 })).toEqual({
    domainLimit: 1,
    candidateLimit: 30,
  });
  for (const value of [0, -1, 11, 1.5, "3", null]) {
    if (value === null) continue;
    expect(() => optionsFrom({ domainLimit: value })).toThrow();
  }
  expect(() => optionsFrom({ candidateLimit: 31 })).toThrow();
});

test("discovery reads page context without using homepage links as subdomain discovery", () => {
  const page = pageContent(
    `<title>Acme</title><body><a href="https://console.acme.co.uk/login">Open product</a>
    <a href="https://console.acme.co.uk/signup">Sign up</a><a href="https://docs.acme.co.uk">Docs</a>
    <a href="https://other.co.uk">Other company</a><a href="javascript:alert(1)">Bad</a><script>secretNoise</script></body>`,
  );
  expect(Object.keys(page).sort()).toEqual(["text", "title"]);
  expect(page.title).toBe("Acme");
  expect(page.text).not.toContain("secretNoise");
});

test("Luna suggestions are capped, while a user can override an inspectable suggestion", () => {
  const candidates = [
    {
      url: "https://acme.com/",
      source: "root",
      title: "Acme",
      text: "",
      probability: 0.2,
      error: null,
    },
    {
      url: "https://console.acme.com/",
      source: "link",
      title: "Acme app",
      text: "",
      probability: 0.99,
      error: null,
    },
    {
      url: "https://mobile.acme.com/",
      source: "link",
      title: "Mobile app",
      text: "",
      probability: 0.9,
      error: null,
    },
    {
      url: "https://blocked.acme.com/",
      source: "link",
      title: "",
      text: "",
      probability: null,
      error: "Blocked",
    },
  ];
  expect(recommend(candidates, 1)).toEqual(["https://console.acme.com/"]);
  const review = {
    name: "Acme",
    url: "https://acme.com",
    options: { domainLimit: 1, candidateLimit: 4 },
    candidates,
    recommended: recommend(candidates, 1),
    discovered: 4,
    inputTokens: 100,
  };
  expect(selectedUrls(review, ["https://acme.com/"])).toEqual([
    "https://acme.com/",
  ]);
  for (const selection of [
    [],
    ["https://acme.com/", "https://console.acme.com/"],
    ["https://evil.example/"],
    ["https://blocked.acme.com/"],
  ])
    expect(() => selectedUrls(review, selection)).toThrow();
  const expanded = {
    ...review,
    options: { ...review.options, domainLimit: 10 },
    candidates: [
      ...candidates,
      { ...candidates[0], url: "https://fourth.acme.com/" },
    ],
  };
  expect(() =>
    selectedUrls(expanded, [
      "https://acme.com/",
      "https://console.acme.com/",
      "https://mobile.acme.com/",
      "https://fourth.acme.com/",
    ]),
  ).toThrow();
});
