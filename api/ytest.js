/*
 * পরীক্ষা: ভার্সেল থেকে PO Token সহ YouTube অডিও নামানো যায় কিনা
 * ব্যবহার:
 *   /api/ytest?key=KEY                  PO Token সহ, কুকিজ ছাড়া (প্রথমে এটা চালাও)
 *   /api/ytest?key=KEY&cookies=1&src=file  PO Token সহ, কুকিজ সহ (গিটহাবের cookies.txt থেকে)
 *   /api/ytest?key=KEY&cookies=1        PO Token সহ, কুকিজ সহ (YT_COOKIES থেকে, না থাকলে cookies.txt)
 *   /api/ytest?key=KEY&pot=0            PO Token ছাড়া (তুলনার জন্য)
 *   /api/ytest?key=KEY&client=web       YouTube এর "web" ক্লায়েন্ট জোর করে (PO Token চাইবে)
 *   /api/ytest?key=KEY&v=ভিডিও_আইডি     অন্য ভিডিও
 */
const fs = require("fs");
const path = require("path");
const { execFile, spawn } = require("child_process");
const AdmZip = require("adm-zip");

const BIN = "/tmp/yt-dlp";
const POT_BIN = "/tmp/bgutil-pot";
const PLUGIN_DIR = "/tmp/yt-dlp-plugins";
const COOKIE_FILE = "/tmp/cookies.txt";
const POT_PORT = 4416;
const GH = "https://github.com";

async function download(url, dest, mode) {
	const r = await fetch(url, { redirect: "follow" });
	if (!r.ok) throw new Error(`নামানো যায়নি (${r.status}): ${url}`);
	fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
	if (mode) fs.chmodSync(dest, mode);
}

function bigEnough(f) {
	return fs.existsSync(f) && fs.statSync(f).size > 1024 * 1024;
}

async function ensureYtDlp() {
	if (bigEnough(BIN)) return;
	const asset = process.arch === "arm64" ? "yt-dlp_linux_aarch64" : "yt-dlp_linux";
	await download(`${GH}/yt-dlp/yt-dlp/releases/latest/download/${asset}`, BIN, 0o755);
}

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

// প্লাগইনের আসল ফোল্ডার খুঁজে বের করা (যেখানে yt_dlp_plugins আছে)
function findPluginRoot(dir, depth = 0) {
	if (fs.existsSync(path.join(dir, "yt_dlp_plugins"))) return dir;
	if (depth > 2) return null;
	for (const name of fs.readdirSync(dir)) {
		const p = path.join(dir, name);
		if (fs.statSync(p).isDirectory()) {
			const r = findPluginRoot(p, depth + 1);
			if (r) return r;
		}
	}
	return null;
}

async function ensurePotPlugin(info) {
	const target = path.join(PLUGIN_DIR, "bgutil-ytdlp-pot-provider");
	if (fs.existsSync(path.join(target, "yt_dlp_plugins"))) return;

	const zipPath = "/tmp/bgutil-plugin.zip";
	await download(`${GH}/jim60105/bgutil-ytdlp-pot-provider-rs/releases/latest/download/bgutil-ytdlp-pot-provider-rs.zip`, zipPath);
	const tmp = "/tmp/plug_tmp";
	fs.rmSync(tmp, { recursive: true, force: true });
	new AdmZip(zipPath).extractAllTo(tmp, true);
	const root = findPluginRoot(tmp);
	if (!root) throw new Error("প্লাগইন জিপে yt_dlp_plugins ফোল্ডার পাওয়া যায়নি");
	fs.mkdirSync(PLUGIN_DIR, { recursive: true });
	fs.rmSync(target, { recursive: true, force: true });
	fs.cpSync(root, target, { recursive: true });
	info.pluginFiles = fs.readdirSync(path.join(target, "yt_dlp_plugins", "extractor"));
}

async function startPotServer(info) {
	if (!bigEnough(POT_BIN)) {
		await download(`${GH}/jim60105/bgutil-ytdlp-pot-provider-rs/releases/latest/download/bgutil-pot-linux-x86_64`, POT_BIN, 0o755);
	}
	await ensurePotPlugin(info);

	const proc = spawn(POT_BIN, ["server", "--host", "127.0.0.1", "--port", String(POT_PORT)], {
		env: { ...process.env, HOME: "/tmp", CACHE_DIR: "/tmp/potcache", RUST_LOG: "info" },
		stdio: ["ignore", "pipe", "pipe"]
	});
	let log = "";
	const add = d => { log = (log + d).slice(-1500); };
	proc.stdout.on("data", add);
	proc.stderr.on("data", add);
	let exited = null;
	proc.on("exit", (code, sig) => { exited = `code=${code} sig=${sig}`; });
	proc.on("error", e => { exited = "spawn error: " + e.message; });

	let ready = false;
	for (let i = 0; i < 20 && !ready && !exited; i++) {
		await new Promise(r => setTimeout(r, 500));
		try {
			const r = await fetch(`http://127.0.0.1:${POT_PORT}/ping`, { signal: AbortSignal.timeout(1500) });
			ready = r.ok;
		} catch (_) { }
	}
	info.potServer = ready ? "চালু" : `চালু হয়নি ${exited ? "(" + exited + ")" : ""}`;
	if (!ready) info.potServerLog = log.slice(-600);
	return { proc, ready };
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
	const usePot = q.pot !== "0";
	const useCookies = q.cookies === "1";
	const out = { video: v, node: process.version, usePot, useCookies };
	let pot = null;

	try {
		try {
			const r = await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(4000) });
			out.ip = (await r.json()).ip;
		} catch (_) { }

		await ensureYtDlp();
		out.binReadyMs = Date.now() - t0;

		if (usePot) {
			try {
				pot = await startPotServer(out);
			} catch (e) {
				out.potSetupError = String(e && e.message || e);
			}
		}

		const cookieArgs = [];
		if (useCookies) {
			const ck = loadCookies(q.src === "file");
			out.hasCookies = !!ck;
			if (ck) { out.cookieInfo = ck; cookieArgs.push("--cookies", COOKIE_FILE); }
		}

		// ?client=web বা ?client=web,mweb দিলে ওই YouTube ক্লায়েন্ট জোর করে ব্যবহার হবে
		const clientArgs = /^[a-z_,]+$/.test(q.client || "")
			? ["--extractor-args", `youtube:player_client=${q.client}`]
			: [];
		out.client = q.client || "default";

		const base = `/tmp/t_${Date.now()}`;
		const args = [
			"--js-runtimes", `node:${process.execPath}`,
			"--remote-components", "ejs:github",
			"--extractor-args", `youtubepot-bgutilhttp:base_url=http://127.0.0.1:${POT_PORT}`,
			...clientArgs,
			...cookieArgs,
			"-v",
			"--no-playlist",
			"--max-filesize", "30M",
			"--retries", "1",
			"--fragment-retries", "1",
			"--socket-timeout", "20",
			"--cache-dir", "/tmp/ytc",
			"-f", "bestaudio/best",
			"-o", `${base}.%(ext)s`,
			`https://www.youtube.com/watch?v=${v}`
		];

		const r = await run(args, 45000);
		const text = r.stderr + "\n" + r.stdout;

		out.log = text
			.split("\n")
			.map(l => l.replace(/^\[debug\]\s*/i, "").trim())
			.filter(l => /WARNING|ERROR|JS runtimes|PO Token|pot:|bgutil|403|Sign in|bot|Destination|images/i.test(l))
			.slice(0, 16)
			.map(l => l.slice(0, 180));

		const file = fs.readdirSync("/tmp").find(f => f.startsWith(base.split("/").pop() + "."));
		if (file) {
			out.fileSize = fs.statSync("/tmp/" + file).size;
			fs.unlinkSync("/tmp/" + file);
		}
		out.ok = !r.err && !!out.fileSize;
		out.verdict = out.ok
			? "✅ ভার্সেল থেকে YouTube অডিও নামানো গেছে"
			: "❌ ফেল (log দেখো)";
	} catch (e) {
		out.ok = false;
		out.error = String(e && e.message || e);
	} finally {
		if (pot && pot.proc) { try { pot.proc.kill(); } catch (_) { } }
	}

	out.totalMs = Date.now() - t0;
	res.status(200).json(out);
};
		
