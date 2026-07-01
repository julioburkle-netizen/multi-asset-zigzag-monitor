const https = require("https");
const http  = require("http");

// 🔐 Credenciales por variable de entorno (configúralas en Render → Environment)
const TG_TOKEN = process.env.TG_TOKEN || "";
const TG_CHAT  = process.env.TG_CHAT  || "966057563";

const PCT      = 0.01;   // 1% retroceso para confirmar pivote
const MIN_BARS = 1;      // velas mínimas entre pivotes
const POLL_MS  = 30 * 1000;
const PORT     = process.env.PORT || 3000;
const HTTP_TIMEOUT_MS = 10 * 1000;

const DEFAULT_TF_KEYS = ["1h", "4h", "1d"];

// ══════════════════════════════════════════════════════════════════════
//   📌 PARES A MONITOREAR — agrega/quita líneas aquí
//   "tfKeys" es opcional: si no se pone, usa DEFAULT_TF_KEYS (1h/4h/1d)
// ══════════════════════════════════════════════════════════════════════
const MONITORS = [
  { id: "xlm", pairLabel: "XLM/USDT", exchangeLabel: "KuCoin", exchange: "kucoin", symbol: "XLM-USDT" },
  { id: "trx", pairLabel: "TRX/USDT", exchangeLabel: "KuCoin", exchange: "kucoin", symbol: "TRX-USDT" },
];

// Temporalidades (neutrales) + cuánto histórico pedir al "sembrar" el estado
const TF_DEFS = {
  "30m": { label: "30 Minutos", seconds: 1800,  limit: 800 },
  "1h":  { label: "1 Hora",     seconds: 3600,  limit: 800 },
  "4h":  { label: "4 Horas",    seconds: 14400, limit: 800 },
  "1d":  { label: "Diario",     seconds: 86400, limit: 500 },
};

// Cómo se llama cada temporalidad en la API de cada exchange
const TF_NAME = {
  kucoin: { "30m": "30min",  "1h": "1hour", "4h": "4hour", "1d": "1day" },
  lbank:  { "30m": "minute30", "1h": "hour1", "4h": "hour4", "1d": "day1" },
};

let state       = {};   // state["xlm:1h"] = estado persistente del ZigZag para ese par+tf
let lastPoll    = null;
let statusLog   = [];
let cycleCount  = 0;
let initialized = false;
let isPolling   = false;

// Formato forzado a 24hs + zona horaria de Argentina explícita, sin depender
// de defaults del locale (que pueden variar según el motor de Node del host).
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

// ── HTTP helpers con timeout ──────────────────────────────────────────
function fetchJSON(url, timeoutMs = HTTP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "Multi-ZigZag/1.0" } }, (res) => {
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

// ── KuCoin: velas ascendentes, sin la vela en formación ────────────────
async function fetchCandlesKuCoin(symbol, interval, cfg, sinceMs) {
  const { seconds, limit } = cfg;
  const nowSec = Math.floor(Date.now() / 1000);
  const startAt = sinceMs != null
    ? Math.floor(sinceMs / 1000) + 1
    : nowSec - limit * seconds;

  const url = `https://api.kucoin.com/api/v1/market/candles?type=${interval}&symbol=${symbol}&startAt=${startAt}&endAt=${nowSec}`;
  const res = await fetchJSON(url);
  if (!res || res.code !== "200000" || !Array.isArray(res.data))
    throw new Error(`KuCoin: ${JSON.stringify(res)}`);

  const nowMs = Date.now();
  const candles = res.data
    .map(k => ({ t: parseInt(k[0]) * 1000, h: parseFloat(k[3]), l: parseFloat(k[4]), c: parseFloat(k[2]) }))
    .filter(k => k.t + seconds * 1000 <= nowMs)
    .sort((a, b) => a.t - b.t);

  return sinceMs != null ? candles : candles.slice(-limit);
}

// ── LBank: formato y endpoint distintos. El parámetro "time" de LBank ──
// no filtra de forma confiable (bug conocido de su API), así que SIEMPRE
// se filtra localmente por sinceMs en vez de confiar en el rango pedido.
async function fetchCandlesLBank(symbol, type, cfg, sinceMs) {
  const { seconds, limit } = cfg;
  const size = sinceMs != null ? 50 : limit; // si ya hay estado, alcanza con pocas velas recientes
  const nowSec = Math.floor(Date.now() / 1000);
  // 🐛 Bug confirmado de LBank: si "time" está muy cerca de "ahora", la
  // respuesta vuelve truncada a 1 sola vela, sin importar el símbolo ni
  // el "size" pedido. Alejándolo 24hs del presente, siempre devuelve las
  // velas más recientes completas (confirmado con eth_usdt y a_usdt).
  const timeSafe = nowSec - 24 * 3600;
  const url = `https://api.lbkex.com/v1/kline.do?symbol=${symbol}&size=${size}&type=${type}&time=${timeSafe}`;
  const res = await fetchJSON(url);
  if (!Array.isArray(res)) throw new Error(`LBank: ${JSON.stringify(res)}`);

  const nowMs = Date.now();
  let candles = res
    // formato LBank: [tiempo(seg), open, high, low, close, volumen]
    .map(k => ({ t: k[0] * 1000, h: k[2], l: k[3], c: k[4] }))
    .filter(k => k.t + seconds * 1000 <= nowMs)
    .sort((a, b) => a.t - b.t);

  if (sinceMs != null) candles = candles.filter(k => k.t > sinceMs);
  return sinceMs != null ? candles : candles.slice(-limit);
}

async function fetchCandles(monitor, tfKey, cfg, sinceMs) {
  const interval = TF_NAME[monitor.exchange][tfKey];
  if (monitor.exchange === "kucoin") return fetchCandlesKuCoin(monitor.symbol, interval, cfg, sinceMs);
  if (monitor.exchange === "lbank")  return fetchCandlesLBank(monitor.symbol, interval, cfg, sinceMs);
  throw new Error(`Exchange desconocido: ${monitor.exchange}`);
}

// ── Un paso de ZigZag, igual lógica que el Pine: estado persistente, ──
// se avanza vela por vela, nunca se recalcula desde cero. ─────────────
function stepZigZag(st, k) {
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

  if (st.seekHigh && st.htfBarCount >= MIN_BARS && c < st.runHigh * (1 - PCT)) {
    pivot = { type: "high", price: st.runHigh, time: st.runHighTime };
    st.lastPrice   = st.runHigh;
    st.lastWasHigh = true;
    st.seekHigh    = false;
    st.runLow      = l; st.runLowTime = t;
    st.htfBarCount = 0;
  } else if (!st.seekHigh && st.htfBarCount >= MIN_BARS && c > st.runLow * (1 + PCT)) {
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
  const explica = isBull
    ? "El precio tocó fondo y rebotó +1%"
    : "El precio tocó techo y cayó -1%";
  return (
    `${emoji} <b>${señal}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `📊 Par: <b>${monitor.pairLabel}</b> (${monitor.exchangeLabel})\n` +
    `⏱ Temporalidad: <b>${cfg.label}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `〽️ ZigZag: <b>${pivot}</b>\n` +
    `💰 Precio pivot: <b>${lp.price.toFixed(5)} USDT</b>\n` +
    `${next}\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `ℹ️ ${explica}\n` +
    `🕐 ${horaAR()}`
  );
}

// ── Procesa UNA temporalidad de UN par: solo velas nuevas desde la ──
// última vez. El estado vive en state[`${monitor.id}:${tfKey}`]. ────
async function processTimeframe(monitor, tfKey, cfg) {
  const key     = `${monitor.id}:${tfKey}`;
  const seeding = !state[key];
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

  if (candles.length === 0) {
    if (st.lastProcessedTime === null) {
      // Nunca se procesó ni una sola vela para este par+tf — esto NO es
      // normal pasados unos minutos. Avisa en cada ciclo hasta que se
      // resuelva (símbolo inválido, par no soportado, etc.), en vez de
      // quedar en silencio para siempre como antes.
      log("WARN", `${monitor.pairLabel} ${cfg.label}: 0 velas recibidas (nunca se procesó ninguna) — revisa /debug-lbank`);
    }
    state[key] = st;
    return;
  }

  const newPivots = [];
  for (const k of candles) {
    const pivot = stepZigZag(st, k);
    st.lastProcessedTime = k.t;
    if (pivot) { st.pivotCount++; newPivots.push(pivot); }
  }
  state[key] = st;

  if (seeding) {
    log("INFO", `${monitor.pairLabel} ${cfg.label}: estado sembrado · ${st.pivotCount}p históricos · ${candles.length} velas · último ${st.lastWasHigh ? "▼MAX" : "▲MIN"} @ ${st.lastPrice?.toFixed(5) ?? "—"}`);
    return;
  }

  for (const pivot of newPivots) {
    const msg = buildMsg(monitor, cfg, pivot);
    const ok  = await sendTelegram(msg);
    log(pivot.type === "low" ? "BULL" : "BEAR",
      `${monitor.pairLabel} ${cfg.label}: nuevo pivote ${pivot.type === "low" ? "▲MIN" : "▼MAX"} @ ${pivot.price.toFixed(5)} · Telegram ${ok ? "OK" : "FAIL"}`);
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
      for (const tfKey of (monitor.tfKeys || DEFAULT_TF_KEYS)) {
        const cfg = TF_DEFS[tfKey];
        try {
          await processTimeframe(monitor, tfKey, cfg);
        } catch (e) {
          log("ERROR", `${monitor.pairLabel} ${cfg.label}: ${e.message}`);
        }
      }
    }
    if (!initialized) {
      initialized = true;
      log("INFO", `Monitoreando ${MONITORS.map(m => m.pairLabel).join(" · ")} · cada 30s`);
    }
  } finally {
    isPolling = false;
  }
}

// ── Backtest: ¿qué % de los tramos pivote→pivote llegó a cierto objetivo? ──
// Recalcula el ZigZag completo sobre el histórico (en una copia de estado
// aparte, sin tocar el state[] en vivo) y mide el movimiento real en %
// entre cada pivote y el siguiente — no solo cuántas velas hubo.
async function backtestLegs(monitor, tfKey) {
  const cfg = TF_DEFS[tfKey];
  const candles = await fetchCandles(monitor, tfKey, cfg, null); // null = histórico completo

  const st = {
    seekHigh: true, runHigh: null, runLow: null,
    runHighTime: null, runLowTime: null, htfBarCount: 0,
    lastPrice: null, lastWasHigh: false, pivotCount: 0, lastProcessedTime: null,
  };
  const pivots = [];
  for (const k of candles) {
    const pivot = stepZigZag(st, k);
    if (pivot) pivots.push(pivot);
  }

  const legs = [];
  for (let i = 1; i < pivots.length; i++) {
    const prev = pivots[i - 1], curr = pivots[i];
    const pct = Math.abs((curr.price - prev.price) / prev.price) * 100;
    legs.push(Math.round(pct * 100) / 100);
  }

  const total = legs.length;
  const buckets = { "menor a 1%": 0, "1% a 2%": 0, "2% a 4%": 0, "4% a 8%": 0, "8% o más": 0 };
  let suma = 0, max = 0, llegaA4 = 0;
  for (const pct of legs) {
    suma += pct;
    if (pct > max) max = pct;
    if (pct >= 4) llegaA4++;
    if (pct < 1) buckets["menor a 1%"]++;
    else if (pct < 2) buckets["1% a 2%"]++;
    else if (pct < 4) buckets["2% a 4%"]++;
    else if (pct < 8) buckets["4% a 8%"]++;
    else buckets["8% o más"]++;
  }
  const ordenados = [...legs].sort((a, b) => a - b);
  const mediana = total ? ordenados[Math.floor(total / 2)] : 0;

  return {
    par:                     `${monitor.pairLabel} (${monitor.exchangeLabel})`,
    temporalidad:            cfg.label,
    velasAnalizadas:         candles.length,
    tramosPivoteAPivote:     total,
    tramosQueLlegaronA4pct:  llegaA4,
    porcentajeQueLlegaA4pct: total ? `${((llegaA4 / total) * 100).toFixed(1)}%` : "0%",
    movimientoPromedio:      `${(total ? suma / total : 0).toFixed(2)}%`,
    movimientoMediana:       `${mediana.toFixed(2)}%`,
    movimientoMaximo:        `${max.toFixed(2)}%`,
    distribucion:            buckets,
  };
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/health" || req.url === "/") {
    const estado = [];
    for (const monitor of MONITORS) {
      for (const tfKey of (monitor.tfKeys || DEFAULT_TF_KEYS)) {
        const cfg = TF_DEFS[tfKey];
        const st  = state[`${monitor.id}:${tfKey}`];
        estado.push({
          par:    `${monitor.pairLabel} (${monitor.exchangeLabel})`,
          tf:     cfg.label,
          trend:  st ? (st.seekHigh ? "ALCISTA" : "BAJISTA") : "─",
          pivots: st?.pivotCount || 0,
          ultimo: st && st.lastPrice != null
            ? `${st.lastWasHigh ? "▼MAX" : "▲MIN"} @ ${st.lastPrice.toFixed(5)}`
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
  } else if (req.url.startsWith("/debug-lbank-kline")) {
    // Llama directamente a kline.do — todo configurable por query params
    // para poder probar combinaciones sin tener que subir código de nuevo.
    // Ej: /debug-lbank-kline?time=hace24h  ó  /debug-lbank-kline?symbol=eth_usdt
    try {
      const u      = new URL(req.url, "http://localhost");
      const symbol = u.searchParams.get("symbol") || "a_usdt";
      const tipo   = u.searchParams.get("type")   || "hour1";
      const size   = u.searchParams.get("size")   || "20";
      const nowSec = Math.floor(Date.now() / 1000);

      let timeParam = u.searchParams.get("time") || String(nowSec);
      if (timeParam === "hace24h")  timeParam = String(nowSec - 24 * 3600);
      if (timeParam === "hace7d")   timeParam = String(nowSec - 7 * 86400);
      if (timeParam === "hace30d")  timeParam = String(nowSec - 30 * 86400);

      const url   = `https://api.lbkex.com/v1/kline.do?symbol=${symbol}&size=${size}&type=${tipo}&time=${timeParam}`;
      const crudo = await fetchJSON(url);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        urlConsultada: url,
        timeUsado: timeParam,
        nowSec,
        esArray: Array.isArray(crudo),
        cantidadDeVelas: Array.isArray(crudo) ? crudo.length : null,
        respuestaCruda: crudo,
      }, null, 2));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: e.message }));
    }
  } else if (req.url.startsWith("/debug-lbank")) {
    // Verifica directamente contra LBank si el símbolo configurado existe.
    try {
      const pairs = await fetchJSON("https://api.lbkex.com/v1/currencyPairs.do");
      const monitor = MONITORS.find(m => m.exchange === "lbank");
      const existe = Array.isArray(pairs) && pairs.includes(monitor.symbol);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        simboloBuscado: monitor.symbol,
        existeEnLBank: existe,
        totalParesDevueltos: Array.isArray(pairs) ? pairs.length : 0,
        paresQueContienen_a: Array.isArray(pairs) ? pairs.filter(p => p.startsWith("a_") || p === "a_usdt") : [],
        muestraDeRespuesta: Array.isArray(pairs) ? pairs.slice(0, 15) : pairs,
      }, null, 2));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: e.message }));
    }
  } else if (req.url.startsWith("/backtest")) {
    // Uso: /backtest?par=xlm|a&tf=1h|4h|1d  (por defecto: xlm, 1h)
    const u      = new URL(req.url, "http://localhost");
    const parId  = u.searchParams.get("par") || "xlm";
    const tfKey  = u.searchParams.get("tf")  || "1h";
    const monitor = MONITORS.find(m => m.id === parId);
    if (!monitor || !TF_DEFS[tfKey]) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Parámetros inválidos. Usa ?par=xlm|a&tf=1h|4h|1d" }));
      return;
    }
    try {
      const resultado = await backtestLegs(monitor, tfKey);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(resultado, null, 2));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: e.message }));
    }
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
