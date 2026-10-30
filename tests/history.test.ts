import { expect, test } from "bun:test";
import { releaseHistory } from "../src/history";

const timestamp = Date.parse("2026-10-29T20:00:00Z") / 1000;

test("daily history distinguishes missing observations from observed zero releases", () => {
  const result = releaseHistory(
    Date.parse("2026-10-25T12:00:00Z") / 1000,
    [
      { day: "2026-10-25", successes: 10 },
      { day: "2026-10-26", successes: 20 },
      { day: "2026-10-28", successes: 40 },
      { day: "2026-10-29", successes: 15 },
    ],
    [
      { day: "2026-10-25", releases: 5 },
      { day: "2026-10-26", releases: 4 },
      { day: "2026-10-29", releases: 3 },
    ],
    timestamp,
  );
  expect(result.days).toHaveLength(30);
  expect(
    result.days.find((day) => day.day === "2026-10-24")?.releases,
  ).toBeNull();
  expect(
    result.days.find((day) => day.day === "2026-10-27")?.releases,
  ).toBeNull();
  expect(result.days.find((day) => day.day === "2026-10-28")?.releases).toBe(0);
  expect(result.observedDays).toBe(2);
  expect(result.comparableReleases).toBe(4);
  expect(result.releasesPerDay).toBe(2);
  expect(result.total).toBe(12);
});

test("new and unbaselined sites do not fabricate a zero release rate", () => {
  expect(releaseHistory(null, [], [], timestamp).releasesPerDay).toBeNull();
  const result = releaseHistory(
    timestamp - 60,
    [{ day: "2026-10-29", successes: 1 }],
    [],
    timestamp,
  );
  expect(result.releasesPerDay).toBeNull();
  expect(result.observedDays).toBe(0);
});
