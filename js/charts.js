// Chart.js wrappers. Chart.js itself is loaded globally via CDN <script> in
// index.html (no build step on this project), so we just use window.Chart.

function themeColor(varName) {
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
}

function makeGradient(ctx, chartArea, hex) {
  if (!chartArea) return hex;
  const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
  gradient.addColorStop(0, colorWithAlpha(hex, 0.45));
  gradient.addColorStop(1, colorWithAlpha(hex, 0.02));
  return gradient;
}

// Accepts hex (#rrggbb) or an already-resolved color-mix/rgb string; falls
// back gracefully since theme vars are plain hex in themes.css.
function colorWithAlpha(hex, alpha) {
  const h = hex.replace("#", "");
  if (h.length !== 6) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

let mainChartInstance = null;

export function createMainChart(canvas, hours, earnings, spend) {
  const Chart = window.Chart;
  const ctx = canvas.getContext("2d");
  const accent = themeColor("--profit") || "#00ff7f";
  const loss = themeColor("--loss") || "#ff4d5e";
  const gridColor = themeColor("--border") || "rgba(255,255,255,0.08)";
  const textColor = themeColor("--text-2") || "#888";

  if (mainChartInstance) {
    mainChartInstance.destroy();
  }

  mainChartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels: hours,
      datasets: [
        {
          label: "Earnings",
          data: earnings,
          borderColor: accent,
          backgroundColor: (context) => makeGradient(context.chart.ctx, context.chart.chartArea, accent),
          borderWidth: 2.5,
          fill: true,
          tension: 0.35,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: accent,
          spanGaps: false,
        },
        {
          label: "Spend",
          data: spend,
          borderColor: loss,
          backgroundColor: (context) => makeGradient(context.chart.ctx, context.chart.chartArea, loss),
          borderWidth: 2,
          borderDash: [4, 3],
          fill: true,
          tension: 0.35,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: loss,
          spanGaps: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 900, easing: "easeOutQuart" },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          labels: { color: textColor, usePointStyle: true, pointStyle: "circle", font: { size: 11 } },
        },
        tooltip: {
          backgroundColor: themeColor("--bg-elevated") || "#151515",
          borderColor: themeColor("--border-strong") || "#333",
          borderWidth: 1,
          titleColor: themeColor("--text-0") || "#fff",
          bodyColor: themeColor("--text-1") || "#ccc",
          padding: 10,
          callbacks: {
            label: (item) => ` ${item.dataset.label}: $${item.parsed.y.toFixed(2)}`,
          },
        },
      },
      scales: {
        x: {
          grid: { color: gridColor, drawTicks: false },
          ticks: { color: textColor, font: { size: 10 }, maxRotation: 0 },
          border: { color: gridColor },
        },
        y: {
          grid: { color: gridColor, drawTicks: false },
          ticks: {
            color: textColor,
            font: { size: 10 },
            callback: (v) => "$" + v,
          },
          border: { display: false },
        },
      },
    },
  });

  return mainChartInstance;
}

// Updates the existing chart's data in place (no destroy/recreate, so none
// of Chart.js's entrance animation replays). Returns false when there's no
// instance yet, so the caller knows to fall back to createMainChart.
export function updateMainChart(hours, earnings, spend) {
  if (!mainChartInstance) return false;
  mainChartInstance.data.labels = hours;
  mainChartInstance.data.datasets[0].data = earnings;
  mainChartInstance.data.datasets[1].data = spend;
  mainChartInstance.update();
  return true;
}

const miniCharts = new Map();

export function createMiniChart(canvas, key, hours, values, colorVarName) {
  const Chart = window.Chart;
  destroyMiniChart(key);
  const color = themeColor(colorVarName) || "#00ff7f";
  const chart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels: hours,
      datasets: [
        {
          data: values,
          borderColor: color,
          backgroundColor: (context) => makeGradient(context.chart.ctx, context.chart.chartArea, color),
          borderWidth: 2,
          fill: true,
          tension: 0.4,
          pointRadius: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 600 },
      plugins: { legend: { display: false }, tooltip: { enabled: true, callbacks: {
        label: (item) => `$${item.parsed.y.toFixed(2)}`,
      } } },
      scales: {
        x: { display: false },
        y: { display: false },
      },
    },
  });
  miniCharts.set(key, chart);
  return chart;
}

export function destroyMiniChart(key) {
  const existing = miniCharts.get(key);
  if (existing) {
    existing.destroy();
    miniCharts.delete(key);
  }
}
