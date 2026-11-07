import { expect, test } from "bun:test";
import { normalizeBuildMetadata } from "../src/build-metadata";

const oldId = "01a1a535-5124-7f71-9dfc-f35294b95e31";
const newId = "01a1a584-f9b7-7af0-a0bb-02f7230fe23a";

test("PostHog build identifiers normalize but surrounding logic remains", () => {
  const source = (id: string) => `e._posthogReleaseId=e._posthogReleaseId||"${id}";e._posthogChunkIds[n]="${id}";`;
  expect(normalizeBuildMetadata(source(oldId))).toBe(normalizeBuildMetadata(source(newId)));
  expect(normalizeBuildMetadata(source(oldId) + "enable(false);")).not.toBe(normalizeBuildMetadata(source(newId) + "enable(true);"));
  expect(normalizeBuildMetadata(`e.releaseId="${oldId}";`)).not.toBe(normalizeBuildMetadata(`e.releaseId="${newId}";`));
  expect(normalizeBuildMetadata(`e._posthogReleaseId=other||"${oldId}";`)).toContain(oldId);
});

test("Sentry normalization stays within its identified configuration object", () => {
  const source = (id: string, business = "unchanged") => `init({defaultIntegrations:[{name:"NextjsClientStackFrameNormalization"}],release:"${id}"});product({release:"${business}"});`;
  expect(normalizeBuildMetadata(source("a".repeat(40)))).toBe(normalizeBuildMetadata(source("b".repeat(40))));
  expect(normalizeBuildMetadata(source("a".repeat(40), "first"))).not.toBe(normalizeBuildMetadata(source("b".repeat(40), "second")));
  expect(normalizeBuildMetadata(`product({release:"${"a".repeat(40)}"})`)).toContain("a".repeat(40));
  const malformed = 'e._posthogReleaseId="unterminated';
  expect(normalizeBuildMetadata(malformed)).toBe(malformed);
});
