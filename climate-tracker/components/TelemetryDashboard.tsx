"use client";

import { useEffect, useMemo, useState } from "react";
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
  Thermometer,
  Wind,
} from "lucide-react";
import { supabaseClient } from "../lib/supabase/client";

type TelemetryPoint = {
  time: string;
  co2: number;
  co: number;
  pm25: number;
  temperature: number;
  humidity: number;
  aqi: number;
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
      co2: 480 + index * 12,
      co: 8 + (index % 6),
      pm25: Number((0.014 + index * 0.001).toFixed(3)),
      temperature: Number((21.2 + index * 0.25).toFixed(1)),
      humidity: 48 + (index % 10),
      aqi: 55 + index * 2,
    };
  }
);

const nextValues = (seed: Omit<TelemetryPoint, "time">) => ({
  co2: Math.round(clamp(jitter(seed.co2, 60), 10, 1400)),
  co: Math.round(clamp(jitter(seed.co, 18), 0, 200)),
  pm25: Number(clamp(jitter(seed.pm25, 0.015), 0.001, 0.35).toFixed(3)),
  temperature: Number(clamp(jitter(seed.temperature, 1.2), 0, 50).toFixed(1)),
  humidity: Math.round(clamp(jitter(seed.humidity, 3), 20, 90)),
  aqi: Math.round(clamp(jitter(seed.aqi, 8), 10, 180)),
});

const generateMockSeries = (): TelemetryPoint[] => {
  const now = new Date();
  const points: TelemetryPoint[] = [];
  let seed = {
    co2: 540,
    co: 14,
    pm25: 0.018,
    temperature: 23.4,
    humidity: 54,
    aqi: 62,
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
    co2: previous.co2,
    co: previous.co,
    pm25: previous.pm25,
    temperature: previous.temperature,
    humidity: previous.humidity,
    aqi: previous.aqi,
  };

  return {
    time: formatTime(new Date()),
    ...nextValues(seed),
  };
};

const getNumber = (data: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = data[key];
    if (value === null || value === undefined) continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
};

const mapRealtimePayload = (payload: { new?: Record<string, unknown> }) => {
  const raw = payload?.new ?? {};
  const timeValue = raw.created_at ?? new Date().toISOString();
  const timestamp = new Date(String(timeValue));

  const co2 = getNumber(raw, ["co2", "co2_ppm", "co2ppm"]);
  const co = getNumber(raw, ["co", "co_ppm", "coppm"]);
  const pm25 = getNumber(raw, ["pm25", "pm25_mg_m3", "pm25_mgm3"]);
  const temperature = getNumber(raw, ["temperature", "temperature_c", "temp_c"]);
  const humidity = getNumber(raw, ["humidity", "humidity_rh", "humidity_percent"]);
  const aqi = getNumber(raw, ["aqi", "air_quality_index"]);

  if (
    co2 === null &&
    co === null &&
    pm25 === null &&
    temperature === null &&
    humidity === null &&
    aqi === null
  ) {
    return null;
  }

  return {
    time: formatTime(timestamp),
    co2,
    co,
    pm25,
    temperature,
    humidity,
    aqi,
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
  { key: "co2", label: "CO2", color: "#2D9C84" },
  { key: "co", label: "CO", color: "#FACC15" },
  { key: "pm25", label: "PM2.5", color: "#8B8B91" },
  { key: "temperature", label: "Temp", color: "#3AB89E" },
  { key: "humidity", label: "Humidity", color: "#62D1BE" },
  { key: "aqi", label: "AQI", color: "#D1B146" },
];

const chartLabelStyle = {
  fill: "#62626B",
  fontSize: 11,
};

export default function TelemetryDashboard() {
  const [series, setSeries] = useState<TelemetryPoint[]>(STATIC_SERIES);
  const [lastSyncLabel, setLastSyncLabel] = useState("--:--:--");
  const connected = Boolean(supabaseClient);

  useEffect(() => {
    setLastSyncLabel(formatSyncTime(new Date()));
    if (!supabaseClient) {
      setSeries(generateMockSeries());
    }
  }, []);

  useEffect(() => {
    if (!supabaseClient) return;

    const channel = supabaseClient
      .channel("telemetry-stream")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "telemetry" },
        (payload) => {
          const incoming = mapRealtimePayload(payload as { new?: Record<string, unknown> });
          if (!incoming) return;

          setSeries((prev) => {
            const latest = prev[prev.length - 1];
            const nextPoint = {
              time: incoming.time,
              co2: incoming.co2 ?? latest?.co2 ?? 0,
              co: incoming.co ?? latest?.co ?? 0,
              pm25: incoming.pm25 ?? latest?.pm25 ?? 0,
              temperature: incoming.temperature ?? latest?.temperature ?? 0,
              humidity: incoming.humidity ?? latest?.humidity ?? 0,
              aqi: incoming.aqi ?? latest?.aqi ?? 0,
            };

            return [...prev.slice(-23), nextPoint];
          });
          setLastSyncLabel(formatSyncTime(new Date()));
        }
      )
      .subscribe();

    return () => {
      channel.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (supabaseClient) return;

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

  const co2Status: SensorStatus = latest.co2 > 1000 ? "alert" : "normal";
  const coStatus: SensorStatus =
    latest.co > 100 ? "alert" : latest.co > 10 ? "warning" : "normal";

  const sensors = useMemo(
    () => [
      {
        key: "co2",
        label: "CO2 Concentration",
        unit: "PPM",
        value: latest.co2,
        previous: previous.co2,
        status: co2Status,
        icon: Wind,
      },
      {
        key: "co",
        label: "Carbon Monoxide",
        unit: "PPM",
        value: latest.co,
        previous: previous.co,
        status: coStatus,
        icon: Flame,
      },
      {
        key: "pm25",
        label: "PM2.5 Dust",
        unit: "MG/M3",
        value: latest.pm25,
        previous: previous.pm25,
        status: "normal" as SensorStatus,
        icon: Filter,
      },
      {
        key: "temperature",
        label: "Temperature",
        unit: "C",
        value: latest.temperature,
        previous: previous.temperature,
        status: "normal" as SensorStatus,
        icon: Thermometer,
      },
      {
        key: "humidity",
        label: "Humidity",
        unit: "%RH",
        value: latest.humidity,
        previous: previous.humidity,
        status: "normal" as SensorStatus,
        icon: Droplets,
      },
      {
        key: "aqi",
        label: "Air Quality Index",
        unit: "AQI",
        value: latest.aqi,
        previous: previous.aqi,
        status: "normal" as SensorStatus,
        icon: Gauge,
      },
    ],
    [
      latest.aqi,
      latest.co,
      latest.co2,
      latest.humidity,
      latest.pm25,
      latest.temperature,
      previous.aqi,
      previous.co,
      previous.co2,
      previous.humidity,
      previous.pm25,
      previous.temperature,
      co2Status,
      coStatus,
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
              <button className="flex items-center gap-2 border-l-[2.5px] border-[#FACC15] bg-[#141414] px-3 py-2 text-[#FACC15] transition-all duration-[350ms] ease-[cubic-bezier(0.2,0.8,0.2,1)]">
                <LayoutGrid className="h-4 w-4" />
                Dashboard
              </button>
              <button className="flex items-center gap-2 border-l-[2.5px] border-transparent px-3 py-2 transition-all duration-[350ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] hover:border-[#2D9C84] hover:text-white">
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
            </div>
            <button className="inline-flex items-center justify-center gap-2 rounded-full bg-[linear-gradient(180deg,#FACC15_0%,#D4A810_100%)] px-5 py-2 text-xs font-extrabold uppercase tracking-[0.2em] text-[#0A0A0A] shadow-[0_4px_12px_rgba(250,204,21,0.2)] transition-all duration-[350ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] hover:-translate-y-[2px]">
              Export Data
            </button>
          </header>

          <div className="my-6 h-px w-full bg-[linear-gradient(90deg,transparent_0%,#1E1E1E_20%,#2A2A2A_50%,#1E1E1E_80%,transparent_100%)]" />

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
                  sparklineKey={sensor.key}
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
        </main>
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
          {sparklineKey === "pm25"
            ? formatMetric(value, 3)
            : sparklineKey === "temperature"
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
