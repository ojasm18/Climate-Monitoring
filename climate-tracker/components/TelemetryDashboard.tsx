"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Droplets,
  Filter,
  Flame,
  Gauge,
  LayoutGrid,
  LineChart as LineChartIcon,
  Settings2,
  Sparkles,
  Thermometer,
  Wind,
} from "lucide-react";
import { database } from "../lib/firebase/client";
import { onValue, ref } from "firebase/database";
import type { jsPDF as JsPDFType } from "jspdf";

type TelemetryPoint = {
  time: string;
  alert: boolean;
  altitude: number;
  humidity: number;
  light: number;
  pressure: number;
  temp: number;
};

type SensorStatus = "normal" | "warning" | "alert";

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const jitter = (value: number, range: number) =>
  value + (Math.random() * range * 2 - range);

const formatTime = (date: Date) =>
  date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const formatSyncTime = (date: Date) =>
  date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

const formatMetric = (value: number, decimals = 0) =>
  value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

const formatDelta = (current: number, previous: number) => {
  if (!Number.isFinite(previous) || previous === 0) return "0.0%";
  const delta = ((current - previous) / previous) * 100;
  const sign = delta >= 0 ? "+" : "";
  return `${sign}${delta.toFixed(1)}%`;
};

const STATIC_SERIES: TelemetryPoint[] = Array.from(
  { length: 24 },
  (_, index) => {
    const hour = String(index).padStart(2, "0");
    return {
      time: `${hour}:00`,
      alert: false,
      altitude: Number((119.08 + index * 0.1).toFixed(2)),
      humidity: 78 + (index % 5),
      light: 1700 + (index * 10),
      pressure: Number((990.0 + index * 0.5).toFixed(2)),
      temp: Number((30.0 + index * 0.25).toFixed(2)),
    };
  }
);

const nextValues = (seed: Omit<TelemetryPoint, "time">) => ({
  alert: seed.alert,
  altitude: Number(clamp(jitter(seed.altitude, 0.5), 115, 125).toFixed(2)),
  humidity: Math.round(clamp(jitter(seed.humidity, 3), 20, 90)),
  light: Math.round(clamp(jitter(seed.light, 100), 500, 3000)),
  pressure: Number(clamp(jitter(seed.pressure, 5), 950, 1050).toFixed(2)),
  temp: Number(clamp(jitter(seed.temp, 1.2), 0, 50).toFixed(2)),
});

const generateMockSeries = (): TelemetryPoint[] => {
  const now = new Date();
  const points: TelemetryPoint[] = [];
  let seed = {
    alert: false,
    altitude: 119.08,
    humidity: 79,
    light: 1805,
    pressure: 999.02,
    temp: 33.33,
  };

  for (let i = 0; i < 24; i += 1) {
    const stamp = new Date(now.getTime() - (23 - i) * 60 * 60 * 1000);
    seed = nextValues(seed);
    points.push({
      time: formatTime(stamp),
      ...seed,
    });
  }

  return points;
};

const buildNextPoint = (previous: TelemetryPoint) => {
  const seed = {
    alert: previous.alert,
    altitude: previous.altitude,
    humidity: previous.humidity,
    light: previous.light,
    pressure: previous.pressure,
    temp: previous.temp,
  };

  return {
    time: formatTime(new Date()),
    ...nextValues(seed),
  };
};

const statusStyles: Record<SensorStatus, string> = {
  normal:
    "border border-[#2D9C84]/60 text-[#2D9C84] bg-[#0D0D0D]",
  warning:
    "border border-[#FACC15]/60 text-[#FACC15] bg-[#14110A]",
  alert:
    "text-[#0A0A0A] bg-[linear-gradient(180deg,#FACC15_0%,#D4A810_100%)] shadow-[0_4px_12px_rgba(250,204,21,0.2)]",
};

const telemetryLines = [
  { key: "temp", label: "Temp", color: "#3AB89E" },
  { key: "humidity", label: "Humidity", color: "#62D1BE" },
  { key: "light", label: "Light", color: "#D1B146" },
  { key: "pressure", label: "Pressure", color: "#8B8B91" },
  { key: "altitude", label: "Altitude", color: "#2D9C84" },
];

const chartLabelStyle = {
  fill: "#62626B",
  fontSize: 11,
};

// ─── PDF Export ───────────────────────────────────────────────────────────────

const SENSOR_META: {
  key: keyof TelemetryPoint;
  label: string;
  unit: string;
  decimals: number;
  thresholds: { alert?: number; warning?: number };
}[] = [
  { key: "temp",        label: "Temperature",       unit: "°C",    decimals: 1, thresholds: { alert: 40, warning: 35 } },
  { key: "humidity",    label: "Humidity",          unit: "%RH",   decimals: 0, thresholds: { alert: 90, warning: 80 } },
  { key: "light",       label: "Light",             unit: "LUX",   decimals: 0, thresholds: {} },
  { key: "pressure",    label: "Pressure",          unit: "hPa",   decimals: 2, thresholds: {} },
  { key: "altitude",    label: "Altitude",          unit: "m",     decimals: 2, thresholds: {} },
];

function getSensorStatus(key: keyof TelemetryPoint, value: number): SensorStatus {
  const meta = SENSOR_META.find((m) => m.key === key);
  if (!meta) return "normal";
  if (meta.thresholds.alert !== undefined && value > meta.thresholds.alert) return "alert";
  if (meta.thresholds.warning !== undefined && value > meta.thresholds.warning) return "warning";
  return "normal";
}

async function exportTelemetryToPDF(
  series: TelemetryPoint[],
  lastSyncLabel: string,
  connected: boolean,
) {
  // Dynamically import jsPDF so it only loads client-side
  const { jsPDF } = await import("jspdf");

  const doc: JsPDFType = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

  const PAGE_W = 210;
  const MARGIN = 14;
  const CONTENT_W = PAGE_W - MARGIN * 2;
  const now = new Date();
  const reportDate = now.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  const reportTime = now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  // ── Helper utilities ──────────────────────────────────────────────────────
  const hex = (h: string) => {
    const r = parseInt(h.slice(1, 3), 16);
    const g = parseInt(h.slice(3, 5), 16);
    const b = parseInt(h.slice(5, 7), 16);
    return [r, g, b] as [number, number, number];
  };

  const setFill = (color: string) => doc.setFillColor(...hex(color));
  const setStroke = (color: string) => doc.setDrawColor(...hex(color));
  const setTextColor = (color: string) => doc.setTextColor(...hex(color));

  // ── Header band ───────────────────────────────────────────────────────────
  setFill("#101010");
  doc.rect(0, 0, PAGE_W, 36, "F");

  // accent bar
  setFill("#FACC15");
  doc.rect(0, 0, 3, 36, "F");

  setTextColor("#FACC15");
  doc.setFontSize(7);
  doc.setFont("helvetica", "bold");
  doc.text("ENV-MONITOR", MARGIN + 2, 10);

  setTextColor("#FFFFFF");
  doc.setFontSize(15);
  doc.text("Environmental Telemetry Report", MARGIN + 2, 20);

  setTextColor("#62626B");
  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.text(`Generated: ${reportDate}  ${reportTime}`, MARGIN + 2, 29);
  doc.text(
    `Data Source: ${connected ? "Firebase Realtime" : "Simulated (Mock)"}  |  Zone 1  |  Last Sync: ${lastSyncLabel}`,
    MARGIN + 2,
    33.5,
  );

  // ── Section: Current Sensor Readings ─────────────────────────────────────
  let y = 44;

  setTextColor("#2D9C84");
  doc.setFontSize(7);
  doc.setFont("helvetica", "bold");
  doc.text("CURRENT SENSOR READINGS", MARGIN, y);
  y += 4;

  setStroke("#2D9C84");
  doc.setLineWidth(0.3);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  y += 3;

  // Table header
  const COLS = [52, 24, 22, 26, 22, 32];
  const COL_HEADERS = ["SENSOR", "VALUE", "UNIT", "STATUS", "TREND", "24H RANGE"];
  let cx = MARGIN;

  setFill("#151515");
  doc.rect(MARGIN, y, CONTENT_W, 6, "F");

  setTextColor("#62626B");
  doc.setFontSize(6.5);
  doc.setFont("helvetica", "bold");
  COLS.forEach((w, i) => {
    doc.text(COL_HEADERS[i], cx + 2, y + 4);
    cx += w;
  });
  y += 6;

  const latest = series[series.length - 1];
  const previous = series[series.length - 2] ?? latest;

  SENSOR_META.forEach((meta, rowIdx) => {
    const val = latest[meta.key] as number;
    const prev = previous[meta.key] as number;
    const status = getSensorStatus(meta.key, val);
    const delta = prev !== 0 ? (((val - prev) / Math.abs(prev)) * 100).toFixed(1) : "0.0";
    const trend = `${Number(delta) >= 0 ? "+" : ""}${delta}%`;

    const allVals = series.map((p) => p[meta.key] as number);
    const minVal = Math.min(...allVals).toFixed(meta.decimals);
    const maxVal = Math.max(...allVals).toFixed(meta.decimals);
    const rangeStr = `${minVal} – ${maxVal}`;

    const statusColor =
      status === "alert" ? "#FACC15" : status === "warning" ? "#FACC15" : "#2D9C84";
    const statusLabel = status === "alert" ? "ALERT" : status === "warning" ? "WARNING" : "NORMAL";

    const rowH = 7;
    setFill(rowIdx % 2 === 0 ? "#111111" : "#0D0D0D");
    doc.rect(MARGIN, y, CONTENT_W, rowH, "F");

    cx = MARGIN;
    doc.setFontSize(7);
    doc.setFont("helvetica", "normal");
    setTextColor("#FFFFFF");
    doc.text(meta.label, cx + 2, y + 4.5); cx += COLS[0];
    doc.text(val.toFixed(meta.decimals), cx + 2, y + 4.5); cx += COLS[1];
    setTextColor("#62626B");
    doc.text(meta.unit, cx + 2, y + 4.5); cx += COLS[2];
    setTextColor(statusColor);
    doc.setFont("helvetica", "bold");
    doc.text(statusLabel, cx + 2, y + 4.5); cx += COLS[3];
    setTextColor(Number(delta) >= 0 ? "#2D9C84" : "#FACC15");
    doc.setFont("helvetica", "normal");
    doc.text(trend, cx + 2, y + 4.5); cx += COLS[4];
    setTextColor("#8B8B91");
    doc.text(rangeStr, cx + 2, y + 4.5);
    y += rowH;
  });

  y += 6;

  // ── Section: 24-Hour Historical Data ─────────────────────────────────────
  setTextColor("#2D9C84");
  doc.setFontSize(7);
  doc.setFont("helvetica", "bold");
  doc.text("24-HOUR HISTORICAL DATA", MARGIN, y);
  y += 4;

  setStroke("#2D9C84");
  doc.setLineWidth(0.3);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  y += 3;

  // History table header
  const HIST_COLS = [18, 22, 22, 22, 26, 26];
  const HIST_HEADERS = ["TIME", "TEMP (°C)", "HUM (%RH)", "LIGHT", "ALT (m)", "PRES (hPa)"];
  let hcx = MARGIN;

  setFill("#151515");
  doc.rect(MARGIN, y, CONTENT_W, 6, "F");

  setTextColor("#62626B");
  doc.setFontSize(6);
  doc.setFont("helvetica", "bold");
  HIST_HEADERS.forEach((h, i) => {
    doc.text(h, hcx + 2, y + 4);
    hcx += HIST_COLS[i];
  });
  y += 6;

  series.forEach((point, rowIdx) => {
    // Add a new page if we're running out of space
    if (y > 270) {
      doc.addPage();
      y = 16;
    }

    const rowH = 6;
    setFill(rowIdx % 2 === 0 ? "#111111" : "#0D0D0D");
    doc.rect(MARGIN, y, CONTENT_W, rowH, "F");

    hcx = MARGIN;
    doc.setFontSize(6.5);
    doc.setFont("helvetica", "normal");

    const cells = [
      point.time,
      point.temp.toFixed(1),
      String(point.humidity),
      String(point.light),
      point.altitude.toFixed(2),
      point.pressure.toFixed(2),
    ];

    cells.forEach((cell, i) => {
      if (i === 0) {
        setTextColor("#62626B");
      } else {
        setTextColor("#FFFFFF");
      }
      doc.text(cell, hcx + 2, y + 4);
      hcx += HIST_COLS[i];
    });
    y += rowH;
  });

  // ── Footer ────────────────────────────────────────────────────────────────
  const totalPages = (doc as unknown as { internal: { getNumberOfPages: () => number } }).internal.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    setFill("#101010");
    doc.rect(0, 287, PAGE_W, 10, "F");
    setTextColor("#62626B");
    doc.setFontSize(6.5);
    doc.setFont("helvetica", "normal");
    doc.text("ENV-MONITOR  |  Climate Telemetry System", MARGIN, 293);
    doc.text(`Page ${i} of ${totalPages}`, PAGE_W - MARGIN, 293, { align: "right" });
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  const fileName = `env-telemetry-${now.toISOString().slice(0, 10)}.pdf`;
  doc.save(fileName);
}

// ─── Dashboard Component ──────────────────────────────────────────────────────

export default function TelemetryDashboard() {
  const [series, setSeries] = useState<TelemetryPoint[]>(STATIC_SERIES);
  const [lastSyncLabel, setLastSyncLabel] = useState("--:--:--");
  const [exporting, setExporting] = useState(false);
  const [activeView, setActiveView] = useState<"dashboard" | "analytics">("dashboard");
  const seriesRef = useRef(series);
  seriesRef.current = series;
  const lastSyncRef = useRef(lastSyncLabel);
  lastSyncRef.current = lastSyncLabel;
  const connected = Boolean(database);

  const [aiFeedback, setAiFeedback] = useState<string>("");

  useEffect(() => {
    if (!series || series.length === 0) return;
    const latestCount = series[series.length - 1];
    if (!latestCount) return;
    
    // Quick 1-liner 
    const prompt = `Provide a single line 5-10 word short summary feedback based on this data: Temp: ${latestCount.temp}C, Hum: ${latestCount.humidity}%, Light: ${latestCount.light}, Pressure: ${latestCount.pressure}. Start with 'AI Status: '`;
    
    fetch("/api/ai-analysis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: prompt }] }),
    }).then(async r => {
       const text = await r.text();
       const lines = text.split("\\n").filter(l => l.startsWith("data: "));
       let fullAns = "";
       for(const l of lines){
         if(l.includes("[DONE]")) break;
         try {
           const parsed = JSON.parse(l.replace("data: ","").trim());
           if(parsed.choices?.[0]?.delta?.content) fullAns += parsed.choices[0].delta.content;
         } catch(e) {}
       }
       if(fullAns) setAiFeedback(fullAns);
    });
  }, [series.length]);

  useEffect(() => {
    setLastSyncLabel(formatSyncTime(new Date()));
    if (!database) {
      setSeries(generateMockSeries());
    }
  }, []);

  useEffect(() => {
    if (!database) return;

    const sensorRef = ref(database, "sensor");
    const unsubscribe = onValue(sensorRef, (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.val();
        setSeries((prev) => {
          const latest = prev[prev.length - 1];
          const nextPoint: TelemetryPoint = {
            time: formatTime(new Date()),
            alert: data.alert ?? latest?.alert ?? false,
            altitude: data.altitude ?? latest?.altitude ?? 0,
            humidity: data.humidity ?? latest?.humidity ?? 0,
            light: data.light ?? latest?.light ?? 0,
            pressure: data.pressure ?? latest?.pressure ?? 0,
            temp: data.temp ?? latest?.temp ?? 0,
          };
          return [...prev.slice(-23), nextPoint];
        });
        setLastSyncLabel(formatSyncTime(new Date()));
      }
    });

    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (database) return;

    const id = setInterval(() => {
      setSeries((prev) => {
        const latest = prev[prev.length - 1] ?? generateMockSeries()[23];
        const nextPoint = buildNextPoint(latest);
        return [...prev.slice(-23), nextPoint];
      });
      setLastSyncLabel(formatSyncTime(new Date()));
    }, 6000);

    return () => clearInterval(id);
  }, []);

  const latest = series[series.length - 1] ?? STATIC_SERIES[STATIC_SERIES.length - 1];
  const previous = series[series.length - 2] ?? latest;
  const sparklineData = series.slice(-12);

  const sensors = useMemo(
    () => [
      {
        key: "temp",
        label: "Temperature",
        unit: "°C",
        value: latest.temp,
        previous: previous.temp,
        status: (latest.temp > 40 ? "alert" : latest.temp > 35 ? "warning" : "normal") as SensorStatus,
        icon: Thermometer,
      },
      {
        key: "humidity",
        label: "Humidity",
        unit: "%RH",
        value: latest.humidity,
        previous: previous.humidity,
        status: (latest.humidity > 90 ? "alert" : latest.humidity > 80 ? "warning" : "normal") as SensorStatus,
        icon: Droplets,
      },
      {
        key: "light",
        label: "Light Level",
        unit: "LUX",
        value: latest.light,
        previous: previous.light,
        status: "normal" as SensorStatus,
        icon: Flame,
      },
      {
        key: "altitude",
        label: "Altitude",
        unit: "m",
        value: latest.altitude,
        previous: previous.altitude,
        status: "normal" as SensorStatus,
        icon: Filter,
      },
      {
        key: "pressure",
        label: "Pressure",
        unit: "hPa",
        value: latest.pressure,
        previous: previous.pressure,
        status: "normal" as SensorStatus,
        icon: Gauge,
      }
    ],
    [
      latest.temp,
      latest.humidity,
      latest.light,
      latest.altitude,
      latest.pressure,
      previous.temp,
      previous.humidity,
      previous.light,
      previous.altitude,
      previous.pressure,
    ]
  );

  return (
    <div className="relative z-10 min-h-screen text-white">
      <div className="flex min-h-screen flex-col md:flex-row">
        <aside className="flex w-full shrink-0 flex-col border-b border-[#1E1E1E] bg-[#101010] px-6 py-8 md:min-h-screen md:w-[240px] md:border-b-0 md:border-r">
          <div className="flex items-center justify-between md:flex-col md:items-start md:gap-10">
            <div className="text-sm font-semibold tracking-[0.32em] text-[#FACC15]">
              ENV-MONITOR
            </div>
            <nav className="flex flex-row gap-4 text-xs font-semibold uppercase tracking-[0.2em] text-[#62626B] md:flex-col md:gap-3">
              <button
                onClick={() => setActiveView("dashboard")}
                className={`flex items-center gap-2 border-l-[2.5px] px-3 py-2 transition-all duration-[350ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] ${
                  activeView === "dashboard"
                    ? "border-[#FACC15] bg-[#141414] text-[#FACC15]"
                    : "border-transparent hover:border-[#2D9C84] hover:text-white"
                }`}
              >
                <LayoutGrid className="h-4 w-4" />
                Dashboard
              </button>
              <button
                onClick={() => setActiveView("analytics")}
                className={`flex items-center gap-2 border-l-[2.5px] px-3 py-2 transition-all duration-[350ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] ${
                  activeView === "analytics"
                    ? "border-[#FACC15] bg-[#141414] text-[#FACC15]"
                    : "border-transparent hover:border-[#2D9C84] hover:text-white"
                }`}
              >
                <LineChartIcon className="h-4 w-4" />
                Analytics
              </button>
              <button className="flex items-center gap-2 border-l-[2.5px] border-transparent px-3 py-2 transition-all duration-[350ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] hover:border-[#2D9C84] hover:text-white">
                <Settings2 className="h-4 w-4" />
                Device Settings
              </button>
            </nav>
          </div>
          <div className="mt-8 flex items-center gap-3 text-xs uppercase tracking-[0.2em] text-[#62626B] md:mt-auto">
            <span
              className={`h-2.5 w-2.5 rounded-full ${
                connected
                  ? "bg-[#2D9C84] shadow-[0_0_12px_rgba(45,156,132,0.8)]"
                  : "bg-[#FACC15] shadow-[0_0_12px_rgba(250,204,21,0.7)]"
              }`}
            />
            System Status
            <span className="text-white">{connected ? "Connected" : "Disconnected"}</span>
          </div>
        </aside>

        <main className="flex-1 px-6 py-8 md:px-10">
          <header className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="flex flex-wrap items-center gap-3 text-xs uppercase tracking-[0.2em] text-[#62626B]">
              <span>Last Sync</span>
              <span className="text-white">{lastSyncLabel}</span>
              <span className="rounded-full border border-[#2D9C84]/50 bg-[#0E0E0E] px-3 py-1 text-[#2D9C84]">
                Zone 1
              </span>
              {aiFeedback && (
                <span className="rounded-full border border-[#FACC15]/50 bg-[#14110A] px-3 py-1 text-[#FACC15] max-w-xl truncate" title={aiFeedback}>
                  ✨ {aiFeedback}
                </span>
              )}
            </div>
            {activeView === "dashboard" && (
              <button
                id="btn-export-pdf"
                disabled={exporting}
                onClick={async () => {
                  setExporting(true);
                  try {
                    await exportTelemetryToPDF(
                      seriesRef.current,
                      lastSyncRef.current,
                      connected,
                    );
                  } finally {
                    setExporting(false);
                  }
                }}
                className="inline-flex items-center justify-center gap-2 rounded-full bg-[linear-gradient(180deg,#FACC15_0%,#D4A810_100%)] px-5 py-2 text-xs font-extrabold uppercase tracking-[0.2em] text-[#0A0A0A] shadow-[0_4px_12px_rgba(250,204,21,0.2)] transition-all duration-[350ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] hover:-translate-y-[2px] disabled:opacity-50 disabled:cursor-not-allowed disabled:translate-y-0"
              >
                {exporting ? (
                  <>
                    <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                    </svg>
                    Generating PDF…
                  </>
                ) : (
                  <>
                    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M12 16V4M12 16l-4-4M12 16l4-4" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M4 20h16" strokeLinecap="round" />
                    </svg>
                    Export PDF
                  </>
                )}
              </button>
            )}
          </header>

          <div className="my-6 h-px w-full bg-[linear-gradient(90deg,transparent_0%,#1E1E1E_20%,#2A2A2A_50%,#1E1E1E_80%,transparent_100%)]" />

          {activeView === "dashboard" ? (
            <>
              <section>
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <p className="text-xs uppercase tracking-[0.2em] text-[#62626B]">
                      Live Telemetry
                    </p>
                    <h1 className="text-2xl font-semibold tracking-[-0.02em]">
                      Environmental Monitoring Grid
                    </h1>
                  </div>
                  <div className="text-xs uppercase tracking-[0.2em] text-[#62626B]">
                    24H Stream
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {sensors.map((sensor) => (
                    <SensorCard
                      key={sensor.key}
                      label={sensor.label}
                      value={sensor.value}
                      unit={sensor.unit}
                      status={sensor.status}
                      trend={formatDelta(sensor.value, sensor.previous)}
                      icon={sensor.icon}
                      sparklineData={sparklineData}
                      sparklineKey={sensor.key as keyof TelemetryPoint}
                    />
                  ))}
                </div>
              </section>

              <section className="mt-8">
                <div className="rounded-[14px] border-[1.5px] border-[#2D9C84] bg-[linear-gradient(180deg,#151515_0%,#0F0F0F_100%)] p-6 shadow-[0_4px_16px_rgba(0,0,0,0.5),_0_8px_32px_rgba(0,0,0,0.35),_inset_0_1px_0_rgba(45,156,132,0.1)]">
                  <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <p className="text-xs uppercase tracking-[0.2em] text-[#62626B]">
                        Historical Overview
                      </p>
                      <h2 className="text-xl font-semibold tracking-[-0.02em]">
                        Multi-Sensor 24 Hour Trend
                      </h2>
                    </div>
                    <div className="flex flex-wrap gap-3 text-xs uppercase tracking-[0.2em] text-[#62626B]">
                      {telemetryLines.map((line) => (
                        <span key={line.key} className="flex items-center gap-2">
                          <span
                            className="h-2.5 w-2.5 rounded-full"
                            style={{ background: line.color }}
                          />
                          {line.label}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="h-[320px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={series} margin={{ top: 12, right: 18, left: 0, bottom: 0 }}>
                        <CartesianGrid stroke="#1F1F1F" strokeDasharray="4 8" />
                        <XAxis dataKey="time" tickLine={false} axisLine={false} tick={chartLabelStyle} />
                        <YAxis
                          tickLine={false}
                          axisLine={false}
                          tick={chartLabelStyle}
                          width={36}
                        />
                        <Tooltip
                          cursor={{ stroke: "#2D9C84", strokeWidth: 1, strokeDasharray: "4 6" }}
                          contentStyle={{
                            background: "#0E0E0E",
                            border: "1px solid #2D9C84",
                            borderRadius: "10px",
                            boxShadow: "0 10px 24px rgba(0,0,0,0.5)",
                            color: "#FFFFFF",
                          }}
                        />
                        {telemetryLines.map((line) => (
                          <Line
                            key={line.key}
                            type="monotone"
                            dataKey={line.key}
                            stroke={line.color}
                            strokeWidth={2}
                            dot={false}
                          />
                        ))}
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </section>
            </>
          ) : (
            <AnalyticsView series={series} latest={latest} connected={connected} />
          )}
        </main>
      </div>
    </div>
  );
}

// ─── Analytics View ───────────────────────────────────────────────────────────

function buildSystemPrompt(series: TelemetryPoint[], latest: TelemetryPoint, connected: boolean): string {
  const previous = series[series.length - 2] ?? latest;
  const dataSource = connected ? "Firebase Realtime" : "Simulated (Mock)";

  const formatRow = (key: keyof TelemetryPoint, label: string, unit: string, decimals: number) => {
    const currentVal = latest[key] as number;
    const prevVal = previous[key] as number;
    const allVals = series.map((p) => p[key] as number);
    const min = Math.min(...allVals).toFixed(decimals);
    const max = Math.max(...allVals).toFixed(decimals);
    const avg = (allVals.reduce((a, b) => a + b, 0) / allVals.length).toFixed(decimals);
    const delta = prevVal !== 0
      ? (((currentVal - prevVal) / Math.abs(prevVal)) * 100).toFixed(1)
      : "0.0";
    return `- ${label}: ${currentVal.toFixed(decimals)} ${unit} (prev: ${prevVal.toFixed(decimals)}, delta: ${Number(delta) >= 0 ? "+" : ""}${delta}%, 24h avg: ${avg}, 24h range: ${min}–${max})`;
  };

  const historyRows = series
    .slice(-6)
    .map((p) => `  [${p.time}] Temp:${p.temp.toFixed(1)}°C Hum:${p.humidity}% Light:${p.light} Alt:${p.altitude.toFixed(2)}m Press:${p.pressure.toFixed(2)}hPa Alert:${p.alert}`)
    .join("\n");

  return `You are an expert environmental monitoring AI analyst embedded in the ENV-MONITOR climate dashboard.
Your job is to analyze the telemetry data below and answer user questions about it clearly and concisely.
Only answer questions related to this dashboard data. If the user asks something unrelated, politely redirect.

DATA SOURCE: ${dataSource}
TOTAL DATA POINTS: ${series.length} readings (24-hour window)
CURRENT TIME: ${new Date().toLocaleString()}

=== CURRENT SENSOR READINGS ===
${formatRow("temp", "Temperature", "°C", 1)}
${formatRow("humidity", "Humidity", "%RH", 0)}
${formatRow("light", "Light Level", "LUX", 0)}
${formatRow("altitude", "Altitude", "m", 2)}
${formatRow("pressure", "Pressure", "hPa", 2)}

=== ALERT STATUS ===
- Temp: ${latest.temp > 40 ? "🚨 ALERT (>40 °C)" : latest.temp > 35 ? "⚠️ WARNING (>35 °C)" : "✅ Normal"}
- Humidity: ${latest.humidity > 90 ? "🚨 ALERT (>90 %)" : latest.humidity > 80 ? "⚠️ WARNING (>80 %)" : "✅ Normal"}
- Alert Flag: ${latest.alert ? "🚨 ACTIVE" : "✅ Normal"}

=== LAST 6 READINGS (RECENT HISTORY) ===
${historyRows}

Respond in plain text. Be concise, factual, and actionable. Use bullet points for structured answers.`;
}

type ChatMessage = { role: "user" | "assistant"; content: string };

function AnalyticsView({
  series,
  latest,
  connected,
}: {
  series: TelemetryPoint[];
  latest: TelemetryPoint;
  connected: boolean;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const sendMessage = async (userText: string) => {
    if (!userText.trim() || loading) return;

    const systemPrompt = buildSystemPrompt(series, latest, connected);
    const userMsg: ChatMessage = { role: "user", content: userText.trim() };
    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);
    setInput("");
    setLoading(true);
    setError(null);

    const apiMessages = [
      { role: "system", content: systemPrompt },
      ...updatedMessages.map((m) => ({ role: m.role, content: m.content })),
    ];

    try {
      const res = await fetch("/api/ai-analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: apiMessages }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error((errData as { error?: string }).error ?? res.statusText);
      }

      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let assistantText = "";

      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") break;
          try {
            const parsed = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
            const delta = parsed?.choices?.[0]?.delta?.content ?? "";
            if (delta) {
              assistantText += delta;
              setMessages((prev) => {
                const copy = [...prev];
                copy[copy.length - 1] = { role: "assistant", content: assistantText };
                return copy;
              });
            }
          } catch {
            // skip malformed SSE lines
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const suggestions = [
    "Summarize current air quality",
    "Are any sensors in alert?",
    "CO2 trend over 24 hours?",
    "Recommendations based on readings",
  ];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-xs uppercase tracking-[0.2em] text-[#62626B]">AI Intelligence</p>
        <h1 className="text-2xl font-semibold tracking-[-0.02em]">Analytics &amp; Insights</h1>
      </div>

      {/* Live snapshot bar */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {SENSOR_META.map((meta) => {
          const val = latest[meta.key] as number;
          const status = getSensorStatus(meta.key, val);
          return (
            <div
              key={meta.key}
              className={`rounded-[10px] border p-3 ${
                status === "alert"
                  ? "border-[#FACC15]/60 bg-[#14110A]"
                  : status === "warning"
                    ? "border-[#FACC15]/40 bg-[#0F0E08]"
                    : "border-[#2D9C84]/30 bg-[#0D0D0D]"
              }`}
            >
              <p className="text-[10px] uppercase tracking-[0.15em] text-[#62626B]">{meta.label}</p>
              <p className={`mt-1 text-lg font-semibold ${status !== "normal" ? "text-[#FACC15]" : "text-white"}`}>
                {val.toFixed(meta.decimals)}
              </p>
              <p className="text-[10px] uppercase tracking-[0.15em] text-[#62626B]">{meta.unit}</p>
            </div>
          );
        })}
      </div>

      {/* Chat panel */}
      <div className="flex flex-col rounded-[14px] border-[1.5px] border-[#2D9C84] bg-[linear-gradient(180deg,#151515_0%,#0F0F0F_100%)] shadow-[0_4px_16px_rgba(0,0,0,0.5),_0_8px_32px_rgba(0,0,0,0.35),_inset_0_1px_0_rgba(45,156,132,0.1)]">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-[#1E1E1E] px-6 py-4">
          <div className="rounded-full border border-[#2D9C84]/40 bg-[#0E0E0E] p-2 text-[#2D9C84]">
            <Sparkles className="h-4 w-4" />
          </div>
          <div>
            <p className="text-sm font-semibold">AI Analyst</p>
            <p className="text-[10px] uppercase tracking-[0.15em] text-[#62626B]">
              Powered by OpenRouter · Context-aware
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2 text-[10px] uppercase tracking-[0.15em] text-[#62626B]">
            <span className="h-2 w-2 rounded-full bg-[#2D9C84] shadow-[0_0_8px_rgba(45,156,132,0.8)]" />
            Live data
          </div>
        </div>

        {/* Messages area */}
        <div className="flex min-h-[320px] max-h-[480px] flex-col gap-4 overflow-y-auto px-6 py-5">
          {messages.length === 0 && !loading && (
            <div className="flex flex-col items-center justify-center gap-6 py-8 text-center">
              <div className="rounded-full border border-[#2D9C84]/20 bg-[#0E0E0E] p-5">
                <Sparkles className="h-8 w-8 text-[#2D9C84]" />
              </div>
              <div>
                <p className="text-sm font-semibold text-white">Ask about your sensor data</p>
                <p className="mt-1 text-xs text-[#62626B]">
                  The AI has full context of all current readings and 24h history.
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    onClick={() => sendMessage(s)}
                    className="rounded-full border border-[#2D9C84]/30 bg-[#0D0D0D] px-3 py-1.5 text-xs text-[#2D9C84] transition-all duration-200 hover:border-[#2D9C84] hover:bg-[#101f1c]"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i} className={`flex gap-3 ${msg.role === "user" ? "flex-row-reverse" : ""}`}>
              <div
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold ${
                  msg.role === "user"
                    ? "border-[#FACC15]/40 bg-[#14110A] text-[#FACC15]"
                    : "border-[#2D9C84]/40 bg-[#0E0E0E] text-[#2D9C84]"
                }`}
              >
                {msg.role === "user" ? "U" : "AI"}
              </div>
              <div
                className={`max-w-[80%] rounded-[12px] px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                  msg.role === "user"
                    ? "bg-[#141414] text-white border border-[#FACC15]/20"
                    : "bg-[#0D0D0D] text-[#E0E0E0] border border-[#2D9C84]/20"
                }`}
              >
                {msg.content || (
                  loading && msg.role === "assistant" ? (
                    <span className="inline-flex gap-1 pt-1">
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#2D9C84]" style={{ animationDelay: "0ms" }} />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#2D9C84]" style={{ animationDelay: "150ms" }} />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#2D9C84]" style={{ animationDelay: "300ms" }} />
                    </span>
                  ) : null
                )}
              </div>
            </div>
          ))}

          {error && (
            <div className="rounded-[10px] border border-red-800/40 bg-red-950/30 px-4 py-3 text-xs text-red-400">
              <strong>Error:</strong> {error}
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Quick suggestions when chat has messages */}
        {messages.length > 0 && !loading && (
          <div className="flex flex-wrap gap-2 border-t border-[#1E1E1E] px-6 py-3">
            {suggestions.map((s) => (
              <button
                key={s}
                onClick={() => sendMessage(s)}
                className="rounded-full border border-[#2D9C84]/20 bg-[#0D0D0D] px-3 py-1 text-[10px] uppercase tracking-[0.1em] text-[#62626B] transition-all duration-200 hover:border-[#2D9C84]/50 hover:text-[#2D9C84]"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {/* Input */}
        <div className="flex items-end gap-3 border-t border-[#1E1E1E] px-6 py-4">
          <textarea
            id="ai-chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your sensor data… (Enter to send, Shift+Enter for newline)"
            rows={1}
            disabled={loading}
            className="flex-1 resize-none rounded-[10px] border border-[#2D9C84]/30 bg-[#0D0D0D] px-4 py-3 text-sm text-white placeholder-[#62626B] outline-none transition-all duration-200 focus:border-[#2D9C84] focus:shadow-[0_0_0_2px_rgba(45,156,132,0.15)] disabled:opacity-50"
            style={{ minHeight: "44px", maxHeight: "140px" }}
            onInput={(e) => {
              const t = e.currentTarget;
              t.style.height = "auto";
              t.style.height = `${Math.min(t.scrollHeight, 140)}px`;
            }}
          />
          <button
            id="ai-send-btn"
            onClick={() => sendMessage(input)}
            disabled={loading || !input.trim()}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] bg-[linear-gradient(180deg,#2D9C84_0%,#1E7A65_100%)] text-white shadow-[0_4px_12px_rgba(45,156,132,0.3)] transition-all duration-200 hover:-translate-y-[1px] hover:shadow-[0_6px_16px_rgba(45,156,132,0.4)] disabled:opacity-40 disabled:translate-y-0 disabled:cursor-not-allowed"
          >
            {loading ? (
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
              </svg>
            ) : (
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M22 2L11 13" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M22 2L15 22l-4-9-9-4 20-7z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function SensorCard({
  label,
  value,
  unit,
  status,
  trend,
  icon: Icon,
  sparklineData,
  sparklineKey,
}: {
  label: string;
  value: number;
  unit: string;
  status: SensorStatus;
  trend: string;
  icon: typeof Wind;
  sparklineData: TelemetryPoint[];
  sparklineKey: keyof TelemetryPoint;
}) {
  const isAlert = status === "alert";
  const isWarning = status === "warning";
  const cardBorder = isAlert
    ? "border-[#FACC15] animate-[alertPulse_2.6s_ease-in-out_infinite]"
    : "border-[#2D9C84]";
  const cardShadow = isAlert
    ? "shadow-[0_6px_20px_rgba(0,0,0,0.6),_0_0_20px_rgba(250,204,21,0.4),_inset_0_1px_0_rgba(255,255,255,0.22)]"
    : "shadow-[0_4px_16px_rgba(0,0,0,0.5),_0_8px_32px_rgba(0,0,0,0.35),_inset_0_1px_0_rgba(45,156,132,0.1)]";

  return (
    <div
      className={`group flex flex-col gap-4 rounded-[14px] border-[1.5px] bg-[linear-gradient(180deg,#151515_0%,#0F0F0F_100%)] p-5 transition-all duration-[350ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] ${cardBorder} ${cardShadow} hover:-translate-y-[3px] hover:border-[#3AB89E] hover:shadow-[0_8px_24px_rgba(0,0,0,0.6),_0_0_18px_rgba(58,184,158,0.35)]`}
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[11px] uppercase tracking-[0.2em] text-[#62626B]">
            {label}
          </p>
          <div className="mt-1 text-xs uppercase tracking-[0.2em]">
            <span className={`rounded-full px-2 py-1 ${statusStyles[status]}`}>
              {isAlert ? "Alert" : isWarning ? "Warning" : "Normal"}
            </span>
          </div>
        </div>
        <div className="rounded-full border border-[#2D9C84]/40 bg-[#0E0E0E] p-2 text-[#2D9C84] transition-all duration-[350ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] group-hover:border-[#3AB89E] group-hover:text-[#3AB89E]">
          <Icon className="h-5 w-5" />
        </div>
      </div>

      <div className="flex items-baseline gap-3">
        <span className="text-3xl font-semibold tracking-[-0.02em]">
          {sparklineKey === "pressure" || sparklineKey === "altitude"
            ? formatMetric(value, 2)
            : sparklineKey === "temp"
              ? formatMetric(value, 1)
              : formatMetric(value)}
        </span>
        <span className="text-xs uppercase tracking-[0.2em] text-[#62626B]">
          {unit}
        </span>
      </div>

      <div className="flex items-center justify-between gap-3">
        <span className="text-xs uppercase tracking-[0.2em] text-[#62626B]">
          {trend} from last hour
        </span>
        <div className="h-10 w-24">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={sparklineData}>
              <Line
                type="monotone"
                dataKey={sparklineKey}
                stroke={isAlert ? "#FACC15" : "#2D9C84"}
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
