export function chartExtent(buckets) {
  return [buckets[0].start, buckets[buckets.length - 1].end];
}

export function chartBuckets(
  events,
  coverage,
  baseline,
  timestamp,
  days,
  unit,
  utc,
) {
  const current = new Date(timestamp * 1000);
  const start = new Date(current);
  if (days < 1) {
    start.setTime(Math.floor(timestamp / 3600) * 3600000 - (days * 24 - 1) * 3600000);
  } else if (utc) {
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - days + 1);
  } else {
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - days + 1);
  }
  const observed = new Set(
    coverage.filter((day) => day.successes > 0).map((day) => day.day),
  );
  const buckets = [];
  while (start <= current) {
    const end = new Date(start);
    if (unit === "hour") end.setTime(end.getTime() + 3600000);
    else if (utc) end.setUTCDate(end.getUTCDate() + 1);
    else end.setDate(end.getDate() + 1);
    const lower = start.getTime() / 1000;
    const upper = end.getTime() / 1000;
    const utcStart = Math.floor(lower / 86400) * 86400;
    let checked = false;
    for (let day = utcStart; day < Math.min(upper, timestamp + 1); day += 86400)
      if (observed.has(new Date(day * 1000).toISOString().slice(0, 10)))
        checked = true;
    const count = events.filter(
      (event) => event.detected_at >= lower && event.detected_at < upper,
    ).length;
    buckets.push({
      start: lower,
      end: upper,
      count:
        count || (checked && baseline !== null && baseline < upper ? 0 : null),
      partial: upper > timestamp || (baseline !== null && baseline > lower),
    });
    start.setTime(end.getTime());
  }
  return buckets;
}
