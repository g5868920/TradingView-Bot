// /api/tv-hook.js
// Node 18+ Serverless Function for Vercel
// Receives TradingView webhooks, enforces your rules, and pushes Telegram notifications with emoji.
// Gina spec: 4H direction alignment, Entry=open of signal bar, SL from recent swing ±0.5%,
// TP1 RR=1, TP2 RR=1.5, filters: SL% 1–3%, reached RR1, spike move, macro window ±12h.

const TG_API = (token) => `https://api.telegram.org/bot${token}/sendMessage`;

// Optional: Upstash Redis REST (for persistent 4H direction). If not set, will use in-memory map.
const hasRedis = !!(process.env.REDIS_URL && process.env.REDIS_TOKEN);
async function redisGet(key) {
  if (!hasRedis) return mem.get(key) || null;
  const res = await fetch(`${process.env.REDIS_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${process.env.REDIS_TOKEN}` },
  });
  if (!res.ok) return null;
  const { result } = await res.json();
  return result;
}
async function redisSetEx(key, value, ttlSec = 7*24*3600) {
  if (!hasRedis) { mem.set(key, value); return; }
  await fetch(`${process.env.REDIS_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}?EX=${ttlSec}`, {
    headers: { Authorization: `Bearer ${process.env.REDIS_TOKEN}` },
  });
}
const mem = new Map();

const BINANCE_FUTURES_BASE = "https://fapi.binance.com";
const tfMap = { "1":"1m","3":"3m","5":"5m","15":"15m","30":"30m","60":"1h","120":"2h","240":"4h","1D":"1d","4H":"4h" };

function normalizeSymbol(tvSymbol) {
  const s = String(tvSymbol || "").split(":").pop();
  return s.replace(".P",""); // BTCUSDT.P -> BTCUSDT
}

// Find recent swing pivot (fractal): left/right L bars, lookback window
async function findPivot(symbol, intervalMinutes, side, L=2, lookback=50) {
  const binanceSymbol = normalizeSymbol(symbol);
  const interval = tfMap[String(intervalMinutes)] || "15m";
  const limit = Math.max(lookback + L + 3, 100);
  const url = `${BINANCE_FUTURES_BASE}/fapi/v1/klines?symbol=${binanceSymbol}&interval=${interval}&limit=${limit}`;
  const arr = await fetch(url).then(r => r.json());
  if (!Array.isArray(arr)) throw new Error("Binance kline error");

  const klines = arr.slice(0, -1).map(k => ({
    open: +k[1], high: +k[2], low: +k[3], close: +k[4]
  }));

  for (let i = klines.length - 1 - L; i >= L; i--) {
    let ok = true;
    if (side === "LONG") {
      const pivotLow = klines[i].low;
      for (let j = 1; j <= L; j++) {
        if (!(pivotLow < klines[i-j].low && pivotLow < klines[i+j].low)) { ok = false; break; }
      }
      if (ok) return { price: pivotLow };
    } else {
      const pivotHigh = klines[i].high;
      for (let j = 1; j <= L; j++) {
        if (!(pivotHigh > klines[i-j].high && pivotHigh > klines[i+j].high)) { ok = false; break; }
      }
      if (ok) return { price: pivotHigh };
    }
  }
  const last = klines.slice(-lookback);
  if (side === "LONG") return { price: Math.min(...last.map(k=>k.low)) };
  return { price: Math.max(...last.map(k=>k.high)) };
}

// Spike detection: big candles (>=1.5%) on body; allow simple two-bar check
function isSpikeMove(open, close, prevOpen, prevClose, threshold=0.015) {
  const body1 = Math.abs(close - open) / Math.max(1e-9, open);
  const body2 = Math.abs(prevClose - prevOpen) / Math.max(1e-9, prevOpen);
  return (body1 >= threshold) || (body1 >= threshold*0.8 && body2 >= threshold*0.8);
}

// Macro window ± hours
function inMacroWindow(nowUtcMs) {
  const windowH = Number(process.env.MACRO_WINDOW_HOURS || 12);
  const half = windowH * 3600 * 1000;
  const list = String(process.env.MACRO_EVENTS_UTC || "").split(",").map(s=>s.trim()).filter(Boolean);
  for (const iso of list) {
    const t = Date.parse(iso);
    if (!isNaN(t) && Math.abs(nowUtcMs - t) <= half) return true;
  }
  return false;
}

async function pushTelegram(text) {
  if (!process.env.TG_BOT_TOKEN || !process.env.TG_CHAT_ID) return;
  await fetch(TG_API(process.env.TG_BOT_TOKEN), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: process.env.TG_CHAT_ID, text })
  });
}

const dirKey = (symbol) => `dir4h:${normalizeSymbol(symbol)}`;

function fmt(n) {
  const x = Number(n);
  if (x >= 100) return x.toFixed(2);
  if (x >= 1) return x.toFixed(4);
  return x.toPrecision(6);
}
function dirText(side) {
  return side === "LONG" ? "多頭漸增 LONG 📈" : "空頭漸增 SHORT 📉";
}

// Vercel serverless handler
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();
  try {
    const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!payload || payload.secret !== process.env.TV_SECRET) return res.status(401).json({ ok:false, msg:"bad secret" });

    const { type, event, symbol, interval, open, close } = payload;
    const now = Date.now();

    if (type === "DIRECTION_4H") {
      const side = /多|Long|long/.test(event) ? "LONG" : /空|Short|short/.test(event) ? "SHORT" : null;
      if (side) await redisSetEx(dirKey(symbol), side);
      return res.json({ ok:true, saved: side });
    }

    if (type === "ENTRY_SIGNAL") {
      const sideSignal = /多單進場|Long/.test(event) ? "LONG" : /空單進場|Short/.test(event) ? "SHORT" : null;
      if (!sideSignal) return res.json({ ok:true, ignored:"unknown event" });

      const side4h = await redisGet(dirKey(symbol));
      if (!side4h || side4h !== sideSignal) {
        return res.json({ ok:true, ignored:"direction not aligned with 4H" });
      }

      if (inMacroWindow(now)) {
        await pushTelegram(
`>> ⚠️ 「不」建議進場（原因：重大數據事件窗口）

📊 幣種：${normalizeSymbol(symbol)} 
⏳ 4H量價關係：${dirText(side4h)}
🕐 時區：${interval}`
        );
        return res.json({ ok:true, blocked:"macro window" });
      }

      const entry = Number(open);
      const intMin = /^\d+$/.test(String(interval)) ? Number(interval) : 15;

      // Fetch recent pivot
      const pivot = await findPivot(symbol, intMin, sideSignal, 2, 50);
      let SL, risk, riskPct, TP1, TP2;

      if (sideSignal === "LONG") {
        SL = pivot.price * (1 - 0.005);
        risk = entry - SL;
        TP1 = entry + risk;
        TP2 = entry + 1.5 * risk;
      } else {
        SL = pivot.price * (1 + 0.005);
        risk = SL - entry;
        TP1 = entry - risk;
        TP2 = entry - 1.5 * risk;
      }
      riskPct = risk / entry;

      // Filters
      if (riskPct < 0.01) {
        await pushTelegram(
`>> ⚠️ 「不」建議進場（原因：止損小於 1%）

📊 幣種：${normalizeSymbol(symbol)} 
⏳ 4H量價關係：${dirText(side4h)}
🕐 時區：${interval}
🎯 Entry：${fmt(entry)}
🛡 SL: ${fmt(SL)}
🥇 TP1: ${fmt(TP1)}
🥈 TP2: ${fmt(TP2)}`
        );
        return res.json({ ok:true, blocked:"risk < 1%" });
      }
      if (riskPct > 0.03) {
        await pushTelegram(
`>> ⚠️ 「不」建議進場（原因：止損大於 3%）

📊 幣種：${normalizeSymbol(symbol)} 
⏳ 4H量價關係：${dirText(side4h)}
🕐 時區：${interval}
🎯 Entry：${fmt(entry)}
🛡 SL: ${fmt(SL)}
🥇 TP1: ${fmt(TP1)}
🥈 TP2: ${fmt(TP2)}`
        );
        return res.json({ ok:true, blocked:"risk > 3%" });
      }

      const last = Number(close);
      if (sideSignal === "LONG" && last - entry >= risk) {
        await pushTelegram(
`>> ⚠️ 「不」建議進場（原因：尚未進場已到 1:1）

📊 幣種：${normalizeSymbol(symbol)} 
⏳ 4H量價關係：${dirText(side4h)}
🕐 時區：${interval}
🎯 Entry：${fmt(entry)}
🛡 SL: ${fmt(SL)}
🥇 TP1: ${fmt(TP1)}
🥈 TP2: ${fmt(TP2)}`
        );
        return res.json({ ok:true, blocked:"reached RR1" });
      }
      if (sideSignal === "SHORT" && entry - last >= risk) {
        await pushTelegram(
`>> ⚠️ 「不」建議進場（原因：尚未進場已到 1:1）

📊 幣種：${normalizeSymbol(symbol)} 
⏳ 4H量價關係：${dirText(side4h)}
🕐 時區：${interval}
🎯 Entry：${fmt(entry)}
🛡 SL: ${fmt(SL)}
🥇 TP1: ${fmt(TP1)}
🥈 TP2: ${fmt(TP2)}`
        );
        return res.json({ ok:true, blocked:"reached RR1" });
      }

      // Simple spike check using current bar only (conservative)
      if (isSpikeMove(Number(open), Number(close), Number(open), Number(close))) {
        await pushTelegram(
`>> ⚠️ 「不」建議進場（原因：短線急漲急跌）

📊 幣種：${normalizeSymbol(symbol)} 
⏳ 4H量價關係：${dirText(side4h)}
🕐 時區：${interval}
🎯 Entry：${fmt(entry)}
🛡 SL: ${fmt(SL)}
🥇 TP1: ${fmt(TP1)}
🥈 TP2: ${fmt(TP2)}`
        );
        return res.json({ ok:true, blocked:"spike" });
      }

      // Passed → recommend
      const msg =
`>> ✅ 建議進場 

📊 幣種：${normalizeSymbol(symbol)} 
⏳ 4H量價關係：${dirText(side4h)}
🕐 時區：${interval}
🎯 Entry：${fmt(entry)}
🛡 SL: ${fmt(SL)}
🥇 TP1: ${fmt(TP1)}
🥈 TP2: ${fmt(TP2)}`;

      await pushTelegram(msg);
      return res.json({ ok:true, pushed:true });
    }

    return res.json({ ok:true, ignored:"unknown type" });
  } catch (e) {
    console.error(e);
    return res.status(200).json({ ok:false, error: String(e) });
  }
};
