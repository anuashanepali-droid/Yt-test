const ytdl = require("@distube/ytdl-core");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { url, type = "audio" } = req.query;

  if (!url || !ytdl.validateURL(String(url))) {
    return res.status(400).json({ success: false, error: "Invalid YouTube URL" });
  }

  try {
    // কুকি সাপোর্ট (যদি Vercel-এ YT_COOKIE সেট করা থাকে)
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
      success: true,
      title: info.videoDetails.title,
      url: format.url, // সরাসরি ডাউনলোড লিংক
      quality: format.qualityLabel || `${format.audioBitrate}kbps`
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
};
