import re

with open('climate-tracker/components/TelemetryDashboard.tsx', 'r', encoding='utf-8') as f:
    data = f.read()

# Imports
data = data.replace('import { supabaseClient } from "../lib/supabase/client";', 
'''import { database } from "../lib/firebase/client";
import { ref, onValue } from "firebase/database";''')

# TelemetryPoint
data = re.sub(r'type TelemetryPoint = \{.*?AQI\n\};\n', '''type TelemetryPoint = {
  time: string;
  alert: boolean;
  altitude: number;
  humidity: number;
  light: number;
  pressure: number;
  temp: number;
};
''', data, flags=re.DOTALL)

data = re.sub(r'type TelemetryPoint = \{.*?\};', '''type TelemetryPoint = {
  time: string;
  alert: boolean;
  altitude: number;
  humidity: number;
  light: number;
  pressure: number;
  temp: number;
};''', data, flags=re.DOTALL)

# STATIC_SERIES
data = re.sub(r'const STATIC_SERIES: TelemetryPoint\[\] = Array\.from\([\s\S]*?\n\);\n', '''const STATIC_SERIES: TelemetryPoint[] = Array.from(
  { length: 24 },
  (_, index) => {
    const hour = String(index).padStart(2, "0");
    return {
      time: `${hour}:00`,
      alert: false,
      altitude: Number((119.08 + index * 0.1).toFixed(2)),
      humidity: 75 + (index % 5),
      light: 1700 + (index * 10),
      pressure: Number((990.0 + index * 0.5).toFixed(2)),
      temp: Number((30.0 + index * 0.25).toFixed(2)),
    };
  }
);
''', data)

data = re.sub(r'const nextValues = .*?\}\);', '''const nextValues = (seed: Omit<TelemetryPoint, "time">) => ({
  alert: seed.alert,
  altitude: seed.altitude + Math.random() * 0.5 - 0.25,
  humidity: Math.round(seed.humidity + Math.random() * 4 - 2),
  light: Math.max(0, seed.light + Math.random() * 100 - 50),
  pressure: seed.pressure + Math.random() * 2 - 1,
  temp: seed.temp + Math.random() * 1 - 0.5,
});''', data, flags=re.DOTALL)

data = re.sub(r'const generateMockSeries = \(\): TelemetryPoint\[\] => \{[\s\S]*?return points;\n\};', '''const generateMockSeries = (): TelemetryPoint[] => {
  const now = new Date();
  const points: TelemetryPoint[] = [];
  let seed = {
    alert: false,
    altitude: 119.0,
    humidity: 79,
    light: 1805,
    pressure: 999.0,
    temp: 33.3,
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
};''', data)

data = re.sub(r'const buildNextPoint = \(previous: TelemetryPoint\) => \{[\s\S]*?\}\);[\s\S]*?\};', '''const buildNextPoint = (previous: TelemetryPoint) => {
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
};''', data)


data = re.sub(r'const mapRealtimePayload = [\s\S]*?^\};\n\nconst statusStyles', '''
const statusStyles''', data, flags=re.MULTILINE | re.DOTALL)

data = re.sub(r'const telemetryLines = \[[^\]]*\];', '''const telemetryLines = [
  { key: "temp", label: "Temperature", color: "#FACC15" },
  { key: "humidity", label: "Humidity", color: "#3AB89E" },
  { key: "light", label: "Light", color: "#8B8B91" },
  { key: "altitude", label: "Altitude", color: "#2D9C84" },
  { key: "pressure", label: "Pressure", color: "#D1B146" },
];''', data)


data = re.sub(r'const SENSOR_META: \{[^\]]*\];', '''const SENSOR_META: {
  key: keyof TelemetryPoint;
  label: string;
  unit: string;
  decimals: number;
  thresholds: { alert?: number; warning?: number };
}[] = [
  { key: "temp",         label: "Temperature", unit: "°C",   decimals: 1, thresholds: { alert: 40, warning: 35 } },
  { key: "humidity",     label: "Humidity",    unit: "%RH",  decimals: 0, thresholds: { alert: 90, warning: 80 } },
  { key: "light",        label: "Light Level", unit: "LUX",  decimals: 0, thresholds: {} },
  { key: "altitude",     label: "Altitude",    unit: "m",    decimals: 2, thresholds: {} },
  { key: "pressure",     label: "Pressure",    unit: "hPa",  decimals: 2, thresholds: {} },
];''', data)


data = re.sub(r'const HIST_COLS = \[.*?\];\n  const HIST_HEADERS = \[.*?\];', '''const HIST_COLS = [18, 22, 22, 22, 26, 26];
  const HIST_HEADERS = ["TIME", "TEMP (°C)", "HUM (%RH)", "LIGHT", "ALT (m)", "PRES (hPa)"];''', data)

data = re.sub(r'const cells = \[[^\]]*\];', '''const cells = [
      point.time,
      point.temp.toFixed(1),
      String(point.humidity),
      String(point.light),
      point.altitude.toFixed(2),
      point.pressure.toFixed(2),
    ];''', data)


data = re.sub(r'const connected = Boolean\(supabaseClient\);', 'const connected = Boolean(database);', data)
data = re.sub(r'setSeries\(generateMockSeries\(\)\);\n\s*\}\n\s*\}, \[\]\);', '''setSeries(generateMockSeries());
    }
  }, []);

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
       // SSE format comes back
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
  }, [series.length]);''', data)

# Supabase hook to firebase
old_supabase_hook = '''useEffect(() => {
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
  }, []);'''

new_firebase_hook = '''useEffect(() => {
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
          // Don't duplicate times in a real app, but this acts as an append log
          return [...prev.slice(-23), nextPoint];
        });
        setLastSyncLabel(formatSyncTime(new Date()));
      }
    });

    return () => {
      unsubscribe();
    };
  }, []);'''

data = data.replace(old_supabase_hook, new_firebase_hook)

# if (supabaseClient) return; to if (database) return;
data = data.replace('if (supabaseClient) return;', 'if (database) return;')

# sensors list
data = re.sub(r'const co2Status: SensorStatus[\s\S]*?const sensors = useMemo\([\s\S]*?\]\n  \);\n', '''const sensors = useMemo(
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
        icon: Sun,
      },
      {
        key: "altitude",
        label: "Altitude",
        unit: "m",
        value: latest.altitude,
        previous: previous.altitude,
        status: "normal" as SensorStatus,
        icon: Mountain,
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
  );''', data)

data = re.sub(r'<span className="text-white">\{lastSyncLabel\}</span>[\s\S]*?</span>', '''<span className="text-white">{lastSyncLabel}</span>
              <span className="rounded-full border border-[#2D9C84]/50 bg-[#0E0E0E] px-3 py-1 text-[#2D9C84]">
                Zone 1
              </span>
              {aiFeedback && (
                <span className="rounded-full border border-[#FACC15]/50 bg-[#14110A] px-3 py-1 text-[#FACC15] max-w-xl truncate" title={aiFeedback}>
                  ✨ {aiFeedback}
                </span>
              )}''', data)


data = re.sub(r'\$\{formatRow\("co2", "CO2 Concentration", "PPM", 0\)\}[\s\S]*?\$\{formatRow\("aqi", "Air Quality Index", "AQI", 0\)\}', '''${formatRow("temp", "Temperature", "°C", 1)}
${formatRow("humidity", "Humidity", "%RH", 0)}
${formatRow("light", "Light Level", "LUX", 0)}
${formatRow("altitude", "Altitude", "m", 2)}
${formatRow("pressure", "Pressure", "hPa", 2)}''', data)

data = re.sub(r'- CO2: \$\{latest\.co2 > 1000 \? "⚠️ ALERT \(>1000 PPM\)" : "✅ Normal"\}[\s\S]*?- AQI: \$\{latest\.aqi > 100 \? "⚠️ Unhealthy" : latest\.aqi > 50 \? "⚠️ Moderate" : "✅ Good"\}', '''- Temp: ${latest.temp > 40 ? "🚨 ALERT (>40 °C)" : latest.temp > 35 ? "⚠️ WARNING (>35 °C)" : "✅ Normal"}
- Humidity: ${latest.humidity > 90 ? "🚨 ALERT (>90 %)" : latest.humidity > 80 ? "⚠️ WARNING (>80 %)" : "✅ Normal"}
- Alert Flag: ${latest.alert ? "🚨 ACTIVE" : "✅ Normal"}''', data)

data = re.sub(r'const historyRows = series\n    \.slice\(-6\)\n    \.map\(\(p\) => .*?\)\n    \.join\("\\n"\);', r'''const historyRows = series
    .slice(-6)
    .map((p) => `  [${p.time}] Temp:${p.temp.toFixed(1)}°C Hum:${p.humidity}% Light:${p.light} Alt:${p.altitude.toFixed(2)}m Press:${p.pressure.toFixed(2)}hPa Alert:${p.alert}`)
    .join("\\n");''', data)

with open('climate-tracker/components/TelemetryDashboard.tsx', 'w', encoding='utf-8') as f:
    f.write(data)
