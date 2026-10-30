export interface ObservationDay {
  day: string;
  successes: number;
}

export interface ReleaseDay {
  day: string;
  releases: number;
}

export function releaseHistory(
  baseline: number | null,
  coverage: ObservationDay[],
  releases: ReleaseDay[],
  timestamp: number,
) {
  const today = Math.floor(timestamp / 86400) * 86400;
  const days = Array.from({ length: 30 }, (_unused, index) => {
    const start = today - (29 - index) * 86400;
    const day = new Date(start * 1000).toISOString().slice(0, 10);
    const observed =
      baseline !== null &&
      baseline < start + 86400 &&
      coverage.some((entry) => entry.day === day && entry.successes > 0);
    return {
      day,
      releases: observed
        ? (releases.find((entry) => entry.day === day)?.releases ?? 0)
        : null,
      complete:
        observed && baseline !== null && baseline <= start && start < today,
    };
  });
  const comparable = days.filter((day) => day.complete);
  const counted = comparable.reduce(
    (total, day) => total + (day.releases ?? 0),
    0,
  );
  return {
    days,
    observedDays: comparable.length,
    comparableReleases: counted,
    releasesPerDay: comparable.length ? counted / comparable.length : null,
    total: days.reduce((total, day) => total + (day.releases ?? 0), 0),
  };
}
