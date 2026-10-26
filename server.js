// 主服务：调度 + API + 静态页
const http = require("http");
const fs = require("fs");
const path = require("path");
const { loadConfig, runChecks, readRecords, modelsOf } = require("./checker");

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
function isRunning() {
  return running;
}
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
    try {
      schedule(); // 配置里的间隔变了才重排，手动检测不会推迟下一次定时检测
    } catch (e) {
      console.error("reschedule failed:", e);
    }
  }
  return true;
}

// 间隔支持热更新：改 intervalMinutes 不用重启
let schedulerTimer = null;
let schedulerMinutes = null;
function schedule() {
  if (process.env.DISABLE_SCHEDULER === "1") return;
  const m = Number(loadConfig().intervalMinutes);
  const minutes = Number.isFinite(m) && m > 0 ? m : 1;
  if (schedulerTimer && schedulerMinutes === minutes) return;
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerMinutes = minutes;
  schedulerTimer = setInterval(tick, minutes * 60 * 1000);
}
if (process.env.DISABLE_SCHEDULER !== "1") {
  setTimeout(tick, 3000); // 启动后先跑一次
  schedule();
}

// ---------- API ----------
function json(res, data, cors = true) {
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    ...(cors ? { "Access-Control-Allow-Origin": "*" } : {}),
  });
  res.end(JSON.stringify(data));
}

const PUBLIC_ROOT = path.join(__dirname, "public") + path.sep;
const CONFIG_PATH = path.join(__dirname, "config.json");

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

// ---------- 管理页 API ----------
const MAX_BODY = 1e6;

// 必须按 Buffer 拼接后再整体解码，否则跨 TCP 分片的多字节字符会被截断成 U+FFFD
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    const fail = (e) => {
      if (failed) return;
      failed = true;
      reject(e);
    };
    req.on("data", (c) => {
      if (failed) return;
      size += c.length;
      if (size > MAX_BODY) return fail(new Error("body too large"));
      chunks.push(c);
    });
    req.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks, size).toString("utf8"));
    });
    req.on("error", fail);
  });
}

// 校验并规范化管理提交的配置；返回 {ok, cfg} 或 {ok:false, error}
function sanitizeConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "配置格式错误" };
  const out = { ...input };
  if (out.provider !== undefined) {
    const p = out.provider;
    if (!p || typeof p !== "object" || Array.isArray(p)) return { ok: false, error: "provider 格式错误" };
    if (p.baseUrl !== undefined && typeof p.baseUrl !== "string") return { ok: false, error: "provider.baseUrl 需为字符串" };
    if (p.apiKey !== undefined && typeof p.apiKey !== "string") return { ok: false, error: "provider.apiKey 需为字符串" };
    if (p.model !== undefined && typeof p.model !== "string") return { ok: false, error: "provider.model 需为字符串" };
    if (p.timeoutMs !== undefined && (!Number.isFinite(Number(p.timeoutMs)) || Number(p.timeoutMs) <= 0)) {
      return { ok: false, error: "provider.timeoutMs 需为正数" };
    }
    out.provider = {
      ...p,
      baseUrl: typeof p.baseUrl === "string" ? p.baseUrl.trim() : "",
      apiKey: typeof p.apiKey === "string" ? p.apiKey.trim() : "",
    };
  }
  if (!Array.isArray(out.questions) || out.questions.length === 0) return { ok: false, error: "questions 不能为空" };
  const qIds = new Set();
  const questions = [];
  for (const [i, q] of out.questions.entries()) {
    if (!q || typeof q !== "object") return { ok: false, error: `第 ${i + 1} 题格式错误` };
    if (typeof q.id !== "string" || !q.id.trim()) return { ok: false, error: `第 ${i + 1} 题缺少 id` };
    if (typeof q.question !== "string" || !q.question.trim()) return { ok: false, error: `第 ${i + 1} 题缺少 question` };
    if (!Array.isArray(q.answerKeywords) || q.answerKeywords.length === 0) return { ok: false, error: `第 ${i + 1} 题缺少 answerKeywords` };
    const keywords = q.answerKeywords.map((k) => (typeof k === "string" ? k.trim() : ""));
    if (keywords.some((k) => !k)) return { ok: false, error: `第 ${i + 1} 题的关键词不能为空` };
    const id = q.id.trim();
    if (qIds.has(id)) return { ok: false, error: `问题 ID「${id}」重复` };
    qIds.add(id);
    questions.push({ ...q, id, question: q.question.trim(), answerKeywords: keywords, enabled: q.enabled !== false });
  }
  out.questions = questions;
  const im = Number(out.intervalMinutes);
  if (!Number.isFinite(im) || im < 1 || im > 1440) return { ok: false, error: "intervalMinutes 需在 1-1440 之间" };
  out.intervalMinutes = im;
  const rd = Number(out.retentionDays);
  if (!Number.isFinite(rd) || rd < 1 || rd > 365) return { ok: false, error: "retentionDays 需在 1-365 之间" };
  out.retentionDays = rd;
  if (out.checkToken !== undefined && typeof out.checkToken !== "string") return { ok: false, error: "checkToken 需为字符串" };
  if (out.checkToken === "") delete out.checkToken;
  if (out.adminToken !== undefined && typeof out.adminToken !== "string") return { ok: false, error: "adminToken 需为字符串" };
  if (out.adminToken === "") delete out.adminToken;
  if (out.models !== undefined) {
    if (!Array.isArray(out.models) || out.models.length === 0) return { ok: false, error: "models 不能为空" };
    const seen = new Set();
    const models = [];
    for (const [i, m] of out.models.entries()) {
      if (!m || typeof m !== "object") return { ok: false, error: `第 ${i + 1} 个模型格式错误` };
      if (typeof m.model !== "string" || !m.model.trim()) return { ok: false, error: `第 ${i + 1} 个模型缺少 model 名称` };
      const id = (typeof m.id === "string" && m.id.trim()) || m.model.trim();
      if (seen.has(id)) return { ok: false, error: `模型 ID「${id}」重复` };
      seen.add(id);
      models.push({
        id,
        model: m.model.trim(),
        baseUrl: typeof m.baseUrl === "string" ? m.baseUrl.trim() : "",
        apiKey: typeof m.apiKey === "string" ? m.apiKey.trim() : "",
        enabled: m.enabled !== false,
      });
    }
    out.models = models;
  }
  return { ok: true, cfg: out };
}

// 写盘时沿用原文件的权限位，避免一次保存就让 config.json 里的密钥对其他系统用户可读
function writeConfig(next) {
  const tmp = CONFIG_PATH + ".tmp";
  const mode = fs.statSync(CONFIG_PATH).mode & 0o777;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode });
    fs.chmodSync(tmp, mode); // tmp 若是残留文件，open 时的 mode 不生效
    fs.renameSync(tmp, CONFIG_PATH);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

function remoteIsLocal(req) {
  const ip = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  if (ip !== "127.0.0.1" && ip !== "::1") return false;
  // 同机反代会让远端请求看起来来自本机；带了转发头就不当作本机
  if (req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || req.headers["forwarded"]) return false;
  return true;
}

const maskKey = (k) => {
  if (typeof k !== "string" || !k) return "";
  if (k.length <= 12) return "***";
  return k.slice(0, 4) + "***" + k.slice(-4);
};

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
    const points = Math.floor(Math.min(Math.max(+url.searchParams.get("points") || 0, 0), 500));
    const records = readRecords();
    return json(res, points > 0 ? windowize(records, range, points) : bucketize(records, range));
  }
  if (p === "/api/logs") {
    const n = +url.searchParams.get("limit");
    const limit = Number.isInteger(n) && n > 0 ? Math.min(n, 200) : 60;
    const records = readRecords();
    return json(res, records.slice(-limit).reverse());
  }
  if (p === "/api/config") {
    const conf = loadConfig();
    return json(res, {
      questions: conf.questions,
      intervalMinutes: conf.intervalMinutes,
      retentionDays: conf.retentionDays,
      needToken: Boolean(conf.checkToken),
      models: modelsOf(conf).filter((m) => m.enabled).map((m) => m.id),
    });
  }
  if (p === "/api/check" && req.method === "POST") { // 手动触发一次
    // 配置了 token 时要求请求带上，避免暴露公网时被人刷真实 API 调用
    const conf = loadConfig();
    const token = conf.checkToken;
    const given = req.headers["x-check-token"] || url.searchParams.get("token");
    if (token && given !== token) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: false, error: "invalid token" }));
    }
    if (process.env.DISABLE_SCHEDULER === "1") return json(res, { ok: true, demo: true });
    if (!modelsOf(conf).some((m) => m.enabled)) return json(res, { ok: false, error: "没有启用的检测模型" });
    // tick 是 async 的，调用返回的是 Promise；用同步守卫判断是否真的开始
    const started = !isRunning();
    tick();
    return json(res, { ok: true, queued: true, started });
  }
  // ---------- 管理接口：读/写完整配置，需管理员 token ----------
  if (p === "/api/admin/config") {
    const cfgNow = loadConfig();
    const adminToken = cfgNow.adminToken; // 不再回退到 checkToken：看板令牌不应能改配置
    const given = req.headers["x-admin-token"] || url.searchParams.get("token");
    // 未配置管理员令牌时仅允许本机访问，避免公网裸奔
    if (adminToken ? given !== adminToken : !remoteIsLocal(req)) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: false, error: "未授权" }));
    }
    if (req.method === "GET") {
      // apiKey 打码后再下发（provider 与每个模型）；模型用归一化结果，兼容旧版单模型配置
      return json(res, {
        ...cfgNow,
        provider: { ...(cfgNow.provider || {}), apiKey: maskKey(cfgNow.provider?.apiKey) },
        models: modelsOf(cfgNow).map((m) => ({
          id: m.id,
          model: m.model,
          baseUrl: m.baseUrl || "",
          apiKey: maskKey(m.apiKey),
          enabled: m.enabled,
        })),
      }, false);
    }
    if (req.method === "PUT") {
      return readBody(req).then((buf) => {
        let input;
        try { input = JSON.parse(buf); } catch { return json(res, { ok: false, error: "JSON 解析失败" }, false); }
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          return json(res, { ok: false, error: "配置格式错误" }, false);
        }
        const cur = loadConfig();
        const unmask = (sent, real) => (typeof sent === "string" && sent.includes("***") ? real || "" : sent);
        // apiKey 不在前端明文下发：打码值还原原值，新填的明文原样保留
        if (input.provider && typeof input.provider === "object") {
          input.provider = { ...input.provider, apiKey: unmask(input.provider.apiKey, cur.provider?.apiKey) };
        }
        if (Array.isArray(input.models)) {
          const curList = modelsOf(cur);
          const byId = new Map(curList.map((m) => [m.id, m]));
          const byModel = new Map();
          for (const m of curList) if (!byModel.has(m.model)) byModel.set(m.model, m);
          const missing = [];
          input.models = input.models.map((m, idx) => {
            if (!m || typeof m !== "object") return m;
            const sent = typeof m.apiKey === "string" ? m.apiKey : "";
            if (!sent.includes("***")) return { ...m, apiKey: sent };
            // 只按 id / 模型名还原；对不上时宁可报错让用户重填，也不能按位置套用别人的密钥
            const key = (typeof m.id === "string" && m.id.trim()) || (typeof m.model === "string" ? m.model.trim() : "");
            let real = byId.get(key);
            if (!real && typeof m.model === "string") real = byModel.get(m.model.trim());
            if (!real) { missing.push(idx + 1); return { ...m, apiKey: "" }; }
            return { ...m, apiKey: real.apiKey || "" };
          });
          if (missing.length) {
            return json(res, {
              ok: false,
              error: `第 ${missing.join("、")} 个模型的 API Key 无法对应到原配置（ID 或模型名已改），请重新填写后再保存`,
            }, false);
          }
        }
        const result = sanitizeConfig(input);
        if (!result.ok) return json(res, { ok: false, error: result.error }, false);
        const next = { ...cur, ...result.cfg };
        // sanitize 删掉了空令牌，但展开 cur 会把旧值带回来，必须显式删除才能吊销
        if (input.checkToken === "") delete next.checkToken;
        if (input.adminToken === "") delete next.adminToken;
        writeConfig(next);
        try { schedule(); } catch (e) { console.error("reschedule failed:", e); }
        return json(res, { ok: true }, false);
      }).catch((e) => {
        const code = e.message === "body too large" ? 413 : 500;
        res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      });
    }
  }
  // 静态页
  let file = p === "/" ? "/index.html" : p;
  const fp = path.join(__dirname, "public", path.normalize(file));
  if (fp.startsWith(PUBLIC_ROOT) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    const ext = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" }[path.extname(fp)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": ext + "; charset=utf-8" });
    return res.end(fs.readFileSync(fp));
  }
  if (p === "/admin") { // 管理页（无 .html 后缀也可访问）
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(path.join(__dirname, "public", "admin.html")));
  }
  res.writeHead(404); res.end("not found");
}

server.listen(cfg.port || 8787, () => console.log(`listening on http://localhost:${cfg.port || 8787}`));
