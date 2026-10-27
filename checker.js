// 检测引擎：调中转 API + 判定 + 追加 JSONL
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const FILE = path.join(DATA_DIR, "checks.jsonl");

// 读盘或解析失败（比如文件正被写到一半）时沿用上一次的正确配置，避免进程崩溃
let lastGoodConfig = null;
function loadConfig() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, "config.json"), "utf8");
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

function parseLines(text, cutoff) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (Number.isFinite(r.ts) && r.ts >= cutoff) out.push(r);
    } catch {}
  }
  return out;
}

// 返回已解析条数和「完整行」的字节长度；末尾没写完的半行不计入，避免下次读取时被跳过
function parseFile(cutoff) {
  const text = fs.readFileSync(FILE, "utf8");
  const lastNl = text.lastIndexOf("\n");
  const complete = lastNl >= 0 ? text.slice(0, lastNl + 1) : "";
  const records = parseLines(complete, cutoff);
  records.sort((a, b) => a.ts - b.ts);
  return { records, size: Buffer.byteLength(complete) };
}

// 读取结果缓存：文件没变就不重复解析；只追加时仅解析新增的完整行
const TAIL_BYTES = 256;
let cache = { ino: -1, size: -1, mtimeMs: -1, days: null, records: null, tail: Buffer.alloc(0) };

// 读 size 之前的最后一小段字节，用来识别「原地重写」而非追加
function readTail(fd, size) {
  const n = Math.min(size, TAIL_BYTES);
  if (n <= 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(n);
  const read = fs.readSync(fd, buf, 0, n, size - n);
  return buf.subarray(0, read);
}

function readRecords() {
  if (!fs.existsSync(FILE)) return [];
  const st = fs.statSync(FILE);
  const days = retentionDaysOf(loadConfig());
  if (cache.records && cache.ino === st.ino && cache.size === st.size && cache.mtimeMs === st.mtimeMs && cache.days === days) {
    return cache.records;
  }
  const cutoff = Date.now() - days * 86400_000;
  // 常见路径：同一文件只追加了新行，从上次读完的位置继续解析
  if (cache.records && cache.ino === st.ino && cache.days === days && st.size > cache.size) {
    const fd = fs.openSync(FILE, "r");
    try {
      // 文件被原地截断重写时前缀会变，必须整体重读，不能按「追加」处理
      if (readTail(fd, cache.size).equals(cache.tail)) {
        const len = st.size - cache.size;
        const buf = Buffer.alloc(len);
        const read = fs.readSync(fd, buf, 0, len, cache.size);
        const text = buf.subarray(0, read).toString("utf8");
        const lastNl = text.lastIndexOf("\n");
        if (lastNl >= 0) {
          const complete = text.slice(0, lastNl + 1);
          const added = parseLines(complete, cutoff);
          const lastTs = cache.records.length ? cache.records[cache.records.length - 1].ts : -Infinity;
          const records = added.length && added[0].ts < lastTs
            ? cache.records.concat(added).sort((a, b) => a.ts - b.ts)
            : cache.records.concat(added);
          const size = cache.size + Buffer.byteLength(complete);
          cache = { ino: st.ino, size, mtimeMs: st.mtimeMs, days, records, tail: readTail(fd, size) };
          return records;
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  const { records, size } = parseFile(cutoff);
  const fd = fs.openSync(FILE, "r");
  let tail;
  try {
    tail = readTail(fd, size);
  } finally {
    fs.closeSync(fd);
  }
  // size 只记到最后一个完整行：没写完的半行留给下次读取
  cache = { ino: st.ino, size, mtimeMs: st.mtimeMs, days, records, tail };
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
    const { records: kept } = parseFile(cutoff);
    const tmp = FILE + ".tmp";
    const mode = fs.statSync(FILE).mode & 0o777;
    try {
      fs.writeFileSync(tmp, kept.map((r) => JSON.stringify(r)).join("\n") + (kept.length ? "\n" : ""), { mode });
      fs.chmodSync(tmp, mode);
      fs.renameSync(tmp, FILE);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      throw e;
    }
    cache = { ino: -1, size: -1, mtimeMs: -1, days: null, records: null, tail: Buffer.alloc(0) };
  } catch (e) {
    console.error("compact failed:", e); // 压缩失败不影响写入
  }
}

// 模型列表归一化：兼容旧的单模型配置（provider.model）
function modelsOf(cfg) {
  const list = Array.isArray(cfg.models) && cfg.models.length
    ? cfg.models
    : [{ model: cfg.provider && cfg.provider.model, enabled: true }];
  const normalized = list
    .filter((m) => m && typeof m.model === "string" && m.model.trim())
    .map((m) => ({
      id: (typeof m.id === "string" && m.id.trim()) || m.model.trim(),
      model: m.model.trim(),
      baseUrl: typeof m.baseUrl === "string" && m.baseUrl.trim() ? m.baseUrl.trim() : null,
      apiKey: typeof m.apiKey === "string" && m.apiKey.trim() ? m.apiKey.trim() : null,
      enabled: m.enabled !== false,
    }));
  // id 去重：保证内存中的身份唯一，且不与任何原始 id 冲突
  const allIds = new Set(normalized.map((m) => m.id));
  const seen = new Set();
  return normalized.map((m) => {
    let id = m.id;
    if (seen.has(id)) {
      let n = 2;
      while (allIds.has(`${m.id}-${n}`) || seen.has(`${m.id}-${n}`)) n++;
      id = `${m.id}-${n}`;
    }
    seen.add(id);
    return { ...m, id };
  });
}

// 请求一轮：启用的问题 × 启用的模型
async function runChecks(cfg) {
  const provider = cfg.provider || {};
  const results = [];
  const models = modelsOf(cfg).filter((m) => m.enabled);
  if (!models.length) {
    console.warn("runChecks: 没有可用的检测模型（models 配置为空或全部无效）");
    return results;
  }
  const questions = (Array.isArray(cfg.questions) ? cfg.questions : []).filter((q) => q && q.enabled !== false);
  const providerBase = typeof provider.baseUrl === "string" ? provider.baseUrl : "";
  for (const m of models) {
    const base = (m.baseUrl || providerBase || "").replace(/\/$/, "");
    const apiKey = m.apiKey || provider.apiKey;
    for (const q of questions) {
      const keywords = Array.isArray(q.answerKeywords) ? q.answerKeywords.filter((k) => typeof k === "string" && k) : [];
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
        rec.requestId = res.headers.get("x-request-id");
        const body = await res.json().catch(() => null);
        rec.latencyMs = Date.now() - started;
        if (!res.ok) {
          // 只取 body 里的 message 字段，避免整段 JSON 灌进日志
          const msg = body?.error?.message || body?.message || "";
          rec.error = `HTTP ${res.status}${msg ? ": " + String(msg).slice(0, 80) : ""}`;
        } else if (!body) {
          // 200 但响应体不是 JSON，或读体阶段被超时打断
          rec.error = ctrl.signal.aborted ? "请求超时" : "响应不是有效 JSON";
        } else if (body.error) {
          const msg = body.error.message || body.error;
          rec.error = `接口返回错误: ${String(msg).slice(0, 80)}`;
        } else if (!Array.isArray(body.choices) || body.choices.length === 0) {
          rec.error = "响应格式异常（缺少 choices）";
        } else {
          const content = body.choices[0]?.message?.content;
          rec.answer = typeof content === "string" ? content : "";
          rec.hit = keywords.some((k) => rec.answer.includes(k));
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
