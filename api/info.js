const Youtube = require("mediatube").default;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { url, type = "audio" } = req.query;

  if (!url) return res.status(400).json({ success: false, error: "URL required" });

  try {
    const downloader = new Youtube({
      type: type === "audio" ? "mp3" : "mp4",
      query: String(url),
      // Vercel-এ কুকি লাগবে, নিচে এনভায়রনমেন্ট ভ্যারিয়েবল থেকে নিন
      cookies: process.env.YT_COOKIE ? JSON.parse(process.env.YT_COOKIE) : undefined
    });

    const result = await downloader.download();

    return res.json({
      success: true,
      title: result.title,
      url: result.videoUrl || result.url, // mediatube সরাসরি স্ট্রিম URL দেয়
      quality: type === "audio" ? "audio" : "video"
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
};
