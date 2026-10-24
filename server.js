/* ===========================================================
   几分？· 热量打分器 —— Node 代理
   浏览器 -> POST /api/analyze -> DeepSeek OpenAI 兼容接口
   Key 只存在服务端环境变量，前端永远不接触。
   =========================================================== */

import express from "express";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.DEEPSEEK_API_KEY || "";
const BASE_URL = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "");
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-flash";

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_IMAGE_CHARS = 10 * 1024 * 1024;
const MAX_ITEMS = 20;

/* ---------------- 提示词 ---------------- */

const SYSTEM_PROMPT = `你是「几分？·热量打分器」的图像营养估算助手。根据用户上传的菜品照片识别菜品，估算份量、热量与三大营养素，并给出趣味维度评分。只输出 json，不要输出解释、Markdown 或任何多余文字。

输出必须是如下结构的 json：
{
  "items": [
    { "name": "红烧肉", "grams": 150, "kcal": 480, "protein": 12, "fat": 40, "carb": 8, "veg": 0, "confidence": 0.82 }
  ],
  "fun": { "downRice": 92, "guilt": 78, "light": 18 }
}

字段与数值范围：
- items：1-20 个菜品对象；整餐时逐道列出画面中可辨认的菜。
- name：中文菜名，简短（不超过 12 个字）。
- grams：估算可食用份量，整数，0-2000 克。
- kcal：该份量的总热量，整数，0-5000 千卡。
- protein / fat / carb：该份量的蛋白质 / 脂肪 / 碳水化合物克数，整数，0-500 克。
- veg：该份量中蔬菜类食材的克数，整数，0-2000 克。
- confidence：0-1 的小数，表示识别与估算的可信度；画面模糊、被遮挡、份量难判断时请明显降低（例如 0.3-0.5）。
- fun.downRice：0-100，下饭指数，越下饭越高。
- fun.guilt：0-100，罪恶感，越油腻、热量越高越高。
- fun.light：0-100，减脂友好度，越清淡、热量越低越高。

数字一律用数字类型，不要带单位或百分号。`;

const USER_TEXT = {
  single: "只识别画面里的主要菜品：识别这道菜，估算份量与营养，按要求输出 json。",
  meal: "识别这一餐里的所有菜，逐道列出，分别估算份量、热量与营养，按要求输出 json。",
};

/* ---------------- 错误类型 ---------------- */

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// 上游 content 为空或不是合法 json 时抛出，可重试
class RetryableError extends Error {}

/* ---------------- 限流：每 IP 每分钟 10 次 ---------------- */

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10;
const rateBuckets = new Map();
let lastRateSweep = 0;

function rateLimit(req, res, next) {
  const now = Date.now();
  const ip = req.ip || req.socket?.remoteAddress || "unknown";

  let bucket = rateBuckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;

  // 惰性清理过期桶，防止 Map 无限增长
  if (now - lastRateSweep > RATE_WINDOW_MS || rateBuckets.size > 2000) {
    for (const [key, value] of rateBuckets) {
      if (value.resetAt <= now) rateBuckets.delete(key);
    }
    lastRateSweep = now;
  }

  if (bucket.count > RATE_MAX) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.set("Retry-After", String(retryAfter));
    return res.status(429).json({ error: "请求太频繁，请稍后再试" });
  }

  return next();
}

/* ---------------- 调用模型 ---------------- */

async function requestModel(mode, imageBase64) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    let response;
    try {
      response = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: [
                { type: "text", text: USER_TEXT[mode] },
                { type: "image_url", image_url: { url: imageBase64, detail: "high" } },
              ],
            },
          ],
          temperature: 0.2,
          max_tokens: 1500,
          response_format: { type: "json_object" },
          stream: false,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (timedOut || err?.name === "AbortError") {
        throw new ApiError(504, "AI 响应超时，请重试");
      }
      throw new ApiError(502, "无法连接模型服务，请检查网络或服务配置");
    }

    if (!response.ok) {
      // 只记录状态码，不记录上游返回体
      console.warn(`upstream status=${response.status}`);
      if (response.status === 401 || response.status === 403) {
        throw new ApiError(502, "模型鉴权失败，请检查服务端 Key");
      }
      if (response.status === 429) {
        throw new ApiError(429, "模型限流，请稍后再试");
      }
      if (response.status === 400) {
        throw new ApiError(502, "模型拒绝了请求，当前模型可能不支持图片识别");
      }
      throw new ApiError(502, "模型服务暂时不可用，请稍后再试");
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      if (timedOut) throw new ApiError(504, "AI 响应超时，请重试");
      throw new RetryableError("upstream body is not json");
    }

    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new RetryableError("empty content");
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 解析与归一化 ---------------- */

function parseModelJson(content) {
  const text = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(text);
  } catch {
    // 容错：抽取第一个 { 到最后一个 } 之间的内容
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        /* fallthrough */
      }
    }
  }
  throw new RetryableError("invalid json");
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function toInt(value, fallback, low, high) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = typeof value === "string" ? Number(value) : value;
  const num = Number.isFinite(n) ? n : fallback;
  return Math.round(clamp(num, low, high));
}

function toScore(value) {
  if (value === null || value === undefined || value === "") return 60;
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return 60;
  return Math.round(clamp(n, 0, 100));
}

function toConfidence(value) {
  if (value === null || value === undefined || value === "") return 0.5;
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return 0.5;
  return Math.round(clamp(n, 0, 1) * 100) / 100;
}

function normalizeItem(raw) {
  return {
    name: String(raw?.name ?? "").trim().slice(0, 40) || "未识别菜品",
    grams: toInt(raw?.grams, 0, 0, 2000),
    kcal: toInt(raw?.kcal, 0, 0, 5000),
    protein: toInt(raw?.protein, 0, 0, 500),
    fat: toInt(raw?.fat, 0, 0, 500),
    carb: toInt(raw?.carb, 0, 0, 500),
    veg: toInt(raw?.veg, 0, 0, 2000),
    confidence: toConfidence(raw?.confidence),
  };
}

function normalizeResult(raw, mode) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RetryableError("result is not an object");
  }
  if (!Array.isArray(raw.items) || raw.items.length === 0) {
    throw new RetryableError("items missing");
  }

  const items = raw.items
    .slice(0, MAX_ITEMS)
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map(normalizeItem);

  if (items.length === 0) {
    throw new RetryableError("items empty");
  }

  const fun = raw.fun && typeof raw.fun === "object" ? raw.fun : {};
  return {
    mode,
    items,
    fun: {
      downRice: toScore(fun.downRice),
      guilt: toScore(fun.guilt),
      light: toScore(fun.light),
    },
  };
}

async function analyzeImage(mode, imageBase64) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const content = await requestModel(mode, imageBase64);
      return normalizeResult(parseModelJson(content), mode);
    } catch (err) {
      if (!(err instanceof RetryableError) || attempt === 1) throw err;
      // 空 content / 非法 JSON：重试一次
    }
  }
  throw new ApiError(502, "AI 返回结果无法解析，请重试");
}

/* ---------------- 应用 ---------------- */

const app = express();

app.get("/api/health", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    model: MODEL,
    keyConfigured: Boolean(API_KEY),
  });
});

app.post(
  "/api/analyze",
  rateLimit,
  express.json({ limit: "12mb" }),
  async (req, res) => {
    const { imageBase64, mode } = req.body || {};

    if (mode !== "single" && mode !== "meal") {
      return res.status(400).json({ error: "mode 必须是 single 或 meal" });
    }
    if (typeof imageBase64 !== "string" || !/^data:image\/[\w.+-]+;base64,/i.test(imageBase64)) {
      return res.status(400).json({ error: "图片格式不正确，需要 data:image/...;base64 的数据" });
    }
    if (imageBase64.length > MAX_IMAGE_CHARS) {
      return res.status(400).json({ error: "图片太大，请压缩后再上传" });
    }
    if (!API_KEY) {
      return res.status(503).json({ error: "服务端未配置 DEEPSEEK_API_KEY" });
    }

    try {
      const result = await analyzeImage(mode, imageBase64);
      return res.json(result);
    } catch (err) {
      if (err instanceof ApiError) {
        return res.status(err.status).json({ error: err.message });
      }
      if (err instanceof RetryableError) {
        return res.status(502).json({ error: "AI 返回结果无法解析，请重试" });
      }
      return res.status(500).json({ error: "服务端内部错误，请稍后再试" });
    }
  }
);

app.use(express.static(path.join(__dirname, "public")));

app.use("/api", (req, res) => {
  res.status(404).json({ error: "接口不存在" });
});

// 请求体过大 / JSON 语法错误统一返回 JSON，方便前端展示
app.use((err, req, res, next) => {
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: "图片太大，请压缩后再上传" });
  }
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ error: "请求体不是合法 JSON" });
  }
  console.warn(`request error: ${err?.name || "Error"}`);
  return res.status(500).json({ error: "服务端内部错误，请稍后再试" });
});

app.listen(PORT, () => {
  console.log(`listening on http://localhost:${PORT}`);
  console.log(`model=${MODEL}, key=${API_KEY ? "已配置" : "未配置"}`);
});
