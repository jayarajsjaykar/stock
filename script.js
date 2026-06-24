const INDICES = [
  { symbol: "^GSPC", name: "S&P 500" },
  { symbol: "^DJI", name: "Dow Jones" },
  { symbol: "^IXIC", name: "NASDAQ" },
];

const WATCHLIST = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "TSLA", "META", "JPM"];

const MOVERS = ["AAPL", "NVDA", "TSLA", "AMD", "META", "NFLX"];

const RANGE_CONFIG = {
  "1d": { range: "1d", interval: "5m" },
  "5d": { range: "5d", interval: "15m" },
  "1mo": { range: "1mo", interval: "1d" },
  "3mo": { range: "3mo", interval: "1d" },
  "6mo": { range: "6mo", interval: "1d" },
  "1y": { range: "1y", interval: "1wk" },
};

let currentSymbol = "AAPL";
let currentRange = "5d";
let chart = null;
let candleSeries = null;
let volumeSeries = null;
let sma20Series = null;
let refreshTimer = null;

const $ = (id) => document.getElementById(id);

function showToast(msg) {
  const toast = $("toast");
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove("show"), 2800);
}

function fmt(n, dec = 2) {
  if (n == null || isNaN(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function fmtVol(n) {
  if (n == null || isNaN(n)) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return n.toLocaleString();
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return "—";
  const sign = n >= 0 ? "+" : "";
  return sign + n.toFixed(2) + "%";
}

async function fetchYahoo(symbol, range = "5d", interval = "15m") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=true`;
  const proxies = [
    (u) => u,
    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
  ];

  let lastErr;
  for (const proxy of proxies) {
    try {
      const res = await fetch(proxy(url), { signal: AbortSignal.timeout(12000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data?.chart?.error) throw new Error(data.chart.error.description || "API error");
      return data;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Failed to fetch data");
}

function parseChartData(data) {
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error("No chart data");

  const meta = result.meta;
  const timestamps = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};

  const candles = [];
  const volumes = [];

  for (let i = 0; i < timestamps.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
    if (c == null) continue;
    candles.push({ time: timestamps[i], open: o ?? c, high: h ?? c, low: l ?? c, close: c });
    if (v != null) volumes.push({ time: timestamps[i], value: v, color: c >= (o ?? c) ? "rgba(34,197,94,0.4)" : "rgba(239,68,68,0.4)" });
  }

  return { meta, candles, volumes };
}

/* ── Market Hours (US Eastern) ── */
function getMarketStatus() {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  const mins = et.getHours() * 60 + et.getMinutes();

  const PRE = 4 * 60;
  const OPEN = 9 * 60 + 30;
  const CLOSE = 16 * 60;
  const AFTER = 20 * 60;

  if (day === 0 || day === 6) return { status: "closed", label: "Market Closed — Weekend" };

  if (mins >= OPEN && mins < CLOSE) return { status: "open", label: "Market Open" };
  if (mins >= PRE && mins < OPEN) return { status: "premarket", label: "Pre-Market" };
  if (mins >= CLOSE && mins < AFTER) return { status: "afterhours", label: "After Hours" };
  return { status: "closed", label: "Market Closed" };
}

function updateMarketStatus() {
  const { status, label } = getMarketStatus();
  const el = $("market-status");
  el.className = "market-status " + status;
  $("market-status-text").textContent = label;
}

/* ── Technical Analysis ── */
function calcSMA(prices, period) {
  const out = [];
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += prices[j];
    out.push(sum / period);
  }
  return out;
}

function calcEMA(prices, period) {
  const out = [];
  const k = 2 / (period + 1);
  for (let i = 0; i < prices.length; i++) {
    if (i === 0) { out.push(prices[0]); continue; }
    out.push(prices[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

function calcRSI(prices, period = 14) {
  if (prices.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcMACD(prices) {
  const ema12 = calcEMA(prices, 12);
  const ema26 = calcEMA(prices, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signal = calcEMA(macdLine, 9);
  const hist = macdLine.map((v, i) => v - signal[i]);
  return { macd: macdLine.at(-1), signal: signal.at(-1), hist: hist.at(-1) };
}

function analyzeStock(candles, meta) {
  const closes = candles.map((c) => c.close);
  const price = closes.at(-1);
  const sma20Arr = calcSMA(closes, 20);
  const sma50Arr = calcSMA(closes, 50);
  const ema12Arr = calcEMA(closes, 12);
  const rsi = calcRSI(closes);
  const macd = calcMACD(closes);

  const sma20 = sma20Arr.at(-1);
  const sma50 = sma50Arr.at(-1);
  const ema12 = ema12Arr.at(-1);

  let score = 0;
  const reasons = [];

  if (rsi != null) {
    if (rsi < 30) { score += 2; reasons.push({ text: `RSI at ${rsi.toFixed(1)} — oversold, potential bounce`, type: "positive" }); }
    else if (rsi > 70) { score -= 2; reasons.push({ text: `RSI at ${rsi.toFixed(1)} — overbought, caution advised`, type: "negative" }); }
    else if (rsi >= 45 && rsi <= 55) { reasons.push({ text: `RSI at ${rsi.toFixed(1)} — neutral momentum`, type: "neutral" }); }
    else if (rsi >= 55) { score += 1; reasons.push({ text: `RSI at ${rsi.toFixed(1)} — bullish momentum`, type: "positive" }); }
    else { score -= 1; reasons.push({ text: `RSI at ${rsi.toFixed(1)} — bearish momentum`, type: "negative" }); }
  }

  if (sma20 && sma50) {
    if (price > sma20 && sma20 > sma50) {
      score += 2;
      reasons.push({ text: "Price above SMA 20 & 50 — uptrend confirmed", type: "positive" });
    } else if (price < sma20 && sma20 < sma50) {
      score -= 2;
      reasons.push({ text: "Price below SMA 20 & 50 — downtrend confirmed", type: "negative" });
    } else {
      reasons.push({ text: "Mixed moving average signals — trend unclear", type: "neutral" });
    }
  }

  if (ema12 && price) {
    if (price > ema12) { score += 1; reasons.push({ text: "Price trading above EMA 12 — short-term bullish", type: "positive" }); }
    else { score -= 1; reasons.push({ text: "Price below EMA 12 — short-term bearish", type: "negative" }); }
  }

  if (macd.hist != null) {
    if (macd.hist > 0) { score += 1; reasons.push({ text: "MACD histogram positive — bullish crossover", type: "positive" }); }
    else { score -= 1; reasons.push({ text: "MACD histogram negative — bearish pressure", type: "negative" }); }
  }

  const changePct = meta?.regularMarketChangePercent ?? meta?.chartPreviousClose
    ? ((price - meta.chartPreviousClose) / meta.chartPreviousClose) * 100
    : null;

  if (changePct != null) {
    if (changePct > 1) reasons.push({ text: `Up ${changePct.toFixed(2)}% today — strong session`, type: "positive" });
    else if (changePct < -1) reasons.push({ text: `Down ${Math.abs(changePct).toFixed(2)}% today — weak session`, type: "negative" });
  }

  let signal, summary;
  if (score >= 3) { signal = "bullish"; summary = "Overall bullish outlook. Multiple indicators suggest upward momentum."; }
  else if (score <= -3) { signal = "bearish"; summary = "Overall bearish outlook. Indicators suggest downward pressure."; }
  else { signal = "neutral"; summary = "Mixed signals. Consider waiting for clearer trend confirmation."; }

  const rsiColor = rsi == null ? "#94a3b8" : rsi < 30 ? "#22c55e" : rsi > 70 ? "#ef4444" : "#eab308";

  return { price, rsi, sma20, sma50, ema12, macd, signal, summary, reasons, rsiColor, sma20Arr };
}

function renderAnalysis(analysis, meta) {
  $("signal-badge").className = "signal-badge " + analysis.signal;
  $("signal-badge").textContent = analysis.signal;
  $("signal-summary").textContent = analysis.summary;

  const reasonsEl = $("signal-reasons");
  reasonsEl.innerHTML = analysis.reasons.map((r) => `<li class="${r.type}">${r.text}</li>`).join("");

  $("ind-rsi").textContent = analysis.rsi != null ? analysis.rsi.toFixed(1) : "—";
  const rsiBar = $("ind-rsi-bar").querySelector("span");
  if (analysis.rsi != null) {
    rsiBar.style.width = analysis.rsi + "%";
    rsiBar.style.background = analysis.rsiColor;
  }

  $("ind-sma20").textContent = analysis.sma20 ? "$" + fmt(analysis.sma20) : "—";
  $("ind-sma50").textContent = analysis.sma50 ? "$" + fmt(analysis.sma50) : "—";
  $("ind-ema12").textContent = analysis.ema12 ? "$" + fmt(analysis.ema12) : "—";
  $("ind-macd").textContent = analysis.macd?.hist != null ? analysis.macd.hist.toFixed(3) : "—";

  const low52 = meta.fiftyTwoWeekLow ?? meta.regularMarketDayLow;
  const high52 = meta.fiftyTwoWeekHigh ?? meta.regularMarketDayHigh;
  $("ind-range").textContent = low52 && high52 ? `$${fmt(low52)} – $${fmt(high52)}` : "—";
}

function renderQuote(meta) {
  const price = meta.regularMarketPrice ?? meta.previousClose ?? meta.chartPreviousClose;
  const prev = meta.chartPreviousClose ?? meta.previousClose;
  const change = meta.regularMarketChange ?? (price - prev);
  const changePct = meta.regularMarketChangePercent ?? (prev ? (change / prev) * 100 : 0);
  const isUp = change >= 0;

  $("stock-symbol").textContent = meta.symbol || currentSymbol;
  $("stock-name").textContent = meta.longName || meta.shortName || meta.symbol || "";
  $("stock-price").textContent = "$" + fmt(price);
  $("stock-change").className = "stock-change " + (isUp ? "up" : "down");
  $("stock-change").textContent = `${isUp ? "+" : ""}${fmt(change)} (${fmtPct(changePct)})`;

  $("stat-open").textContent = meta.regularMarketOpen ? "$" + fmt(meta.regularMarketOpen) : "—";
  $("stat-high").textContent = meta.regularMarketDayHigh ? "$" + fmt(meta.regularMarketDayHigh) : "—";
  $("stat-low").textContent = meta.regularMarketDayLow ? "$" + fmt(meta.regularMarketDayLow) : "—";
  $("stat-volume").textContent = fmtVol(meta.regularMarketVolume);
  $("stat-prev").textContent = prev ? "$" + fmt(prev) : "—";
}

function initChart() {
  const container = $("chart-container");
  const existing = container.querySelector(".tv-lightweight-charts");
  if (existing) existing.remove();

  chart = LightweightCharts.createChart(container, {
    width: container.clientWidth,
    height: 380,
    layout: { background: { color: "transparent" }, textColor: "#94a3b8", fontFamily: "JetBrains Mono" },
    grid: { vertLines: { color: "rgba(255,255,255,0.04)" }, horzLines: { color: "rgba(255,255,255,0.04)" } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
    timeScale: { borderColor: "rgba(255,255,255,0.08)", timeVisible: true },
  });

  candleSeries = chart.addCandlestickSeries({
    upColor: "#22c55e", downColor: "#ef4444",
    borderUpColor: "#22c55e", borderDownColor: "#ef4444",
    wickUpColor: "#22c55e", wickDownColor: "#ef4444",
  });

  sma20Series = chart.addLineSeries({ color: "#818cf8", lineWidth: 2, title: "SMA 20" });

  volumeSeries = chart.addHistogramSeries({
    priceFormat: { type: "volume" },
    priceScaleId: "vol",
  });
  chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });

  new ResizeObserver(() => {
    if (chart) chart.applyOptions({ width: container.clientWidth });
  }).observe(container);
}

function updateChart(candles, volumes, sma20Arr) {
  if (!chart) initChart();

  candleSeries.setData(candles);
  volumeSeries.setData(volumes);

  const smaData = candles.map((c, i) => {
    const v = sma20Arr[i];
    return v != null ? { time: c.time, value: v } : null;
  }).filter(Boolean);
  sma20Series.setData(smaData);

  chart.timeScale().fitContent();
}

async function loadStock(symbol, range = currentRange) {
  currentSymbol = symbol.toUpperCase();
  $("chart-loading").classList.remove("hidden");

  document.querySelectorAll(".watchlist-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.symbol === currentSymbol);
  });

  try {
    const cfg = RANGE_CONFIG[range] || RANGE_CONFIG["5d"];
    const data = await fetchYahoo(currentSymbol, cfg.range, cfg.interval);
    const { meta, candles, volumes } = parseChartData(data);

    if (candles.length === 0) throw new Error("No price data available");

    renderQuote(meta);
    const analysis = analyzeStock(candles, meta);
    renderAnalysis(analysis, meta);
    updateChart(candles, volumes, analysis.sma20Arr);

    $("last-updated").textContent = "Updated " + new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch (err) {
    showToast(`Could not load ${currentSymbol}: ${err.message}`);
    $("signal-summary").textContent = "Failed to load data. Check the ticker symbol and try again.";
    $("signal-badge").className = "signal-badge neutral";
    $("signal-badge").textContent = "Error";
  } finally {
    $("chart-loading").classList.add("hidden");
  }
}

async function renderIndexCard(indexInfo, container) {
  try {
    const data = await fetchYahoo(indexInfo.symbol, "1d", "5m");
    const { meta, candles } = parseChartData(data);
    const price = meta.regularMarketPrice ?? candles.at(-1)?.close;
    const prev = meta.chartPreviousClose ?? meta.previousClose;
    const change = price - prev;
    const changePct = prev ? (change / prev) * 100 : 0;
    const isUp = change >= 0;

    const card = document.createElement("div");
    card.className = "index-card";
    card.innerHTML = `
      <div class="index-name">${indexInfo.name}</div>
      <div class="index-symbol">${indexInfo.symbol}</div>
      <div class="index-price">$${fmt(price)}</div>
      <div class="index-change ${isUp ? "up" : "down"}">${isUp ? "+" : ""}${fmt(change)} (${fmtPct(changePct)})</div>
    `;
    return card;
  } catch {
    const card = document.createElement("div");
    card.className = "index-card";
    card.innerHTML = `<div class="index-name">${indexInfo.name}</div><div class="index-change down">Unavailable</div>`;
    return card;
  }
}

async function loadIndices() {
  const grid = $("indices-grid");
  grid.innerHTML = "";
  const cards = await Promise.all(INDICES.map((idx) => renderIndexCard(idx)));
  cards.forEach((c) => grid.appendChild(c));
}

async function loadMovers() {
  const list = $("movers-list");
  list.innerHTML = "";

  const results = await Promise.allSettled(
    MOVERS.map(async (sym) => {
      const data = await fetchYahoo(sym, "1d", "5m");
      const { meta, candles } = parseChartData(data);
      const price = meta.regularMarketPrice ?? candles.at(-1)?.close;
      const prev = meta.chartPreviousClose ?? meta.previousClose;
      const changePct = prev ? ((price - prev) / prev) * 100 : 0;
      return { sym, name: meta.shortName || sym, changePct };
    })
  );

  const movers = results
    .filter((r) => r.status === "fulfilled")
    .map((r) => r.value)
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));

  if (movers.length === 0) {
    list.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem">Unable to load movers</p>';
    return;
  }

  movers.forEach((m) => {
    const el = document.createElement("div");
    el.className = "mover";
    const isUp = m.changePct >= 0;
    el.innerHTML = `
      <div><div class="mover-symbol">${m.sym}</div><div class="mover-name">${m.name}</div></div>
      <div class="mover-change ${isUp ? "up" : "down"}">${fmtPct(m.changePct)}</div>
    `;
    el.addEventListener("click", () => selectStock(m.sym));
    list.appendChild(el);
  });
}

function buildWatchlist() {
  const wrap = $("watchlist");
  WATCHLIST.forEach((sym) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "watchlist-btn" + (sym === currentSymbol ? " active" : "");
    btn.dataset.symbol = sym;
    btn.textContent = sym;
    btn.addEventListener("click", () => selectStock(sym));
    wrap.appendChild(btn);
  });
}

function selectStock(symbol) {
  $("search-input").value = symbol;
  loadStock(symbol, currentRange);
}

function setupRangeButtons() {
  document.querySelectorAll(".range-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".range-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentRange = btn.dataset.range;
      loadStock(currentSymbol, currentRange);
    });
  });
}

function setupSearch() {
  const input = $("search-input");
  const search = () => {
    const sym = input.value.trim().toUpperCase();
    if (!sym) { showToast("Enter a ticker symbol"); return; }
    loadStock(sym, currentRange);
  };

  $("search-btn").addEventListener("click", search);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") search(); });
  $("refresh-btn").addEventListener("click", () => {
    loadStock(currentSymbol, currentRange);
    loadIndices();
    loadMovers();
    showToast("Data refreshed");
  });
}

function startAutoRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    updateMarketStatus();
    loadStock(currentSymbol, currentRange);
    loadIndices();
  }, 60000);
}

async function init() {
  updateMarketStatus();
  setInterval(updateMarketStatus, 30000);
  buildWatchlist();
  setupRangeButtons();
  setupSearch();
  initChart();

  await Promise.all([loadIndices(), loadStock(currentSymbol), loadMovers()]);
  startAutoRefresh();
}

init();