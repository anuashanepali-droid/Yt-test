/*
 * ছোট পরীক্ষা: ভার্সেলের সার্ভার থেকে YouTube অডিও নামানো যায় কিনা
 * ব্যবহার: /api/ytest?key=তোমার_TEST_KEY            (ডাউনলোড পরীক্ষা)
 *          /api/ytest?key=...&mode=list             (শুধু ফরম্যাট তালিকা)
 *          /api/ytest?key=...&v=ভিডিও_আইডি          (অন্য ভিডিও)
 *          /api/ytest?key=...&src=file              (কুকিজ রিপোর cookies.txt থেকে)
 */
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const BIN = "/tmp/yt-dlp";
const COOKIE_FILE = "/tmp/cookies.txt";


// কুকিজের লেখা ঠিক করা: পেস্ট করার সময় ট্যাব স্পেস হয়ে গেলে আবার ট্যাব বসায়
function normalizeCookies(txt) {
	const lines = String(txt).replace(/\\n/g, "\n").replace(/\r/g, "").split("\n");
	const out = [];
	let fixed = 0;
	let cookieLines = 0;
	for (const raw of lines) {
		const line = raw.trim();
		if (!line) continue;
		if (line.startsWith("#") && !line.startsWith("#HttpOnly_")) { out.push(line); continue; }
		const parts = line.split(/\s+/);
		if (parts.length >= 7) {
			const fixedLine = [...parts.slice(0, 6), parts.slice(6).join(" ")].join("\t");
			if (fixedLine !== line) fixed++;
			out.push(fixedLine);
			cookieLines++;
		} else {
			out.push(line);
		}
	}
	if (!out.length || !/^# (Netscape|HTTP Cookie)/i.test(out[0])) out.unshift("# Netscape HTTP Cookie File");
	return { text: out.join("\n") + "\n", fixed, cookieLines };
}

function loadCookies(forceFile) {
	let raw = null;
	let source = "none";
	if (!forceFile && process.env.YT_COOKIES) {
		raw = process.env.YT_COOKIES;
		source = "env";
	} else {
		try {
			raw = fs.readFileSync(path.join(process.cwd(), "cookies.txt"), "utf8");
			source = "file";
		} catch (_) { }
	}
	if (!raw) return null;
	const n = normalizeCookies(raw);
	fs.writeFileSync(COOKIE_FILE, n.text);
	return { source, cookieLines: n.cookieLines, fixedTabs: n.fixed };
}

async function ensureBin() {
	if (fs.existsSync(BIN) && fs.statSync(BIN).size > 1024 * 1024) return;
	const asset = process.arch === "arm64" ? "yt-dlp_linux_aarch64" : "yt-dlp_linux";
	const r = await fetch(
		`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`,
		{ redirect: "follow" }
	);
	if (!r.ok) throw new Error("yt-dlp নামানো যায়নি: HTTP " + r.status);
	fs.writeFileSync(BIN, Buffer.from(await r.arrayBuffer()));
	fs.chmodSync(BIN, 0o755);
}

function run(args, timeout) {
	return new Promise(resolve => {
		execFile(
			BIN,
			args,
			{ timeout, maxBuffer: 1 << 25, env: { ...process.env, HOME: "/tmp" } },
			(err, stdout, stderr) =>
				resolve({ err, stdout: String(stdout || ""), stderr: String(stderr || "") })
		);
	});
}

module.exports = async (req, res) => {
	const t0 = Date.now();
	const q = req.query || {};

	// গোপন কী ছাড়া কেউ চালাতে পারবে না
	if (!process.env.TEST_KEY || q.key !== process.env.TEST_KEY) {
		res.status(401).json({ error: "unauthorized" });
		return;
	}

	const v = /^[\w-]{11}$/.test(q.v || "") ? q.v : "e2mUj9rGSmQ";
	const mode = q.mode === "list" ? "list" : "download";
	const out = { video: v, mode, node: process.version };

	try {
		// সার্ভারের বাইরের IP (শুধু জানার জন্য)
		try {
			const r = await fetch("https://api.ipify.org?format=json", {
				signal: AbortSignal.timeout(4000)
			});
			out.ip = (await r.json()).ip;
		} catch (_) { }

		await ensureBin();
		out.binReadyMs = Date.now() - t0;

		const cookieArgs = [];
		const ck = loadCookies(q.src === "file");
		out.hasCookies = !!ck;
		if (ck) {
			out.cookieInfo = ck;
			cookieArgs.push("--cookies", COOKIE_FILE);
		}

		const base = `/tmp/t_${Date.now()}`;
		const args = [
			"--js-runtimes", `node:${process.execPath}`,
			"--remote-components", "ejs:github",
			...cookieArgs,
			"-v",
			"--no-playlist",
			"--max-filesize", "30M",
			"--retries", "1",
			"--fragment-retries", "1",
			"--socket-timeout", "20",
			"--cache-dir", "/tmp/ytc"
		];
		if (mode === "list") args.push("-F", "--skip-download");
		else args.push("-f", "bestaudio/best", "-o", `${base}.%(ext)s`);
		args.push(`https://www.youtube.com/watch?v=${v}`);

		const r = await run(args, 50000);
		const text = r.stderr + "\n" + r.stdout;

		// দরকারি লাইনগুলো
		out.log = text
			.split("\n")
			.map(l => l.replace(/^\[debug\]\s*/i, "").trim())
			.filter(l => /WARNING|ERROR|JS runtimes|jsc|PO Token|403|Sign in|bot|Destination|format|images/i.test(l))
			.slice(0, 14)
			.map(l => l.slice(0, 180));

		if (mode === "download") {
			const file = fs.readdirSync("/tmp").find(f => f.startsWith(base.split("/").pop() + "."));
			if (file) {
				out.fileSize = fs.statSync("/tmp/" + file).size;
				fs.unlinkSync("/tmp/" + file);
			}
			out.ok = !r.err && !!out.fileSize;
		} else {
			out.ok = !r.err && /audio only/i.test(text);
		}
		out.verdict = out.ok
			? "✅ ভার্সেল থেকে YouTube কাজ করছে"
			: "❌ ফেল (log দেখো: 403 / Sign in / images মানে YouTube আটকাচ্ছে)";
	} catch (e) {
		out.ok = false;
		out.error = String(e && e.message || e);
	}

	out.totalMs = Date.now() - t0;
	res.status(200).json(out);
};
