import uPlot from "/uplot.js";
import { chartBuckets, chartExtent } from "/chart-data.js";

export function mountChart(result) {
  const container = document.querySelector("#release-chart");
  const state = { days: 0.5 };
  let plot;
  const format = (timestamp) =>
    new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(timestamp * 1000));
  function render() {
    plot?.destroy();
    const unit = state.days < 1 ? "hour" : "day";
    const buckets = chartBuckets(
      result.events,
      result.coverage,
      result.company.baseline_at,
      result.observed_at,
      state.days,
      unit,
      false,
    );
    const readout = document.querySelector("#chart-readout");
    const [periodStart, periodEnd] = chartExtent(buckets);
    document.querySelector(".history-context").textContent =
      `${buckets.reduce((total, bucket) => total + (bucket.count ?? 0), 0)} releases observed in this view.`;
    readout.textContent =
      "Hover or tap to see releases";
    plot = new uPlot(
      {
        width: container.clientWidth,
        height: 290,
        legend: { show: false },
        tzDate: (timestamp) => new Date(timestamp * 1000),
        cursor: { y: false, points: { show: false }, drag: { x: false, y: false } },
        scales: {
          x: {
            time: true,
            range: (_chart, min, max) =>
              min === max || min == null || max == null
                ? [periodStart, periodEnd]
                : [min, max],
          },
          y: {
            range: (_plot, _min, max) => [0, Math.max(1, (max ?? 0) * 1.15)],
          },
        },
        series: [
          {},
          {
            label: "Releases",
            stroke: "#527a9f",
            fill: "#527a9f",
            paths: uPlot.paths.bars({ size: [0.65, 36] }),
            points: { show: false },
          },
        ],
        axes: [
          {
            stroke: "#676767",
            space: state.days > 1 ? 80 : 55,
            ...(unit === "day"
              ? {
                  splits: (chart, _axis, min, max) =>
                    buckets
                      .map((bucket) => (bucket.start + bucket.end) / 2)
                      .filter((timestamp, index) =>
                        timestamp >= min && timestamp <= max &&
                        index % Math.ceil(buckets.length / Math.max(1, chart.width / 70)) === 0,
                      ),
                  values: (_chart, ticks) =>
                    ticks.map((timestamp) =>
                      new Intl.DateTimeFormat(undefined, {
                        month: "short",
                        day: "numeric",
                      }).format(new Date(timestamp * 1000)),
                    ),
                }
              : {
                  ...(state.days < 1 ? {
                    splits: (chart, _axis, min, max) => {
                      const step = Math.ceil(13 / Math.max(1, chart.width / 45));
                      return Array.from({ length: 13 }, (_, index) => min + index * 3600)
                        .filter((timestamp, index) => timestamp <= max && index % step === 0);
                    },
                  } : {}),
                  values: (_chart, ticks) =>
                    ticks.map((timestamp) =>
                      new Intl.DateTimeFormat(undefined, {
                        ...(state.days > 1
                          ? { month: "short", day: "numeric" }
                          : { hour: "numeric" }),
                      }).format(new Date(timestamp * 1000)),
                    ),
                }),
            grid: { show: false },
            ticks: { show: false },
            border: { show: false },
            font: "12px Arial",
            size: 55,
          },
          {
            stroke: "#676767",
            grid: { stroke: "#eeeeeb" },
            ticks: { show: false },
            border: { show: false },
            font: "12px Arial",
            values: (_plot, ticks) =>
              ticks.map((value) =>
                Number.isInteger(value) ? String(value) : "",
              ),
            size: 35,
          },
        ],
        hooks: {
          setCursor: [
            (chart) => {
              const bucket = buckets[chart.cursor.idx];
              if (bucket)
                readout.textContent = `${format(bucket.start)} · ${bucket.count === null ? "No observation data" : bucket.count + " observed releases"}${bucket.partial ? " · partial period" : ""}`;
            },
          ],
        },
      },
      [
        buckets.map((bucket) => (bucket.start + bucket.end) / 2),
        buckets.map((bucket) => bucket.count),
      ],
      container,
    );
    plot.setScale("x", { min: periodStart, max: periodEnd });
    const table = document.querySelector("#chart-data");
    table.replaceChildren();
    for (const bucket of [...buckets].reverse()) {
      const row = table.insertRow();
      row.insertCell().textContent = format(bucket.start);
      row.insertCell().textContent =
        bucket.count === null ? "Not observed" : String(bucket.count);
      row.insertCell().textContent = bucket.partial ? "Partial" : "";
    }
  }
  document.querySelectorAll("[data-chart-days]").forEach((button) =>
    button.addEventListener("click", () => {
      state.days = Number(button.dataset.chartDays);
      document
        .querySelectorAll("[data-chart-days]")
        .forEach((option) =>
          option.setAttribute("aria-pressed", String(option === button)),
        );
      render();
    }),
  );
  new ResizeObserver(() => {
    if (plot) plot.setSize({ width: container.clientWidth, height: 290 });
  }).observe(container);
  render();
}
