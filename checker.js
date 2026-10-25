// 检测引擎：调中转 API + 判定 + 追加 JSONL
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const FILE = path.join(DATA_DIR, "checks.jsonl");

// 解析失败（比如文件正被写到一半）时沿用上一次的正确配置，避免进程崩溃
let lastGoodConfig = null;
function loadConfig() {
  const raw = fs.readFileSync(path.join(ROOT, "config.json"), "utf8");
  try {
    const cfg = JSON.parse(raw);
    lastGoodConfig = cfg;
    return cfg;
  } catch (e) {
    if (lastGoodConfig) return lastGoodConfig;
    throw e; // 启动阶段还没有可用配置，让它显式失败
  }
}

function retentionDaysOf(cfg) {
  const d = Number(cfg && cfg.retentionDays);
  return Number.isFinite(d) && d > 0 ? d : 7;
}

function appendRecord(rec) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(FILE, JSON.stringify(rec) + "\n");
}

// 读取结果缓存：文件没变就不重复解析，避免每个 API 请求都全量读盘
let cache = { mtimeMs: -1, size: -1, records: null };

function parseFile(cutoff) {
  const out = [];
  for (const line of fs.readFileSync(FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (Number.isFinite(r.ts) && r.ts >= cutoff) out.push(r);
    } catch {}
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

function readRecords() {
  if (!fs.existsSync(FILE)) return [];
  const st = fs.statSync(FILE);
  if (cache.records && cache.mtimeMs === st.mtimeMs && cache.size === st.size) {
    return cache.records;
  }
  const cutoff = Date.now() - retentionDaysOf(loadConfig()) * 86400_000;
  const records = parseFile(cutoff);
  cache = { mtimeMs: st.mtimeMs, size: st.size, records };
  return records;
}

// 压缩：定期把过期行剔除后原子回写，防止 JSONL 无限膨胀
const COMPACT_INTERVAL_MS = 24 * 60 * 60 * 1000;
let lastCompactTs = 0;
function maybeCompact() {
  const now = Date.now();
  if (now - lastCompactTs < COMPACT_INTERVAL_MS) return;
  lastCompactTs = now;
  try {
    if (!fs.existsSync(FILE)) return;
    const cutoff = now - retentionDaysOf(loadConfig()) * 86400_000;
    const kept = parseFile(cutoff);
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, kept.map((r) => JSON.stringify(r)).join("\n") + (kept.length ? "\n" : ""));
    fs.renameSync(tmp, FILE);
    cache = { mtimeMs: -1, size: -1, records: null };
  } catch (e) {
    console.error("compact failed:", e); // 压缩失败不影响写入
  }
}

// 模型列表归一化：兼容旧的单模型配置（provider.model）
function modelsOf(cfg) {
  const list = Array.isArray(cfg.models) && cfg.models.length
    ? cfg.models
    : [{ model: cfg.provider && cfg.provider.model, enabled: true }];
  return list
    .filter((m) => m && typeof m.model === "string" && m.model.trim())
    .map((m, i) => ({
      id: (typeof m.id === "string" && m.id.trim()) || m.model,
      model: m.model.trim(),
      baseUrl: typeof m.baseUrl === "string" && m.baseUrl.trim() ? m.baseUrl.trim() : null,
      apiKey: typeof m.apiKey === "string" && m.apiKey.trim() ? m.apiKey.trim() : null,
      enabled: m.enabled !== false,
    }))
    .map((m, i, arr) => (arr.findIndex((x) => x.id === m.id) === i ? m : { ...m, id: `${m.id}-${i + 1}` })); // id 去重
}

// 请求一轮：启用的问题 × 启用的模型
async function runChecks(cfg) {
  const { provider } = cfg;
  const results = [];
  const models = modelsOf(cfg).filter((m) => m.enabled);
  if (!models.length) {
    console.warn("runChecks: 没有可用的检测模型（models 配置为空或全部无效）");
    return results;
  }
  for (const m of models) {
    const base = (m.baseUrl || provider.baseUrl || "").replace(/\/$/, "");
    const apiKey = m.apiKey || provider.apiKey;
    for (const q of cfg.questions.filter((q) => q.enabled !== false)) {
      const rec = {
        ts: Date.now(),
        modelId: m.id,
        questionId: q.id,
        question: q.question,
        answer: null,
        hit: null, // true/false 命中；null 表示请求异常
        latencyMs: null,
        requestId: null,
        error: null,
      };
      const started = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), provider.timeoutMs || 60000);
      try {
        const res = await fetch(base + "/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: m.model,
            messages: [{ role: "user", content: q.question }],
            max_tokens: provider.maxTokens ?? 1024,
            temperature: provider.temperature ?? 0,
          }),
          signal: ctrl.signal,
        });
        rec.latencyMs = Date.now() - started;
        rec.requestId = res.headers.get("x-request-id");
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          // 只取 body 里的 message 字段，避免整段 JSON 灌进日志
          const msg = body?.error?.message || body?.message || "";
          rec.error = `HTTP ${res.status}${msg ? ": " + String(msg).slice(0, 80) : ""}`;
        } else {
          rec.answer = body?.choices?.[0]?.message?.content ?? "";
          rec.hit = q.answerKeywords.some((k) => rec.answer.includes(k));
        }
      } catch (e) {
        rec.latencyMs = Date.now() - started;
        rec.error = e.name === "AbortError" ? "请求超时" : String(e.message || e);
      } finally {
        clearTimeout(timer);
      }
      results.push(rec);
      appendRecord(rec);
    }
  }
  maybeCompact();
  return results;
}

module.exports = { loadConfig, runChecks, readRecords, modelsOf };
