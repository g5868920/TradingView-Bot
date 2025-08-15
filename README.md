# TradingView Webhook Bot (Gina Spec)

這個專案已經幫你把所有邏輯寫好：
- 4H 量價方向（多頭漸增 / 空頭漸增）對齊
- 15m / 30m / 1H 進場訊號（多單進場 / 空單進場）
- Entry = 訊號 K 開盤價
- SL = 最近低/高點 再加實盤 0.5%
- TP1/TP2 = RR 1 / 1.5
- 不進場條件：SL% <1% 或 >3%、未進場已達 1:1、短線急漲急跌、重大數據窗口 ±12H
- 推播到 Telegram（含 emoji）

## 一步一步怎麼用

### 1) 部署到 Vercel
- New Project → Import 你的 GitHub Repo（把這個資料夾整包丟上去）
- 進入 Project → Settings → Environment Variables → 依序新增：

```
TV_SECRET=隨機密碼（TradingView & Server 都要一致）
TG_BOT_TOKEN=你的 Telegram Bot Token
TG_CHAT_ID=你的 Telegram chat id
MACRO_EVENTS_UTC=2025-09-10T12:30:00Z,2025-09-11T18:00:00Z
MACRO_WINDOW_HOURS=12
```

> 可選：接 Upstash Redis（持久化 4H 方向）
```
REDIS_URL=你的 Upstash REST URL
REDIS_TOKEN=你的 Upstash REST Token
```

部署完成後你會拿到網址，例如：
```
https://your-app.vercel.app
```

TradingView Webhook URL 就填：
```
https://your-app.vercel.app/api/tv-hook
```

### 2) TradingView 建立 Alert

**A. 4H 方向**
Message：
```json
{
  "secret": "你的TV_SECRET",
  "type": "DIRECTION_4H",
  "event": "{{condition}}",
  "symbol": "{{ticker}}",
  "interval": "{{interval}}",
  "open": {{open}},
  "close": {{close}},
  "time": "{{timenow}}"
}
```

**B. 進場訊號（15m / 30m / 1H）**
Message：
```json
{
  "secret": "你的TV_SECRET",
  "type": "ENTRY_SIGNAL",
  "event": "{{condition}}",
  "symbol": "{{ticker}}",
  "interval": "{{interval}}",
  "open": {{open}},
  "close": {{close}},
  "time": "{{timenow}}"
}
```

### 3) 測試
等待訊號或建立測試 Alert，看 Telegram 是否出現：
```
>> ✅ 建議進場 

📊 幣種：BTCUSDT.P 
⏳ 4H量價關係：多頭漸增 LONG 📈
🕐 時區：1H
🎯 Entry：124000
🛡 SL: 122000
🥇 TP1: 125000
🥈 TP2: 130000
```

### 備註
- 重大事件時間請以 UTC ISO 時間填在 `MACRO_EVENTS_UTC`，多個用逗號分隔
- 如不接 Redis，4H 方向只存在記憶體（Server 冷啟會清空）；正式上線建議接 Upstash
