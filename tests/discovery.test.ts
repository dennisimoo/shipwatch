import { expect, test } from "bun:test";

process.env.DATABASE_PATH = ":memory:";
const { optionsFrom, pageLinks, recommend, selectedUrls } =
  await import("../src/discovery");

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

test("discovery follows actual links using public-suffix boundaries, not subdomain names", () => {
  const page = pageLinks(
    `<title>Acme</title><body><a href="https://console.acme.co.uk/login">Open product</a>
    <a href="https://console.acme.co.uk/signup">Sign up</a><a href="https://docs.acme.co.uk">Docs</a>
    <a href="https://other.co.uk">Other company</a><a href="javascript:alert(1)">Bad</a><script>secretNoise</script></body>`,
    "https://acme.co.uk",
  );
  expect(page.links.map((link) => link.url)).toEqual([
    "https://console.acme.co.uk/login",
    "https://docs.acme.co.uk/",
  ]);
  expect(page.title).toBe("Acme");
  expect(page.text).not.toContain("secretNoise");
  expect(
    pageLinks(
      '<a href="https://other.github.io">Other tenant</a>',
      "https://acme.github.io",
    ).links,
  ).toEqual([]);
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
