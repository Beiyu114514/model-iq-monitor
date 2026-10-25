// 主服务：调度 + API + 静态页
const http = require("http");
const fs = require("fs");
const path = require("path");
const { loadConfig, runChecks, readRecords } = require("./checker");

const cfg = loadConfig();

// ---------- 数据聚合 ----------
const BUCKET_MS = 10 * 60 * 1000; // 10 分钟一格

function bucketize(records, rangeMs) {
  const cutoff = Date.now() - rangeMs;
  const map = new Map(); // bucketTs -> {hits, misses, errors}
  for (const r of records) {
    if (r.ts < cutoff) continue;
    const b = Math.floor(r.ts / BUCKET_MS) * BUCKET_MS;
    if (!map.has(b)) map.set(b, { ts: b, hits: 0, misses: 0, errors: 0 });
    const cell = map.get(b);
    if (r.hit === null || r.hit === undefined) cell.errors++;
    else if (r.hit) cell.hits++;
    else cell.misses++;
  }
  return [...map.values()].sort((a, b) => a.ts - b.ts);
}

// 把数据平均切成固定数量的窗口，用于条状历史图
function windowize(records, rangeMs, points) {
  const end = Date.now();
  const start = end - rangeMs;
  const step = rangeMs / points;
  const cells = Array.from({ length: points }, (_, i) => ({
    ts: Math.round(start + i * step),
    hits: 0,
    misses: 0,
    errors: 0,
  }));
  for (const r of records) {
    if (r.ts < start || r.ts > end) continue;
    const idx = Math.min(points - 1, Math.floor((r.ts - start) / step));
    const cell = cells[idx];
    if (r.hit === null || r.hit === undefined) cell.errors++;
    else if (r.hit) cell.hits++;
    else cell.misses++;
  }
  return cells;
}

function summary(records) {
  const day = records.filter((r) => r.ts >= Date.now() - 86400_000 && r.hit !== null && r.hit !== undefined);
  const recent = records[records.length - 1];
  const lat = day.filter((r) => r.latencyMs);
  return {
    rate24h: day.length ? +(day.filter((r) => r.hit).length / day.length * 100).toFixed(1) : null,
    avgLatency: lat.length ? Math.round(lat.reduce((s, r) => s + r.latencyMs, 0) / lat.length) : null,
    lastCheck: recent ? { ts: recent.ts, hit: recent.hit, answer: recent.answer, error: recent.error, questionId: recent.questionId } : null,
  };
}

// ---------- 调度 ----------
let running = false;
async function tick() {
  if (running) return false;
  running = true;
  try {
    const results = await runChecks(loadConfig()); // 每次重读配置，改题不用重启
    for (const r of results) {
      console.log(new Date(r.ts).toISOString(), r.questionId, r.hit === null ? "ERROR" : r.hit ? "HIT" : "MISS", r.latencyMs + "ms", r.error || "");
    }
  } catch (e) {
    console.error("tick failed:", e);
  } finally {
    running = false;
    schedule(); // 每轮结束后按最新配置重排，intervalMinutes 热更新
  }
  return true;
}

// 间隔支持热更新：改 intervalMinutes 不用重启
let schedulerTimer = null;
function schedule() {
  if (process.env.DISABLE_SCHEDULER === "1") return;
  if (schedulerTimer) clearInterval(schedulerTimer);
  const minutes = Number(loadConfig().intervalMinutes);
  schedulerTimer = setInterval(tick, (Number.isFinite(minutes) && minutes > 0 ? minutes : 1) * 60 * 1000);
}
if (process.env.DISABLE_SCHEDULER !== "1") {
  setTimeout(tick, 3000); // 启动后先跑一次
  schedule();
}

// ---------- API ----------
function json(res, data) {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

const PUBLIC_ROOT = path.join(__dirname, "public") + path.sep;

const server = http.createServer((req, res) => {
  // 任何未捕获异常都不能打挂进程
  try {
    handle(req, res);
  } catch (e) {
    console.error("request failed:", e);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("internal error");
  }
});

function handle(req, res) {
  let url;
  try {
    url = new URL(req.url, "http://x");
  } catch {
    res.writeHead(400); return res.end("bad request");
  }
  const p = url.pathname;
  if (p === "/api/summary") return json(res, summary(readRecords()));
  if (p === "/api/history") {
    const range = url.searchParams.get("range") === "3d" ? 3 * 86400_000 : 86400_000;
    const points = Math.min(Math.max(+url.searchParams.get("points") || 0, 0), 500);
    const records = readRecords();
    return json(res, points > 0 ? windowize(records, range, points) : bucketize(records, range));
  }
  if (p === "/api/logs") {
    const n = +url.searchParams.get("limit");
    const limit = Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 60;
    const records = readRecords();
    return json(res, records.slice(-limit).reverse());
  }
  if (p === "/api/config") return json(res, {
    questions: loadConfig().questions,
    intervalMinutes: loadConfig().intervalMinutes,
    retentionDays: loadConfig().retentionDays,
    needToken: Boolean(loadConfig().checkToken),
  });
  if (p === "/api/check" && req.method === "POST") { // 手动触发一次
    // 配置了 token 时要求请求带上，避免暴露公网时被人刷真实 API 调用
    const token = loadConfig().checkToken;
    const given = req.headers["x-check-token"] || url.searchParams.get("token");
    if (token && given !== token) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: false, error: "invalid token" }));
    }
    if (process.env.DISABLE_SCHEDULER === "1") return json(res, { ok: true, demo: true });
    // 上轮还没跑完时如实告知，而不是假装已排队
    const started = tick();
    return json(res, { ok: true, queued: true, started });
  }
  // 静态页
  let file = p === "/" ? "/index.html" : p;
  const fp = path.join(__dirname, "public", path.normalize(file));
  if (fp.startsWith(PUBLIC_ROOT) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    const ext = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" }[path.extname(fp)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": ext + "; charset=utf-8" });
    return res.end(fs.readFileSync(fp));
  }
  res.writeHead(404); res.end("not found");
}

server.listen(cfg.port || 8787, () => console.log(`listening on http://localhost:${cfg.port || 8787}`));
