// ⚠️ 会直接覆盖 data/checks.jsonl，生产环境请勿运行
// 生成 3 天演示数据，用于本地预览前端效果（跑之前先备份真实数据）
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "data");
const FILE = path.join(DIR, "checks.jsonl");
const now = Date.now();
const lines = [];
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

// 每 10 分钟一条，3 天共 432 条；最近 24 小时也有足够密度
for (let i = 431; i >= 0; i--) {
  const ts = Math.floor((now - i * 10 * 60 * 1000) / 600000) * 600000 + 30000;
  const h = new Date(ts).getHours();
  let hit = true;
  let error = null;

  // 深夜时段偶尔降智（模拟中转站夜间切换）
  if (h >= 2 && h < 5 && rand() < 0.55) hit = false;
  // 零散降智
  if (rand() < 0.07) hit = false;
  // 偶发请求异常
  if (rand() < 0.025) { hit = null; error = "HTTP 429: rate limited"; }
  // 最后一条保证正常，避免首屏显示异常
  if (i === 0) { hit = true; error = null; }

  const answers = ["日本现任首相是高市早苗。", "高市早苗", "日本首相：高市早苗"];
  const wrong = ["日本现任首相是岸田文雄。", "日本现任首相是石破茂。", "抱歉，我无法回答这个问题。"];
  lines.push(JSON.stringify({
    ts,
    questionId: "jp-pm",
    question: "日本现任首相是谁？只回答名字。",
    answer: hit === null ? null : hit ? answers[Math.floor(rand() * answers.length)] : wrong[Math.floor(rand() * wrong.length)],
    hit,
    latencyMs: hit === null ? 60000 : Math.round(700 + rand() * 3200),
    requestId: "req_demo_" + i.toString(16).padStart(8, "0"),
    error,
  }));
}

fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(FILE, lines.join("\n") + "\n");
console.log(`已生成 ${lines.length} 条演示数据 -> ${FILE}`);
