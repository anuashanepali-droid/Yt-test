const yts = require("yt-search");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { q } = req.query;
  if (!q) return res.status(400).json({ success: false, error: "Query required" });

  try {
    const search = await yts(String(q));
    const results = search.videos.slice(0, 5).map(v => ({
      id: v.videoId,
      title: v.title,
      thumbnail: v.thumbnail,
      duration: v.timestamp,
      author: v.author?.name
    }));
    return res.json({ success: true, results });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
};
