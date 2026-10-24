# AGENTS.md

面向在本仓库中工作的 AI 代理（及其他贡献者）的上下文说明。修改前请先读本文件与设计稿。

## 项目是什么

「几分？· 热量打分器」（calorie-scorer）：上传一张菜品照片，AI 识别菜品并估算热量与营养，用多巴胺配色给出「热量 / 营养 / 趣味」三维评分，可手动修正、可分享，并计入每日热量总览。

一句话定位：**拍一张菜，几分？**

## 当前状态（重要）

- 前端：`public/index.html` + `styles.css` + `app.js`，单页三视图、移动/平板/桌面响应式（≥1024px 双栏工作台），交互完整。
- 后端：`server.js`（Express，静态托管 + `/api/analyze` 代理 + `/api/health` + 每 IP 10 次/分限流），依赖见 `package.json`。
- 已按 DeepSeek `deepseek-flash` 图像理解接口实现；Key 仅由 `.env` 提供，**未配置时 `/api/analyze` 返回 503**，前端会明确提示。
- 尚未完成：真实 Key 端到端验证、部署（Cloudflare 形态待定）。

## 目录结构

```
public/index.html   单页三视图结构，所有交互元素都有 id
public/styles.css   全部样式与设计 token（CSS 变量）
public/app.js       交互逻辑、打分模型、localStorage、分享
server.js           静态托管 + 模型代理 + 健康检查 + 限流
package.json        依赖与启动脚本（express / dotenv）
.env.example        环境变量模板，复制为 .env 后填 Key
docs/superpowers/specs/   需求与设计稿（唯一权威需求来源）
```

## 目标架构（来自设计稿 §3）

```
浏览器 (public/) --POST /api/analyze {imageBase64, mode}--> Node 代理 (server.js, Express)
  --> DeepSeek OpenAI 兼容 /chat/completions（图片走 image_url + base64）--> 页面解析、打分、渲染
```

约定：
- **API Key 只放服务端 `.env`**，前端代码与请求中不得出现任何 key；代理同时解决 CORS。
- 环境变量：`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`（默认 `https://api.deepseek.com`）、`DEEPSEEK_MODEL`（默认 `deepseek-flash`）、`PORT`（默认 3000）。
- 若模型不支持图片输入，代理返回明确错误，页面提示「当前模型不支持图片识别」；切换视觉模型只改 `.env`。

## 需求要点

- 两种模式：`single`（一图一菜）、`meal`（一图多菜，逐道识别后按热量占比加权汇总）。
- 页面全程显式提示：AI 估算仅供参考、可手动修正。不做账号、云存储、社交、医学建议。
- 打分权重集中在一处可配置：综合分 = 热量 0.40 + 营养 0.35 + 趣味 0.25；等级 85+ / 70–84 / 50–69 / <50。
- 数据存 `localStorage`：`meals[]`（含 items、scores、level、thumbnail）与 `dailyGoal`（默认 1800 kcal）。
- 前端上传前压缩图片到 ≤1024px；AI 返回非法 JSON 要容错，失败须明示可重试。
- 分享卡用 html2canvas 导出 PNG，固定 3:4 画幅（已通过 CDN 引入）。

## 代码约定

- 无构建步骤、无框架：原生 HTML/CSS/JS。除 html2canvas 与 Google Fonts 外不新增第三方依赖；后端只加 Express 与 dotenv。
- JS 用 ES module 或普通 `<script>` 均可，但需与 `index.html` 现有引用方式一致，不要引入打包器。
- 新 DOM 节点沿用现有 `id` 命名风格（`btnXxx` / `view-xxx` / `scXxx`），样式用 `styles.css` 里的类名，不写内联样式。
- 复用已有设计 token，不要硬编码颜色或尺寸：

```css
--pink:#ff3d7f; --orange:#ff8a00; --yellow:#ffd400; --mint:#00e0a4;
--purple:#7c5cff; --cyan:#0ff0fc; --ink:#14110f; --paper:#fff7e6;
--line:3px solid var(--ink); --radius:26px; --shadow:7px 7px 0 var(--ink);
--font-body:"Baloo 2",...; --font-num:"Archivo Black",...
```

- 视觉风格：大圆角色块、粗描边、硬阴影、超大数字 + 表情、撞色进度条。分数越高越暖亮，越低越偏粉紫。
- 文案用中文、口语化短句，语气与现有文案一致（如「AI 正在尝味道…」）。

## 本地运行

```bash
cp .env.example .env        # 填入 DEEPSEEK_API_KEY
npm install && npm start    # http://localhost:3000
curl localhost:3000/api/health   # keyConfigured 应为 true
```

只调样式时可 `cd public && python3 -m http.server 8000`，但此时没有 `/api/analyze`，只有「看看示例结果」可用。

## 不要做的事

- 不要把 `.env`、`node_modules/`、`*.log`、`.uploads/` 提交进仓库（已在 `.gitignore`）。
- 不要在前端硬编码或回显 API Key，不要为此引入任何「前端直连模型」的绕行方案。
- 不要改动 `docs/` 下的设计稿来迁就实现；实现与设计冲突时先与用户确认。
- 不要为了「跑通」而伪造识别结果当作真实输出；示例数据必须显式标注为演示数据（`#demoChip`）。
