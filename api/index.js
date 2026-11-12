const yts = require("yt-search");
const ytdl = require("@distube/ytdl-core");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  
  const { url, type = "audio", q } = req.query;
  const path = req.url; // চেক করবে ইউজার সার্চ চাইছে নাকি ডাউনলোড

  // ১. সার্চ রিকোয়েস্ট
  if (path.includes("search")) {
    if (!q) return res.status(400).json({ success: false, error: "Query required" });
    try {
      const search = await yts(String(q));
      const results = search.videos.slice(0, 5).map(v => ({
        id: v.videoId, title: v.title, thumbnail: v.thumbnail, duration: v.timestamp, author: v.author?.name
      }));
      return res.json({ success: true, results });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ২. ডাউনলোড লিংক রিকোয়েস্ট
  if (path.includes("info")) {
    if (!url) return res.status(400).json({ success: false, error: "URL required" });
    try {
      let agent = null;
      if (process.env.YT_COOKIE) {
        try { agent = ytdl.createAgent(JSON.parse(process.env.YT_COOKIE)); } catch (e) {}
      }

      const info = await ytdl.getInfo(String(url), agent ? { agent } : {});
      const format = ytdl.chooseFormat(info.formats, {
        quality: type === "audio" ? "highestaudio" : "highest",
        filter: type === "audio" ? "audioonly" : (f) => f.hasVideo && f.hasAudio && f.container === "mp4"
      });

      return res.json({
        success: true, title: info.videoDetails.title, url: format.url, quality: format.qualityLabel || "audio"
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ৩. মেইন পেজ (যদি কেউ শুধু লিংকে হিট করে)
  return res.json({ success: true, message: "API is working perfectly!" });
};
