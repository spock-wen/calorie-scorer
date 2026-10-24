/* ===========================================================
   几分？· 热量打分器  —— 交互逻辑
   视图：打分首页 / 结果页 / 今日总览
   数据：本地 localStorage（无账号、无后端数据库）
   =========================================================== */

/* ---------------- 常量与配置 ---------------- */

// 等级：分数 -> 名称 / 表情 / 卡片配色
const LEVELS = [
  { min: 85, name: "快乐星球", emoji: "🌞", bg: "linear-gradient(135deg,#FFD400 0%,#FF8A00 55%,#FF3D7F 100%)" },
  { min: 70, name: "还不错", emoji: "😋", bg: "linear-gradient(135deg,#00E0A4 0%,#0FF0FC 100%)" },
  { min: 50, name: "中规中矩", emoji: "😐", bg: "linear-gradient(135deg,#0FF0FC 0%,#7C5CFF 100%)" },
  { min: 0,  name: "罪恶深重", emoji: "😈", bg: "linear-gradient(135deg,#7C5CFF 0%,#FF3D7F 100%)" },
];

// 打分权重（集中一处，便于调整）
const WEIGHTS = { calorie: 0.4, nutrition: 0.35, fun: 0.25 };

// 热量舒适区（kcal）：启发式规则，非医学建议
const COMFORT_ZONE = {
  single: [200, 600],
  meal: [500, 1000],
};

const STORE_KEY = "calorie-scorer:meals";
const GOAL_KEY = "calorie-scorer:goal";
const DEFAULT_GOAL = 1800;

/* ---------------- 演示数据（仅「看看示例结果」使用） ---------------- */
/* 说明：真实识别走 /api/analyze，失败不会回退到这里 */
const DEMO = {
  single: {
    mode: "single",
    items: [
      { name: "红烧肉", grams: 150, kcal: 480, protein: 12, fat: 40, carb: 8, veg: 0, confidence: 0.82 },
    ],
    fun: { downRice: 92, guilt: 78, light: 18 },
  },
  meal: {
    mode: "meal",
    items: [
      { name: "清炒时蔬", grams: 180, kcal: 90, protein: 3, fat: 5, carb: 8, veg: 180, confidence: 0.76 },
      { name: "番茄炒蛋", grams: 200, kcal: 210, protein: 12, fat: 14, carb: 8, veg: 60, confidence: 0.71 },
      { name: "白米饭", grams: 200, kcal: 232, protein: 5, fat: 1, carb: 52, veg: 0, confidence: 0.9 },
      { name: "红烧肉", grams: 120, kcal: 384, protein: 10, fat: 32, carb: 6, veg: 0, confidence: 0.8 },
    ],
    fun: { downRice: 88, guilt: 62, light: 42 },
  },
};

/* ---------------- DOM 助手 ---------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ---------------- 全局状态 ---------------- */
const state = {
  mode: "single",     // single | meal
  current: null,      // 当前识别结果 { items, scores, ... }
  thumb: null,        // 当前菜品缩略图 dataURL
  isDemo: true,       // 是否演示数据
  scored: false,      // 本轮是否已记录到今日
  recordId: null,     // 本轮在今日记录中的 id，用于修正后同步
};

/* ===========================================================
   视图切换
   =========================================================== */
function switchView(name) {
  $$(".view").forEach((v) => v.classList.toggle("is-active", v.id === `view-${name}`));
  $$(".tab").forEach((t) => t.classList.toggle("is-active", t.dataset.view === name));
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (name === "today") renderToday();
}

/* ===========================================================
   打分模型
   =========================================================== */
function clamp(v, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, v));
}

// 热量分：落在舒适区得满分，偏离按比例扣分
function scoreCalorie(kcal, mode) {
  const [low, high] = COMFORT_ZONE[mode] || COMFORT_ZONE.single;
  if (kcal <= 0) return 40;
  if (kcal >= low && kcal <= high) return 100;
  const penalty = kcal < low ? ((low - kcal) / low) * 80 : ((kcal - high) / high) * 80;
  return clamp(Math.round(100 - penalty));
}

// 营养分：三大营养素均衡度 + 蔬菜占比
function scoreNutrition(items) {
  const totalKcal = items.reduce((s, it) => s + it.kcal, 0);
  const totalGram = items.reduce((s, it) => s + it.grams, 0);
  if (totalKcal <= 0 || totalGram <= 0) return 50;

  const p = items.reduce((s, it) => s + it.protein * 4, 0) / totalKcal; // 蛋白供能比
  const f = items.reduce((s, it) => s + it.fat * 9, 0) / totalKcal;     // 脂肪供能比
  const c = items.reduce((s, it) => s + it.carb * 4, 0) / totalKcal;    // 碳水供能比
  const vegRatio = items.reduce((s, it) => s + (it.veg || 0), 0) / totalGram;

  // 目标供能比：蛋白 20% / 脂肪 28% / 碳水 52%
  const dev = Math.abs(p - 0.2) + Math.abs(f - 0.28) + Math.abs(c - 0.52);
  const balance = clamp(100 - dev * 150);
  const veg = clamp((vegRatio / 0.3) * 100);
  return Math.round(balance * 0.6 + veg * 0.4);
}

// 趣味分：下饭指数与罪恶感的娱乐性综合
function scoreFun(fun) {
  if (!fun) return 60;
  return clamp(Math.round(fun.downRice * 0.5 + fun.guilt * 0.3 + fun.light * 0.2));
}

// 汇总打分
function computeScores(items, fun, mode) {
  const totalKcal = items.reduce((s, it) => s + it.kcal, 0);
  const calorie = scoreCalorie(totalKcal, mode);
  const nutrition = scoreNutrition(items);
  const funScore = scoreFun(fun);
  const total = Math.round(
    calorie * WEIGHTS.calorie + nutrition * WEIGHTS.nutrition + funScore * WEIGHTS.fun
  );
  return { calorie, nutrition, fun: funScore, total, totalKcal };
}

function levelOf(score) {
  return LEVELS.find((l) => score >= l.min) || LEVELS[LEVELS.length - 1];
}

/* ===========================================================
   识别（接口切换点）
   =========================================================== */
async function analyze(imageBase64, mode) {
  let res;
  try {
    res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64, mode }),
    });
  } catch {
    // 网络断 / 服务没起：明确报错，交给页面提示可重试
    throw new Error("连不上识别服务，检查网络后再试一次");
  }

  // 非 2xx：先尝试取服务端 error 文案，取不到就用通用提示
  if (!res.ok) {
    const errData = await res.json().catch(() => null);
    throw new Error((errData && errData.error) || "识别失败，请重试");
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error("识别结果看不懂（返回不是合法 JSON），请重试");
  }
  if (!Array.isArray(data.items) || data.items.length === 0) {
    throw new Error("AI 没认出菜来，换个角度再拍一张试试");
  }

  return { ...data, isDemo: false };
}

/* ===========================================================
   图片处理
   =========================================================== */
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// 压缩图片到指定最长边，返回 dataURL（控制体积）
function compressImage(dataURL, maxSize = 1024) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/jpeg", 0.82));
    };
    img.onerror = () => resolve(dataURL);
    img.src = dataURL;
  });
}

/* ===========================================================
   上传与识别流程
   =========================================================== */
async function handleFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    toast("请选择图片文件");
    return;
  }
  showOverlay("AI 正在尝味道…");
  try {
    const raw = await readFileAsDataURL(file);
    const big = await compressImage(raw, 1024);   // 送模型用
    const small = await compressImage(raw, 240);  // 列表缩略图用
    const result = await analyze(big, state.mode);
    state.thumb = small;
    state.isDemo = !!result.isDemo;
    state.scored = false;
    renderResult(result);
    switchView("result");
  } catch (err) {
    toast(err.message || "识别失败，请重试");
  } finally {
    hideOverlay();
  }
}

function runSample() {
  showOverlay("AI 正在尝味道…");
  const result = structuredClone(DEMO[state.mode]);
  state.thumb = null;
  state.isDemo = true;
  state.scored = false;
  setTimeout(() => {
    renderResult(result);
    hideOverlay();
    switchView("result");
  }, 700);
}

/* ===========================================================
   渲染结果页
   =========================================================== */
function renderResult(result) {
  // 计算分数
  const scores = computeScores(result.items, result.fun, result.mode || state.mode);
  state.current = { ...result, scores };

  const level = levelOf(scores.total);

  // 演示数据徽章
  $("#demoChip").hidden = !state.isDemo;

  // 分数卡
  const card = $("#scoreCard");
  card.style.background = level.bg;

  const thumb = $("#scThumb");
  if (state.thumb) {
    thumb.style.backgroundImage = `url(${state.thumb})`;
    thumb.textContent = "";
  } else {
    thumb.style.backgroundImage = "none";
    thumb.textContent = level.emoji;
  }

  countUp($("#scTotal"), scores.total);
  $("#scLevel").textContent = `${level.emoji} ${level.name}`;
  $("#scMeta").textContent = `${scores.totalKcal} kcal · ${
    state.current.mode === "meal" ? "整餐" : "单菜"
  }`;

  // 三维分
  $("#valCalorie").textContent = scores.calorie;
  $("#valNutrition").textContent = scores.nutrition;
  $("#valFun").textContent = scores.fun;
  requestAnimationFrame(() => {
    setBar("calorie", scores.calorie);
    setBar("nutrition", scores.nutrition);
    setBar("fun", scores.fun);
  });

  renderFunTags(result.fun);
  renderItems();
  saveMeal();
}

function setBar(dim, value) {
  const bar = $(`.bar[data-dim="${dim}"] .bar-fill`);
  if (bar) bar.style.width = `${clamp(value)}%`;
}

function renderFunTags(fun) {
  const box = $("#funTags");
  box.innerHTML = "";
  if (!fun) return;
  const tags = [
    { label: `下饭指数 ${fun.downRice}`, cls: fun.downRice >= 80 ? "t-hot" : fun.downRice >= 60 ? "t-warn" : "" },
    { label: `罪恶感 ${fun.guilt}`, cls: fun.guilt >= 70 ? "t-hot" : fun.guilt >= 45 ? "t-warn" : "t-good" },
    { label: `减脂友好 ${fun.light}`, cls: fun.light >= 60 ? "t-good" : fun.light >= 35 ? "t-warn" : "t-hot" },
  ];
  tags.forEach((t) => {
    const el = document.createElement("span");
    el.className = `tag ${t.cls}`.trim();
    el.textContent = t.label;
    box.appendChild(el);
  });
}

// 修改克数后按比例重算
function rescaleItem(item, newGrams) {
  const ratio = newGrams / (item.grams || 1);
  item.kcal = Math.round(item.kcal * ratio);
  item.protein = +(item.protein * ratio).toFixed(1);
  item.fat = +(item.fat * ratio).toFixed(1);
  item.carb = +(item.carb * ratio).toFixed(1);
  item.veg = Math.round((item.veg || 0) * ratio);
  item.grams = newGrams;
}

function renderItems() {
  const list = $("#items");
  list.innerHTML = "";
  const items = state.current.items;

  items.forEach((item, idx) => {
    const li = document.createElement("li");
    li.className = "item";
    li.innerHTML = `
      <span class="item-name">${escapeHTML(item.name)}</span>
      <span class="item-grams"><input type="number" min="1" value="${item.grams}" />g</span>
      <span class="item-kcal">${item.kcal}<small>kcal</small></span>
      <button class="item-del" title="删除">×</button>
    `;
    // 改克数
    $("input", li).addEventListener("change", (e) => {
      const g = Math.max(1, Number(e.target.value) || 1);
      const ratio = g / item.grams;
      rescaleItem(item, g);
      // 缩放后名称行只更新克数与热量
      $(".item-kcal", li).innerHTML = `${item.kcal}<small>kcal</small>`;
      $("input", li).value = g;
      refreshScores();
    });
    // 删除
    $(".item-del", li).addEventListener("click", () => {
      if (items.length <= 1) {
        toast("至少保留一道菜");
        return;
      }
      items.splice(idx, 1);
      renderItems();
      refreshScores();
    });
    list.appendChild(li);
  });
}

// 明细变动后刷新分数（不重播入场动画）
function refreshScores() {
  const s = computeScores(state.current.items, state.current.fun, state.current.mode || state.mode);
  state.current.scores = s;
  const level = levelOf(s.total);
  $("#scoreCard").style.background = level.bg;
  $("#scTotal").textContent = s.total;
  $("#scLevel").textContent = `${level.emoji} ${level.name}`;
  $("#valCalorie").textContent = s.calorie;
  $("#valNutrition").textContent = s.nutrition;
  $("#valFun").textContent = s.fun;
  setBar("calorie", s.calorie);
  setBar("nutrition", s.nutrition);
  setBar("fun", s.fun);
  $("#scMeta").textContent = `${s.totalKcal} kcal · ${
    state.current.mode === "meal" ? "整餐" : "单菜"
  }`;
  renderFunTags(state.current.fun);
  updateSavedMeal();
}

function addItem() {
  openModal({
    title: "加一道菜",
    text: "先填个菜名，克数与热量按默认估值，可在列表里改。",
    input: true,
    onOk: (name) => {
      if (!name) {
        toast("请输入菜名");
        return false;
      }
      state.current.items.push({
        name, grams: 100, kcal: 150, protein: 6, fat: 8, carb: 12, veg: 0, confidence: 1,
      });
      renderItems();
      refreshScores();
      toast("已添加，可修改克数");
      return true;
    },
  });
}

/* ===========================================================
   数字滚动动画
   =========================================================== */
function countUp(el, target, duration = 900) {
  const start = performance.now();
  const from = 0;
  function tick(now) {
    const p = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(from + (target - from) * eased);
    if (p < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

/* ===========================================================
   分享分数卡
   =========================================================== */
async function shareCard() {
  if (typeof html2canvas === "undefined") {
    toast("分享组件未加载，请检查网络");
    return;
  }
  try {
    const canvas = await html2canvas($("#scoreCard"), { backgroundColor: null, scale: 2 });
    const link = document.createElement("a");
    link.download = `几分-${Date.now()}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
    toast("分数卡已保存");
  } catch (e) {
    toast("导出失败，请重试");
  }
}

/* ===========================================================
   本地存储
   =========================================================== */
function getMeals() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || [];
  } catch {
    return [];
  }
}
function setMeals(list) {
  localStorage.setItem(STORE_KEY, JSON.stringify(list));
}
function saveMeal() {
  if (state.scored || !state.current) return;
  const list = getMeals();
  const id = Date.now();
  list.unshift({
    id,
    timestamp: id,
    mode: state.current.mode || state.mode,
    thumb: state.thumb,
    items: structuredClone(state.current.items),
    scores: { ...state.current.scores },
    totalKcal: state.current.scores.totalKcal,
    isDemo: state.isDemo,
  });
  // 缩略图占 localStorage，只保留最近 60 条
  setMeals(list.slice(0, 60));
  state.recordId = id;
  state.scored = true;
}

// 修正克数 / 增删菜品后，把结果写回今日记录
function updateSavedMeal() {
  if (!state.recordId || !state.current) return;
  const list = getMeals();
  const rec = list.find((m) => m.id === state.recordId);
  if (!rec) return;
  rec.mode = state.current.mode || state.mode;
  rec.items = structuredClone(state.current.items);
  rec.scores = { ...state.current.scores };
  rec.totalKcal = state.current.scores.totalKcal;
  setMeals(list);
}

/* ===========================================================
   今日总览
   =========================================================== */
function isToday(ts) {
  const d = new Date(ts);
  const n = new Date();
  return d.toDateString() === n.toDateString();
}

function renderToday() {
  const now = new Date();
  $("#todayDate").textContent = now.toLocaleDateString("zh-CN", {
    year: "numeric", month: "long", day: "numeric", weekday: "long",
  });

  const goal = Number(localStorage.getItem(GOAL_KEY)) || DEFAULT_GOAL;
  const todayMeals = getMeals().filter((m) => isToday(m.timestamp));
  const nowKcal = todayMeals.reduce((s, m) => s + (m.totalKcal || 0), 0);

  $("#goalNow").textContent = nowKcal;
  $("#goalTarget").textContent = goal;
  const pct = clamp((nowKcal / goal) * 100);
  requestAnimationFrame(() => ($("#goalFill").style.width = `${pct}%`));

  $("#goalHint").textContent =
    nowKcal === 0
      ? "还没记录，去拍一张吧"
      : nowKcal > goal
      ? `超出目标 ${nowKcal - goal} kcal，明天清淡点`
      : `还可以再吃 ${goal - nowKcal} kcal`;

  const list = $("#records");
  list.innerHTML = "";
  $("#recordsEmpty").hidden = todayMeals.length > 0;

  todayMeals.forEach((m) => {
    const names = m.items.map((i) => i.name).join("、");
    const li = document.createElement("li");
    li.className = "record";
    li.innerHTML = `
      <div class="record-thumb" ${m.thumb ? `style="background-image:url(${m.thumb})"` : ""}>
        ${m.thumb ? "" : levelOf(m.scores.total).emoji}
      </div>
      <div class="record-info">
        <div class="record-title">${escapeHTML(names)}</div>
        <div class="record-sub">${new Date(m.timestamp).toLocaleTimeString("zh-CN", {
          hour: "2-digit", minute: "2-digit",
        })} · ${m.mode === "meal" ? "整餐" : "单菜"} · ${m.scores.total} 分</div>
      </div>
      <div class="record-kcal">${m.totalKcal}<small>kcal</small></div>
    `;
    list.appendChild(li);
  });
}

function setGoal() {
  const cur = Number(localStorage.getItem(GOAL_KEY)) || DEFAULT_GOAL;
  openModal({
    title: "设置每日热量目标",
    text: "建议 500 - 6000 kcal。",
    input: true,
    type: "number",
    value: cur,
    onOk: (v) => {
      const n = Number(v);
      if (!n || n < 500 || n > 6000) {
        toast("请输入 500 - 6000 之间的数字");
        return false;
      }
      localStorage.setItem(GOAL_KEY, String(Math.round(n)));
      renderToday();
      toast("目标已更新");
      return true;
    },
  });
}

function clearRecords() {
  openModal({
    title: "清空全部记录？",
    text: "包含历史日期的记录，清空后不可恢复。",
    okText: "确认清空",
    onOk: () => {
      localStorage.removeItem(STORE_KEY);
      state.recordId = null;
      renderToday();
      toast("已清空");
      return true;
    },
  });
}

/* ===========================================================
   通用 UI
   =========================================================== */
let toastTimer = null;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2200);
}
function showOverlay(text) {
  $("#overlayText").textContent = text;
  $("#overlay").hidden = false;
}
function hideOverlay() {
  $("#overlay").hidden = true;
}
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* ---------------- 通用弹层 ---------------- */
let modalSubmit = null;
let modalReturnFocus = null;

// input=false 时为确认框；onOk 返回 false 可阻止关闭（校验失败）
function openModal({ title, text = "", input = false, type = "text", value = "", okText = "确定", onOk }) {
  const modal = $("#modal");
  const textEl = $("#modalText");
  const inputEl = $("#modalInput");

  modalReturnFocus = document.activeElement;
  $("#modalTitle").textContent = title;
  textEl.textContent = text;
  textEl.hidden = !text;
  inputEl.hidden = !input;
  inputEl.type = type;
  inputEl.value = value;
  $("#modalOk").textContent = okText;

  modalSubmit = () => {
    if (onOk(input ? inputEl.value.trim() : undefined) === false) return;
    closeModal();
  };

  modal.hidden = false;
  if (input) {
    inputEl.focus();
    inputEl.select();
  } else {
    $("#modalOk").focus();
  }
}

function closeModal() {
  $("#modal").hidden = true;
  modalSubmit = null;
  if (modalReturnFocus && modalReturnFocus.focus) modalReturnFocus.focus();
  modalReturnFocus = null;
}

function submitModal() {
  if (modalSubmit) modalSubmit();
}

/* ===========================================================
   初始化与事件绑定
   =========================================================== */
function init() {
  // 顶部导航
  $("#tabs").addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (tab) switchView(tab.dataset.view);
  });

  // 模式切换
  const modeSwitch = $("#modeSwitch");
  modeSwitch.addEventListener("click", (e) => {
    const btn = e.target.closest(".mode");
    if (!btn) return;
    state.mode = btn.dataset.mode;
    modeSwitch.dataset.mode = state.mode;
    $$(".mode", modeSwitch).forEach((m) => m.classList.toggle("is-active", m === btn));
    $("#dzHint").textContent = state.mode === "meal" ? "一张图 = 一整餐" : "一张图 = 一道菜";
    syncModeAria();
  });
  syncModeAria();

  // 文件选择
  $("#fileInput").addEventListener("change", (e) => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
    e.target.value = "";
  });

  // 拖拽上传
  const dz = $("#dropzone");
  ["dragenter", "dragover"].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add("is-drag");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.remove("is-drag");
    })
  );
  dz.addEventListener("drop", (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });
  // label 默认不能被键盘激活，补上 Enter / 空格
  dz.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      $("#fileInput").click();
    }
  });

  // 模式按钮补 aria-selected，键盘 Tab 时状态可读
  function syncModeAria() {
    $$(".mode", modeSwitch).forEach((m) =>
      m.setAttribute("aria-selected", String(m.dataset.mode === state.mode))
    );
  }

  // 示例
  $("#btnSample").addEventListener("click", runSample);

  // 结果页
  $("#btnBack").addEventListener("click", () => switchView("home"));
  $("#btnAgain").addEventListener("click", () => switchView("home"));
  $("#btnAddItem").addEventListener("click", addItem);
  $("#btnShare").addEventListener("click", shareCard);

  // 今日
  $("#btnSetGoal").addEventListener("click", setGoal);
  $("#btnClear").addEventListener("click", clearRecords);

  // 弹层
  $("#modalCancel").addEventListener("click", closeModal);
  $("#modalOk").addEventListener("click", submitModal);
  $("#modal").addEventListener("click", (e) => {
    if (e.target.id === "modal") closeModal();
  });
  $("#modal").addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
    // 焦点在按钮上时交给按钮自己的 click，避免「回车=确定」误触发
    if (e.key === "Enter" && e.target.tagName !== "BUTTON") {
      e.preventDefault();
      submitModal();
    }
  });
}

document.addEventListener("DOMContentLoaded", init);
