import { expect, test } from "bun:test";
import { chartBuckets, chartExtent } from "../public/chart-data.js";

test("12-hour view crosses midnight and contains twelve hourly buckets", () => {
  const now = Date.parse("2026-10-30T02:30:00Z") / 1000;
  const buckets = chartBuckets([{ detected_at: now - 1800 }], [], null, now, 0.5, "hour", true);
  expect(buckets).toHaveLength(12);
  expect(chartExtent(buckets)).toEqual([
    Date.parse("2026-10-29T15:00:00Z") / 1000,
    Date.parse("2026-10-30T03:00:00Z") / 1000,
  ]);
  expect(buckets.at(-1).count).toBe(1);
});

test("one daily point has a one-day extent, not timestamp-based padding", () => {
  const now = Date.parse("2026-10-29T18:00:00Z") / 1000;
  const buckets = chartBuckets([], [], null, now, 1, "day", true);
  expect(buckets).toHaveLength(1);
  expect(chartExtent(buckets)).toEqual([
    Date.parse("2026-10-29T00:00:00Z") / 1000,
    Date.parse("2026-10-30T00:00:00Z") / 1000,
  ]);
});

test("hourly release bins use all events and distinguish missing dates", () => {
  const now = Date.parse("2026-10-29T02:30:00Z") / 1000;
  const buckets = chartBuckets(
    [{ detected_at: now - 3600 }, { detected_at: now - 3500 }],
    [{ day: "2026-10-29", successes: 5 }],
    now - 7200,
    now,
    1,
    "hour",
    true,
  );
  expect(buckets.map((bucket) => bucket.count)).toEqual([0, 2, 0]);
  expect(buckets[2].partial).toBe(true);
  expect(chartBuckets([], [], null, now, 1, "day", true)[0].count).toBeNull();
});

test("local calendar-day bins respect daylight-saving transitions", () => {
  const original = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    const now = Date.parse("2026-11-02T07:30:00Z") / 1000;
    const buckets = chartBuckets([], [], null, now, 1, "hour", false);
    expect(buckets).toHaveLength(25);
    expect(new Date(buckets[0].start * 1000).getHours()).toBe(0);
    const daily = chartBuckets([], [], null, now, 1, "day", false);
    expect(daily[0].end - daily[0].start).toBe(25 * 3600);
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});
