// /api/self-test.js
const TG_API = (token) => `https://api.telegram.org/bot${token}/sendMessage`;

module.exports = async (req, res) => {
  try {
    const text = (req.query.text || "Self test OK").toString();
    if (!process.env.TG_BOT_TOKEN || !process.env.TG_CHAT_ID) {
      return res.status(200).json({ ok:false, error:"Missing TG env vars" });
    }
    await fetch(TG_API(process.env.TG_BOT_TOKEN), {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ chat_id: process.env.TG_CHAT_ID, text: `🔔 ${text}` })
    });
    return res.status(200).json({ ok:true });
  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e) });
  }
};
