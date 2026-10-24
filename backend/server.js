/**
 * 热量打分器 — 后端代理
 * 转发前端请求到 DeepSeek 视觉模型
 *
 * 用法：
 *   node server.js          # 开发模式
 *   pm2 start server.js     # 生产模式
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");

const app = express();
const PORT = process.env.PORT || 3000;

// ====== 中间件 ======
app.use(
  cors({
    origin: [
      "https://calorie-scorer.pages.dev",
      "https://trae-agent-fsyovw.calorie-scorer.pages.dev",
      // 本地开发用
      "http://localhost:8000",
      "http://127.0.0.1:8000",
    ],
    credentials: true,
  })
);
app.use(bodyParser.json({ limit: "10mb" })); // base64 图片大
app.use(bodyParser.urlencoded({ extended: true, limit: "10mb" }));

// ====== 配置 ======
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-flash";

// ====== 健康检查 ======
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "calorie-scorer-api",
    model: DEEPSEEK_MODEL,
    keyConfigured: !!DEEPSEEK_API_KEY,
  });
});

// ====== 核心接口：识别菜品 ======
app.post("/api/analyze", async (req, res) => {
  try {
    const { imageBase64, mode } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: "缺少 imageBase64" });
    }
    if (!DEEPSEEK_API_KEY) {
      return res.status(500).json({ error: "服务器未配置 DEEPSEEK_API_KEY" });
    }

    // 构造 prompt
    const systemPrompt = `你是一个资深营养师和美食评论员。用户会上传一张菜品照片，请你：

1. 识别照片中所有的菜品，每道菜给出：菜名、估计克数、热量(kcal)、蛋白质(g)、脂肪(g)、碳水(g)、蔬菜占比(g)、置信度(0~1)
2. 给出三个趣味评分：
   - downRice (下饭指数 0~100)
   - guilt (罪恶感 0~100)
   - light (减脂友好度 0~100)

mode 为 "single" 时是单菜模式，只会有一道菜。
mode 为 "meal" 时是整餐模式，会有多道菜。

严格返回以下 JSON 格式，不要加任何额外文字：
{
  "mode": "single" 或 "meal",
  "items": [
    { "name": "", "grams": 0, "kcal": 0, "protein": 0, "fat": 0, "carb": 0, "veg": 0, "confidence": 0.0 }
  ],
  "fun": { "downRice": 0, "guilt": 0, "light": 0 }
}`;

    const userPrompt = `请识别这张${mode === "meal" ? "整餐" : "单菜"}照片：`;

    // DeepSeek 兼容 OpenAI 格式
    // 把 base64 拼成 data URI（如果前端没拼的话）
    const dataUrl = imageBase64.startsWith("data:")
      ? imageBase64
      : `data:image/jpeg;base64,${imageBase64}`;

    const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              { type: "text", text: userPrompt },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        temperature: 0.4,
        max_tokens: 1024,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("DeepSeek 错误:", response.status, errText);
      return res.status(502).json({ error: `DeepSeek API 错误: ${response.status}` });
    }

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) {
      return res.status(502).json({ error: "DeepSeek 返回为空" });
    }

    // 解析 JSON（模型偶尔会用 ```json 包裹）
    let parsed;
    try {
      const cleaned = raw.replace(/```(?:json)?\n?/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error("JSON 解析失败:", raw);
      return res.status(502).json({ error: "AI 返回格式异常，请重试" });
    }

    // 校验字段完整性，缺失的补默认值
    if (!parsed.items || !Array.isArray(parsed.items)) {
      return res.status(502).json({ error: "AI 未识别出菜品" });
    }

    // 数值字段兜底
    parsed.items = parsed.items.map((it) => ({
      name: String(it.name || "未知菜品"),
      grams: Number(it.grams) || 100,
      kcal: Number(it.kcal) || 150,
      protein: Number(it.protein) || 5,
      fat: Number(it.fat) || 8,
      carb: Number(it.carb) || 12,
      veg: Number(it.veg) || 0,
      confidence: Number(it.confidence) || 0.5,
    }));

    parsed.fun = {
      downRice: Number(parsed.fun?.downRice) || 50,
      guilt: Number(parsed.fun?.guilt) || 50,
      light: Number(parsed.fun?.light) || 50,
    };

    parsed.mode = parsed.mode || mode || "single";

    res.json(parsed);
  } catch (err) {
    console.error("服务器内部错误:", err);
    res.status(500).json({ error: "服务器内部错误" });
  }
});

// ====== 启动 ======
app.listen(PORT, () => {
  console.log(`🍜 Calorie Scorer API 运行中: http://localhost:${PORT}`);
  console.log(`   模型: ${DEEPSEEK_MODEL}`);
  console.log(`   Key 状态: ${DEEPSEEK_API_KEY ? "✅ 已配置" : "⚠️  未配置，请求会报错"}`);
});
