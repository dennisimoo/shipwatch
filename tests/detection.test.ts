import { describe, expect, test } from "bun:test";
import { extractScripts, hash } from "../src/detect";
import { apiSchema, normalizeUrl, publicAddress, robotsAllowed, sameSite } from "../src/network";

describe("public website boundary", () => {
  test("blocks private, metadata, mapped IPv6, and reserved destinations", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.1.1",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.100.100.200",
      "0.0.0.0",
      "::1",
      "::ffff:127.0.0.1",
      "fc00::1",
      "2001:db8::1",
      "224.0.0.1",
    ]) {
      expect(publicAddress(address)).toBe(false);
    }
    expect(publicAddress("8.8.8.8")).toBe(true);
    expect(publicAddress("2606:4700:4700::1111")).toBe(true);
  });
  test("accepts only HTTP websites without credentials or unusual ports", () => {
    expect(normalizeUrl("example.com").href).toBe("https://example.com/");
    expect(normalizeUrl("  example.com  ").href).toBe("https://example.com/");
    for (const input of [
      "ftp://example.com",
      "https://user:password@example.com",
      "https://example.com:8080",
      "http://localhost",
    ]) {
      expect(() => normalizeUrl(input)).toThrow();
    }
  });
});

describe("script discovery", () => {
  test("sibling bundles stay inside registrable and private-suffix boundaries", async () => {
    expect(await extractScripts('<script src="https://cdn.example.co.uk/app.js"></script><script src="https://other.co.uk/app.js"></script>', "https://app.example.co.uk/"))
      .toEqual(["https://cdn.example.co.uk/app.js"]);
    expect(sameSite("https://alice.github.io/", "https://bob.github.io/app.js")).toBe(false);
    expect(sameSite("https://app.example.com/", "https://example.com.evil.com/app.js")).toBe(false);
    expect(apiSchema('{"openapi":"3.1.0","paths":{}}')).toBe(true);
    expect(apiSchema('{"timestamp":123}')).toBe(false);
  });
  test("ignores markup noise, third-party scripts, duplicate URLs and analytics", async () => {
    const html = `<script src="/app-aabbccdd.js"></script><script src='/app-aabbccdd.js'></script>
      <link rel="modulepreload" href="https://cdn.example.com/chunk.js">
      <script src="https://analytics.example.com/analytics.js"></script>
      <script src="https://other.com/widget.js"></script><p>Random nonce 123</p>`;
    expect(await extractScripts(html, "https://www.example.com/")).toEqual([
      "https://cdn.example.com/chunk.js",
      "https://www.example.com/app-aabbccdd.js",
    ]);
  });
  test("handles encoded attributes and unquoted script sources", async () => {
    expect(
      await extractScripts(
        "<script src=/main.js?v=1&amp;x=2></script>",
        "https://example.com",
      ),
    ).toEqual(["https://example.com/main.js?v=1&x=2"]);
    expect(hash("stable")).toBe(hash("stable"));
    expect(hash("stable")).not.toBe(hash("changed"));
  });
});

describe("robots rules", () => {
  test("uses specific bot rules and longest matching path", () => {
    expect(robotsAllowed("User-agent: *\nDisallow: /", "/")).toBe(false);
    expect(
      robotsAllowed(
        "User-agent: *\nDisallow: /private\nAllow: /private/public",
        "/private/public/app.js",
      ),
    ).toBe(true);
    expect(
      robotsAllowed(
        "User-agent: *\nDisallow: /\nUser-agent: Shipwatch\nAllow: /",
        "/",
      ),
    ).toBe(true);
    expect(
      robotsAllowed("User-agent: *\nDisallow: /*.js$", "/assets/app.js"),
    ).toBe(false);
    expect(robotsAllowed("User-agent: *\nDisallow:", "/")).toBe(true);
  });
});
