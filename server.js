const https = require("https");
const http  = require("http");

// 🔐 Credenciales por variable de entorno (configúralas en Render → Environment)
const TG_TOKEN = process.env.TG_TOKEN || "";
const TG_CHAT  = process.env.TG_CHAT  || "966057563";

const PCT_DEFAULT = 0.01;  // 1% retroceso para confirmar pivote (default)
const MIN_BARS    = 1;
const POLL_MS      = 30 * 1000;
const PORT          = process.env.PORT || 3000;
const HTTP_TIMEOUT_MS = 10 * 1000;

// ══════════════════════════════════════════════════════════════════════
//   📌 INSTRUMENTOS A MONITOREAR — agrega/quita líneas aquí
//   "pct" es opcional: si no se pone, usa PCT_DEFAULT (1%)
// ══════════════════════════════════════════════════════════════════════
const MONITORS = [
  { id: "de40",   pairLabel: "DAX 40 (DE40)",        yahooSymbol: "^GDAXI"   },
  { id: "sp500",  pairLabel: "S&P 500",              yahooSymbol: "^GSPC"    },
  { id: "eurusd", pairLabel: "EUR/USD",              yahooSymbol: "EURUSD=X", pct: 0.003, dailyAnchor: "ny17" },
  { id: "coffee", pairLabel: "Café (Coffee)",        yahooSymbol: "KC=F"     },
  { id: "cacao",  pairLabel: "Cacao (Cocoa)",        yahooSymbol: "CC=F"     },
  { id: "ford",   pairLabel: "Ford Motor Co. (F)",   yahooSymbol: "F"        },
];

// Temporalidades + cuánto histórico pedir al "sembrar" el estado
const TF_DEFS = {
  "1h": { label: "1 Hora",  seconds: 3600,  limit: 800 },
  "4h": { label: "4 Horas", seconds: 14400, limit: 500 },
  "1d": { label: "Diario",  seconds: 86400, limit: 500 },
};

let state       = {};   // state["de40:1h"] = estado persistente del ZigZag
let lastPoll    = null;
let statusLog   = [];
let cycleCount  = 0;
let initialized = false;
let isPolling   = false;

function horaAR(date = new Date()) {
  return date.toLocaleString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
}

function log(type, msg) {
  const ts = horaAR();
  console.log(`[${ts}] [${type}] ${msg}`);
  statusLog.unshift({ ts, type, msg });
  if (statusLog.length > 200) statusLog.pop();
}

// ── HTTP helper con timeout + User-Agent de navegador (Yahoo a veces ──
// bloquea peticiones que no parecen venir de un browser real) ─────────
function fetchJSON(url, timeoutMs = HTTP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept": "application/json",
      },
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("JSON parse")); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout tras ${timeoutMs}ms`)));
    req.on("error", reject);
  });
}

function postJSON(url, body, timeoutMs = HTTP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      },
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout tras ${timeoutMs}ms`)));
    req.on("error", reject);
    req.write(payload); req.end();
  });
}

async function sendTelegram(msg) {
  if (!TG_TOKEN) {
    log("ERROR", "TG_TOKEN no configurado — alerta NO enviada");
    return false;
  }
  try {
    const r = await postJSON(
      `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,
      { chat_id: TG_CHAT, text: msg, parse_mode: "HTML" }
    );
    if (!r.ok) throw new Error(r.description);
    return true;
  } catch (e) {
    log("ERROR", `Telegram: ${e.message}`);
    return false;
  }
}

// ── Yahoo Finance: velas nativas de 1H y Diario ─────────────────────
async function fetchYahooNative(symbol, interval, cfg, sinceMs) {
  const { seconds, limit } = cfg;
  const nowSec = Math.floor(Date.now() / 1000);
  const period1 = sinceMs != null ? Math.floor(sinceMs / 1000) + 1 : nowSec - limit * seconds;

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&period1=${period1}&period2=${nowSec}`;
  const res = await fetchJSON(url);
  const result = res?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo: sin datos para ${symbol} (${res?.chart?.error?.description || "respuesta vacía"})`);

  const ts    = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const { high = [], low = [], close = [] } = quote;

  const nowMs = Date.now();
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    if (high[i] == null || low[i] == null || close[i] == null) continue; // huecos (mercado cerrado)
    if (high[i] === low[i] && low[i] === close[i]) continue; // vela "fantasma": precio repetido plano, mercado cerrado sin trading real
    const t = ts[i] * 1000;
    if (t + seconds * 1000 > nowMs) continue; // excluir vela en formación
    candles.push({ t, h: high[i], l: low[i], c: close[i] });
  }
  candles.sort((a, b) => a.t - b.t);
  return sinceMs != null ? candles : candles.slice(-limit);
}

// ── Velas sintéticas de 4H: agrupa de 4 en 4 las velas de 1H, cerrando ──
// el grupo si hay un salto de tiempo grande (cierre de sesión/mercado). ──
function groupToSynthetic4h(hourly) {
  const groups = [];
  let bucket = [];
  for (const k of hourly) {
    if (bucket.length > 0) {
      const gapSec = (k.t - bucket[bucket.length - 1].t) / 1000;
      if (gapSec > 3600 * 1.5) { groups.push(buildSynthetic(bucket)); bucket = []; }
    }
    bucket.push(k);
    if (bucket.length === 4) { groups.push(buildSynthetic(bucket)); bucket = []; }
  }
  if (bucket.length > 0) groups.push(buildSynthetic(bucket));
  return groups;
}
function buildSynthetic(bucket) {
  return {
    t: bucket[0].t,
    h: Math.max(...bucket.map(k => k.h)),
    l: Math.min(...bucket.map(k => k.l)),
    c: bucket[bucket.length - 1].c,
  };
}

// ── Día de trading forex: agrupa velas de 1H en días que cortan a las ──
// 17:00 hora de Nueva York (convención estándar de forex / TradingView), ──
// no a medianoche UTC como hace la vela diaria nativa de Yahoo. El ──
// horario de verano de EE.UU. se maneja solo, vía Intl con timeZone. ────
function nyTradingDayKey(utcMs) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
  }).formatToParts(new Date(utcMs));
  const get = (type) => parts.find(p => p.type === type).value;
  let y = parseInt(get("year")), m = parseInt(get("month")), d = parseInt(get("day"));
  let h = parseInt(get("hour"));
  if (h === 24) h = 0;
  const dia = new Date(Date.UTC(y, m - 1, d));
  if (h >= 17) dia.setUTCDate(dia.getUTCDate() + 1); // a partir de las 17:00, ya es el día siguiente
  return dia.toISOString().slice(0, 10);
}

function groupToForexDaily(hourly) {
  const groups = [];
  let bucket = [];
  let claveActual = null;
  for (const k of hourly) {
    const clave = nyTradingDayKey(k.t);
    if (claveActual !== null && clave !== claveActual) {
      groups.push(buildSynthetic(bucket));
      bucket = [];
    }
    claveActual = clave;
    bucket.push(k);
  }
  if (bucket.length > 0) groups.push(buildSynthetic(bucket));
  return groups;
}

// ── Velas sintéticas de 4H: agrupa de 4 en 4 las velas de 1H, cerrando ──
// el grupo si hay un salto de tiempo grande (cierre de sesión/mercado). ──
function groupToSynthetic4h(hourly) {
  const groups = [];
  let bucket = [];
  for (const k of hourly) {
    if (bucket.length > 0) {
      const gapSec = (k.t - bucket[bucket.length - 1].t) / 1000;
      if (gapSec > 3600 * 1.5) { groups.push(buildSynthetic(bucket)); bucket = []; }
    }
    bucket.push(k);
    if (bucket.length === 4) { groups.push(buildSynthetic(bucket)); bucket = []; }
  }
  if (bucket.length > 0) groups.push(buildSynthetic(bucket));
  return groups;
}
function buildSynthetic(bucket) {
  return {
    t: bucket[0].t,
    h: Math.max(...bucket.map(k => k.h)),
    l: Math.min(...bucket.map(k => k.l)),
    c: bucket[bucket.length - 1].c,
  };
}

async function fetchCandles(monitor, tfKey, cfg, sinceMs) {
  if (tfKey === "1h") return fetchYahooNative(monitor.yahooSymbol, "60m", cfg, sinceMs);
  if (tfKey === "1d") {
    if (monitor.dailyAnchor === "ny17") {
      // Vela diaria propia, cortada a las 17:00 NY — no la nativa de Yahoo.
      const hourlyCfg = { seconds: 3600, limit: cfg.limit * 24 };
      const hourly  = await fetchYahooNative(monitor.yahooSymbol, "60m", hourlyCfg, sinceMs);
      const grouped = groupToForexDaily(hourly);
      // Se descarta siempre el grupo del día de trading actual (todavía en curso).
      const nowKey = nyTradingDayKey(Date.now());
      const cerrados = grouped.filter(g => nyTradingDayKey(g.t) !== nowKey);
      return sinceMs != null ? cerrados : cerrados.slice(-cfg.limit);
    }
    return fetchYahooNative(monitor.yahooSymbol, "1d", cfg, sinceMs);
  }
  if (tfKey === "4h") {
    // Para tener suficientes velas de 1H como para armar "limit" grupos de 4H,
    // se pide histórico de 1H con una ventana 4x más amplia.
    const hourlyCfg = { seconds: 3600, limit: cfg.limit * 4 };
    const hourly = await fetchYahooNative(monitor.yahooSymbol, "60m", hourlyCfg, sinceMs);
    const grouped = groupToSynthetic4h(hourly);
    return sinceMs != null ? grouped : grouped.slice(-cfg.limit);
  }
  throw new Error(`Temporalidad desconocida: ${tfKey}`);
}

// ── Un paso de ZigZag con estado persistente (igual lógica que el Pine) ─
function stepZigZag(st, k, pct) {
  const { t, h, l, c } = k;
  let pivot = null;

  if (st.runHigh === null) {
    st.runHigh = h; st.runHighTime = t;
    st.runLow  = l; st.runLowTime  = t;
  }

  st.htfBarCount++;

  if (st.seekHigh) {
    if (h >= st.runHigh) { st.runHigh = h; st.runHighTime = t; st.htfBarCount = 0; }
  } else {
    if (l <= st.runLow)  { st.runLow  = l; st.runLowTime  = t; st.htfBarCount = 0; }
  }

  if (st.seekHigh && st.htfBarCount >= MIN_BARS && c < st.runHigh * (1 - pct)) {
    pivot = { type: "high", price: st.runHigh, time: st.runHighTime };
    st.lastPrice   = st.runHigh;
    st.lastWasHigh = true;
    st.seekHigh    = false;
    st.runLow      = l; st.runLowTime = t;
    st.htfBarCount = 0;
  } else if (!st.seekHigh && st.htfBarCount >= MIN_BARS && c > st.runLow * (1 + pct)) {
    pivot = { type: "low", price: st.runLow, time: st.runLowTime };
    st.lastPrice   = st.runLow;
    st.lastWasHigh = false;
    st.seekHigh    = true;
    st.runHigh     = h; st.runHighTime = t;
    st.htfBarCount = 0;
  }

  return pivot;
}

function buildMsg(monitor, cfg, lp) {
  const isBull = lp.type === "low";
  const emoji  = isBull ? "📈" : "📉";
  const señal  = isBull ? "🟢 SEÑAL ALCISTA" : "🔴 SEÑAL BAJISTA";
  const pivot  = isBull ? "▲ MÍNIMO confirmado" : "▼ MÁXIMO confirmado";
  const next   = isBull ? "🔼 Buscando próximo MÁXIMO" : "🔽 Buscando próximo MÍNIMO";
  return (
    `${emoji} <b>${señal}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `📊 Instrumento: <b>${monitor.pairLabel}</b>\n` +
    `⏱ Temporalidad: <b>${cfg.label}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `〽️ ZigZag: <b>${pivot}</b>\n` +
    `💰 Precio pivot: <b>${lp.price.toFixed(4)}</b>\n` +
    `${next}\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `🕐 ${horaAR()}`
  );
}

async function processTimeframe(monitor, tfKey, cfg) {
  const key     = `${monitor.id}:${tfKey}`;
  const seeding = !state[key];
  const pct     = monitor.pct ?? PCT_DEFAULT;
  const st = state[key] || {
    seekHigh: true,
    runHigh: null, runLow: null,
    runHighTime: null, runLowTime: null,
    htfBarCount: 0,
    lastPrice: null, lastWasHigh: false,
    pivotCount: 0,
    lastProcessedTime: null,
  };

  const candles = await fetchCandles(monitor, tfKey, cfg, st.lastProcessedTime);
  if (candles.length === 0) { state[key] = st; return; }

  const newPivots = [];
  for (const k of candles) {
    const pivot = stepZigZag(st, k, pct);
    st.lastProcessedTime = k.t;
    if (pivot) { st.pivotCount++; newPivots.push(pivot); }
  }
  state[key] = st;

  if (seeding) {
    log("INFO", `${monitor.pairLabel} ${cfg.label}: estado sembrado · ${st.pivotCount}p históricos · ${candles.length} velas · último ${st.lastWasHigh ? "▼MAX" : "▲MIN"} @ ${st.lastPrice?.toFixed(4) ?? "—"}`);
    return;
  }

  for (const pivot of newPivots) {
    const msg = buildMsg(monitor, cfg, pivot);
    const ok  = await sendTelegram(msg);
    log(pivot.type === "low" ? "BULL" : "BEAR",
      `${monitor.pairLabel} ${cfg.label}: nuevo pivote ${pivot.type === "low" ? "▲MIN" : "▼MAX"} @ ${pivot.price.toFixed(4)} · Telegram ${ok ? "OK" : "FAIL"}`);
  }
}

async function poll() {
  if (isPolling) {
    log("WARN", "Ciclo anterior aún en curso — se omite este poll");
    return;
  }
  isPolling = true;
  lastPoll = new Date();
  cycleCount++;

  try {
    for (const monitor of MONITORS) {
      for (const [tfKey, cfg] of Object.entries(TF_DEFS)) {
        try {
          await processTimeframe(monitor, tfKey, cfg);
        } catch (e) {
          log("ERROR", `${monitor.pairLabel} ${cfg.label}: ${e.message}`);
        }
      }
    }
    if (!initialized) {
      initialized = true;
      log("INFO", `Monitoreando ${MONITORS.map(m => m.pairLabel).join(" · ")} · 1H/4H/Diario · cada 30s`);
    }
  } finally {
    isPolling = false;
  }
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/ping") {
    // Endpoint liviano para UptimeRobot/cron-job.org — solo confirma que
    // el servicio está despierto, sin el JSON pesado de /health.
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("OK");
  } else if (req.url.startsWith("/debug-yahoo")) {
    // Muestra las últimas velas crudas de Yahoo con su hora exacta, para
    // comparar manualmente contra los límites de vela que usa TradingView.
    // Ej: /debug-yahoo?symbol=EURUSD=X&interval=1d
    try {
      const u        = new URL(req.url, "http://localhost");
      const symbol   = u.searchParams.get("symbol")   || "EURUSD=X";
      const interval = u.searchParams.get("interval") || "1d";
      const nowSec   = Math.floor(Date.now() / 1000);
      const period1  = nowSec - 30 * 86400; // últimos 30 días, de sobra para comparar
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&period1=${period1}&period2=${nowSec}`;
      const res2 = await fetchJSON(url);
      const result = res2?.chart?.result?.[0];
      const ts = result?.timestamp || [];
      const quote = result?.indicators?.quote?.[0] || {};
      const velas = ts.map((t, i) => ({
        utc:   new Date(t * 1000).toISOString(),
        ar:    horaAR(new Date(t * 1000)),
        high:  quote.high?.[i],
        low:   quote.low?.[i],
        close: quote.close?.[i],
      }));
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ urlConsultada: url, totalVelas: velas.length, ultimasVelas: velas.slice(-10) }, null, 2));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: e.message }));
    }
  } else if (req.url === "/health" || req.url === "/") {
    const estado = [];
    for (const monitor of MONITORS) {
      for (const [tfKey, cfg] of Object.entries(TF_DEFS)) {
        const st = state[`${monitor.id}:${tfKey}`];
        estado.push({
          instrumento: monitor.pairLabel,
          tf:          cfg.label,
          trend:       st ? (st.seekHigh ? "ALCISTA" : "BAJISTA") : "─",
          pivots:      st?.pivotCount || 0,
          ultimo:      st && st.lastPrice != null
            ? `${st.lastWasHigh ? "▼MAX" : "▲MIN"} @ ${st.lastPrice.toFixed(4)}`
            : "─",
        });
      }
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      status:        "corriendo",
      telegramListo: !!TG_TOKEN,
      lastPoll:      lastPoll ? horaAR(lastPoll) : "─",
      uptime:        `${Math.floor(process.uptime() / 60)} min`,
      ciclos:        cycleCount,
      estado,
      log:           statusLog.slice(0, 20),
    }, null, 2));
  } else {
    res.writeHead(404); res.end("Not found");
  }
});

server.listen(PORT, () => {
  if (!TG_TOKEN) {
    log("ERROR", "⚠ Falta variable de entorno TG_TOKEN — configúrala en Render.");
  }
  log("INFO", `Puerto ${PORT} · ${MONITORS.map(m => m.pairLabel).join(" · ")}`);
  poll();
  setInterval(poll, POLL_MS);
});
