"use strict";
// 服务器监控前端: 轮询后端 + ECharts 6 绘图

// ---------- 单位换算 ----------
function fmtBytes(n) {
  n = Number(n) || 0;
  const u = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(2)) + " " + u[i];
}
// 网速: 主显 MB/s (字节), 小流量降到 KB/s; tooltip 另给 Mbps
// 紧凑字节 (卡片用, 短): 829.0M / 52.1G
function fmtB(n) {
  n = Number(n) || 0;
  const u = ["B", "K", "M", "G", "T", "P"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(1)) + u[i];
}
function fmtRate(bps) {
  bps = Number(bps) || 0;
  if (bps >= 1024 * 1024) return (bps / 1048576).toFixed(2) + " MB/s";
  if (bps >= 1024) return (bps / 1024).toFixed(1) + " KB/s";
  return bps.toFixed(0) + " B/s";
}
function toMbps(bps) { return ((Number(bps) || 0) * 8 / 1e6).toFixed(2) + " Mbps"; }
function fmtUptime(s) {
  s = Number(s) || 0;
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return (d ? d + "天 " : "") + h + "时 " + m + "分";
}
const MB = 1048576;
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// ---------- 主题 ----------
let AXIS, GRID, TIPBG, TIPTEXT, TITLE;
const THEMES = {
  dark:  { axis: "#8a93a6", grid: "#222838", tipBg: "#1b2130", tipText: "#e6e9f0", title: "#cdd3df" },
  light: { axis: "#64707f", grid: "#dde3ec", tipBg: "#ffffff", tipText: "#1f2733", title: "#1f2733" },
};
function applyTheme(t) {
  const c = THEMES[t] || THEMES.dark;
  AXIS = c.axis; GRID = c.grid; TIPBG = c.tipBg; TIPTEXT = c.tipText; TITLE = c.title;
  document.body.classList.toggle("theme-light", t === "light");
  try { localStorage.setItem("sm-theme", t); } catch {}
  const btn = document.getElementById("theme-btn");
  if (btn) btn.textContent = t === "light" ? "深色" : "浅色";
}

// ---------- ECharts 公共 ----------
function baseGrid() { return { left: 50, right: 16, top: 30, bottom: 28 }; }
function timeAxis() {
  return { type: "time", axisLine: { lineStyle: { color: GRID } }, axisLabel: { color: AXIS, fontSize: 11 }, splitLine: { show: false } };
}
function valAxis(formatter) {
  return { type: "value", axisLabel: { color: AXIS, fontSize: 11, formatter }, splitLine: { lineStyle: { color: GRID } }, axisLine: { show: false } };
}
function mkChart(id) {
  const c = echarts.init(document.getElementById(id), null, { renderer: "canvas" });
  window.addEventListener("resize", () => c.resize());
  return c;
}

const charts = {};
function initCharts() {
  charts.cpu = mkChart("chart-cpu");
  charts.mem = mkChart("chart-mem");
  charts.net = mkChart("chart-net");
  charts.diskio = mkChart("chart-diskio");
  charts.traffic = mkChart("chart-traffic");
}

function lineOption(title, series, yFmt, tipFmt, yMax) {
  return {
    backgroundColor: "transparent",
    title: { text: title, left: 8, top: 4, textStyle: { color: TITLE, fontSize: 13, fontWeight: 500 } },
    grid: baseGrid(),
    tooltip: { trigger: "axis", backgroundColor: TIPBG, borderColor: GRID, textStyle: { color: TIPTEXT }, formatter: tipFmt },
    legend: { right: 8, top: 4, textStyle: { color: AXIS }, icon: "roundRect", itemWidth: 12, itemHeight: 8 },
    xAxis: timeAxis(),
    yAxis: { ...valAxis(yFmt), ...(yMax != null ? { min: 0, max: yMax } : {}) },
    series,
  };
}

function areaSeries(name, color, data) {
  return {
    name, type: "line", showSymbol: false, smooth: true, data,
    lineStyle: { width: 1.5, color }, itemStyle: { color },
    areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: color + "55" }, { offset: 1, color: color + "08" }]) },
  };
}

// ---------- 状态 ----------
let sysRange = "live";
let trafficRange = "1d";
let trafficIface = "";
const LIVE_CAP = 180;
const live = { cpu: [], mem: [], netRx: [], netTx: [], dRd: [], dWr: [] };
let tickTimer = null;
function startTick(ms) { if (tickTimer) clearInterval(tickTimer); tickTimer = setInterval(tick, ms); }

// ---------- 概览卡片 ----------
function updateCards(d) {
  document.getElementById("c-cpu").textContent = d.cpu.toFixed(0) + "%";
  document.getElementById("c-cpu-sub").textContent = `load ${d.load.map(x => x.toFixed(2)).join(" ")}`;
  document.getElementById("c-mem").textContent = d.mem.pct.toFixed(0) + "%";
  document.getElementById("c-mem-sub").textContent = `${fmtBytes(d.mem.used)} / ${fmtBytes(d.mem.total)}`;
  document.getElementById("c-disk").textContent = d.disk.pct.toFixed(0) + "%";
  document.getElementById("c-disk-sub").textContent = `${fmtBytes(d.disk.used)} / ${fmtBytes(d.disk.total)}`;
  document.getElementById("c-net").innerHTML =
    `<div class="io-row"><span class="io-k">进</span><span class="io-v">${fmtRate(d.net.rx)}</span></div>` +
    `<div class="io-row"><span class="io-k">出</span><span class="io-v">${fmtRate(d.net.tx)}</span></div>`;
  document.getElementById("c-net-sub").textContent = `进 ${toMbps(d.net.rx)} · 出 ${toMbps(d.net.tx)}`;
  document.getElementById("c-conns").textContent = d.conns;
  if (d.traffic) {
    const t = d.traffic;
    document.getElementById("c-traffic").innerHTML =
      `<div class="io-row tr"><span class="io-k">今日</span><span class="io-tv">进 ${fmtB(t.today.rx)} · 出 ${fmtB(t.today.tx)}</span></div>` +
      `<div class="io-row tr"><span class="io-k">本月</span><span class="io-tv">进 ${fmtB(t.month.rx)} · 出 ${fmtB(t.month.tx)}</span></div>`;
  }
}

// ---------- 实时图渲染 ----------
function renderSys(arr) {
  charts.cpu.setOption(lineOption("CPU 使用率 (%)",
    [areaSeries("CPU", "#4f9dff", arr.cpu)],
    (v) => v + "%",
    (p) => p.map(s => `${s.marker}${s.seriesName}: ${(+s.value[1]).toFixed(1)}%`).join("<br>"), 100));
  charts.mem.setOption(lineOption("内存使用率 (%)",
    [areaSeries("内存", "#22c55e", arr.mem)],
    (v) => v + "%",
    (p) => p.map(s => `${s.marker}${s.seriesName}: ${(+s.value[1]).toFixed(1)}%`).join("<br>"), 100));
  charts.net.setOption(lineOption("网络速率 (MB/s)",
    [areaSeries("下行", "#38bdf8", arr.netRx), areaSeries("上行", "#f59e0b", arr.netTx)],
    (v) => v.toFixed(1),
    (p) => { const t = new Date(p[0].value[0]).toLocaleTimeString(); return t + "<br>" + p.map(s => `${s.marker}${s.seriesName}: ${(s.value[1]).toFixed(2)} MB/s (${(s.value[1] * 8).toFixed(1)} Mbps)`).join("<br>"); }));
  charts.diskio.setOption(lineOption("磁盘 IO (MB/s)",
    [areaSeries("读", "#a78bfa", arr.dRd), areaSeries("写", "#fb7185", arr.dWr)],
    (v) => v.toFixed(1),
    (p) => p.map(s => `${s.marker}${s.seriesName}: ${(s.value[1]).toFixed(2)} MB/s`).join("<br>")));
}

function pushLive(d) {
  const t = d.ts;
  live.cpu.push([t, d.cpu]);
  live.mem.push([t, d.mem.pct]);
  live.netRx.push([t, d.net.rx / MB]);
  live.netTx.push([t, d.net.tx / MB]);
  live.dRd.push([t, d.diskIO.rd / MB]);
  live.dWr.push([t, d.diskIO.wr / MB]);
  for (const k of Object.keys(live)) if (live[k].length > LIVE_CAP) live[k].shift();
}

async function loadHistory(range) {
  const r = await fetch("/api/history?range=" + range).then(x => x.json());
  const arr = { cpu: [], mem: [], netRx: [], netTx: [], dRd: [], dWr: [] };
  for (const p of r.points) {
    arr.cpu.push([p.t, p.cpu]);
    arr.mem.push([p.t, p.memPct]);
    arr.netRx.push([p.t, p.netRx / MB]);
    arr.netTx.push([p.t, p.netTx / MB]);
    arr.dRd.push([p.t, p.diskRd / MB]);
    arr.dWr.push([p.t, p.diskWr / MB]);
  }
  renderSys(arr);
}

// ---------- 网络明细 ----------
let ndRange = "boot";
async function loadNetwork() {
  const url = "/api/network" + (ndRange !== "boot" ? "?range=" + ndRange : "");
  let d;
  try { d = await fetch(url).then(x => x.json()); } catch { return; }
  const period = d.range && d.range !== "boot";
  document.getElementById("nd-rx-h").textContent = period ? "区间接收" : "累计接收";
  document.getElementById("nd-tx-h").textContent = period ? "区间发送" : "累计发送";
  const tb = document.querySelector("#iface-tbl tbody");
  tb.innerHTML = d.ifaces.map((i) => {
    const rxC = period ? (i.hasPeriod ? fmtBytes(i.periodRx) : "—") : fmtBytes(i.rxTotal);
    const txC = period ? (i.hasPeriod ? fmtBytes(i.periodTx) : "—") : fmtBytes(i.txTotal);
    return `<tr class="${i.physical ? "phys" : ""}"><td>${esc(i.name)}${i.name === d.primaryIface ? ' <span class="tag">主</span>' : ""}</td>` +
      `<td>${fmtRate(i.rx)}</td><td>${fmtRate(i.tx)}</td><td>${rxC}</td><td>${txC}</td></tr>`;
  }).join("");
  document.getElementById("net-detail-note").textContent = period
    ? `${d.conns} 个连接 · 区间为该时段进出(— = 该网卡 vnStat 未统计)`
    : `${d.conns} 个连接 · 加粗为物理网卡`;
}

// ---------- 进程 TOP ----------
let procSort = "cpu";
let procData = null;
function renderProcesses() {
  const tb = document.querySelector("#proc-tbl tbody");
  if (!procData) return;
  if (procData.error) { tb.innerHTML = `<tr><td colspan="5" class="muted">${esc(procData.error)}</td></tr>`; return; }
  const list = procSort === "cpu" ? procData.byCpu : procData.byMem;
  tb.innerHTML = (list || []).map((p) =>
    `<tr><td>${p.pid}</td><td>${esc(p.name)}</td><td>${(p.cpu || 0).toFixed(1)}</td><td>${(p.mem || 0).toFixed(1)}</td><td>${fmtBytes(p.rss)}</td></tr>`).join("");
}
async function loadProcesses() {
  try { procData = await fetch("/api/processes").then((x) => x.json()); renderProcesses(); } catch {}
}

// ---------- Docker / PM2 ----------
async function loadServices() {
  let d;
  try { d = await fetch("/api/services").then((x) => x.json()); } catch { return; }
  const dt = document.querySelector("#docker-tbl tbody");
  if (!d.docker || !d.docker.available) dt.innerHTML = `<tr><td colspan="4" class="muted">Docker 不可用</td></tr>`;
  else dt.innerHTML = (d.docker.containers || []).map((c) => {
    const up = /^Up/i.test(c.status || "") || c.state === "running";
    return `<tr><td>${esc(c.name)}</td><td class="${up ? "st-ok" : "st-bad"}">${esc(c.status || c.state || "")}</td><td>${c.cpu != null ? c.cpu.toFixed(1) : "-"}</td><td>${esc(c.mem || "-")}</td></tr>`;
  }).join("") || `<tr><td colspan="4" class="muted">无容器</td></tr>`;
  const pt = document.querySelector("#pm2-tbl tbody");
  if (!d.pm2 || !d.pm2.available) pt.innerHTML = `<tr><td colspan="5" class="muted">PM2 不可用</td></tr>`;
  else pt.innerHTML = (d.pm2.procs || []).map((p) => {
    const ok = p.status === "online";
    return `<tr><td>${esc(p.name)}</td><td class="${ok ? "st-ok" : "st-bad"}">${esc(p.status || "")}</td><td>${p.cpu || 0}</td><td>${fmtBytes(p.mem)}</td><td>${p.restarts}</td></tr>`;
  }).join("") || `<tr><td colspan="5" class="muted">无进程</td></tr>`;
}

// ---------- 磁盘分区 ----------
async function loadDisks() {
  let list;
  try { list = await fetch("/api/disks").then((x) => x.json()); } catch { return; }
  const el = document.getElementById("disks");
  el.innerHTML = (list || []).map((d) => {
    const cls = d.pct >= 90 ? "crit" : d.pct >= 75 ? "warn" : "";
    return `<div class="disk-row"><div class="disk-top"><span>${esc(d.mount)} <span class="muted">${esc(d.fs)}</span></span>` +
      `<span>${fmtBytes(d.used)} / ${fmtBytes(d.total)} (${d.pct}%)</span></div>` +
      `<div class="disk-bar"><div class="disk-fill ${cls}" style="width:${Math.min(100, d.pct)}%"></div></div></div>`;
  }).join("") || '<span class="muted">无数据</span>';
}

// ---------- 存储与清理 ----------
async function loadStorage() {
  let s;
  try { s = await fetch("/api/storage").then((x) => x.json()); } catch { return; }
  const retTxt = s.retentionDays > 0
    ? `保留 <b>${s.retentionDays} 天</b>(每小时自动删过期、每天回收磁盘)`
    : `<b>不自动清理</b>(数据永久保留)`;
  document.getElementById("storage-info").innerHTML =
    `采样数据库 <b>${fmtBytes(s.dbBytes)}</b> · ${(s.rows || 0).toLocaleString()} 条采样 · ${retTxt}<br>` +
    `进程内存 ${fmtBytes(s.processRss)} · 采样间隔 ${s.sampleIntervalSec}s`;
  const sel = document.getElementById("retention-sel");
  if (sel) sel.value = String(s.retentionDays);
}

// ---------- 流量统计 ----------
async function loadTraffic() {
  let url = "/api/traffic?iface=" + encodeURIComponent(trafficIface);
  if (trafficRange === "custom") {
    const s = document.getElementById("d-start").value, e = document.getElementById("d-end").value;
    if (!s || !e) return;
    url += `&start=${s}&end=${e}T23:59:59`;
  } else {
    url += "&range=" + trafficRange;
  }
  const d = await fetch(url).then(x => x.json());
  const cats = [], rx = [], tx = [];
  const gran = d.granularity;
  for (const p of (d.points || [])) {
    const dt = new Date(p.t);
    cats.push(gran === "h" ? `${dt.getMonth() + 1}/${dt.getDate()} ${String(dt.getHours()).padStart(2, "0")}时` : `${dt.getMonth() + 1}/${dt.getDate()}`);
    rx.push((p.rx / 1048576).toFixed(2));
    tx.push((p.tx / 1048576).toFixed(2));
  }
  const total = d.total || { rx: 0, tx: 0 };
  document.getElementById("traffic-total").innerHTML =
    `区间合计 &nbsp; <b class="rxc">↓ 进 ${fmtBytes(total.rx)}</b> &nbsp;&nbsp; <b class="txc">↑ 出 ${fmtBytes(total.tx)}</b>` +
    (d.error ? ` <span class="muted">(vnStat: ${d.error})</span>` : "");
  charts.traffic.setOption({
    backgroundColor: "transparent",
    grid: { left: 60, right: 16, top: 36, bottom: 50 },
    tooltip: {
      trigger: "axis", backgroundColor: TIPBG, borderColor: GRID, textStyle: { color: TIPTEXT },
      formatter: (p) => p[0].axisValue + "<br>" + p.map(s => `${s.marker}${s.seriesName}: ${s.value} MB`).join("<br>"),
    },
    legend: { right: 8, top: 6, textStyle: { color: AXIS }, icon: "roundRect", itemWidth: 12, itemHeight: 8 },
    xAxis: { type: "category", data: cats, axisLabel: { color: AXIS, fontSize: 11, rotate: cats.length > 16 ? 45 : 0 }, axisLine: { lineStyle: { color: GRID } } },
    yAxis: valAxis((v) => v >= 1024 ? (v / 1024).toFixed(1) + "G" : v + "M"),
    series: [
      { name: "进 (下行)", type: "bar", stack: null, data: rx, itemStyle: { color: "#38bdf8" }, barMaxWidth: 22 },
      { name: "出 (上行)", type: "bar", data: tx, itemStyle: { color: "#f59e0b" }, barMaxWidth: 22 },
    ],
  });
}

// ---------- 轮询 ----------
async function tick() {
  try {
    const d = await fetch("/api/realtime").then(x => x.json());
    updateCards(d);
    if (sysRange === "live") { pushLive(d); renderSys(live); }
  } catch (e) { /* 忽略瞬时失败 */ }
}

// ---------- 面板折叠 ----------
// 这些面板首次访问默认折叠 (实时监控 + 流量统计 默认展开)
const DEFAULT_COLLAPSED = new Set(["进程 TOP", "Docker 容器 / PM2 进程", "磁盘分区", "网络明细", "存储与清理"]);
function setupCollapsible() {
  document.querySelectorAll(".panel").forEach((panel) => {
    const head = panel.querySelector(".panel-head");
    const h2 = head && head.querySelector("h2");
    if (!head || !h2) return;
    const title = h2.textContent.trim();
    const key = "sm-collapse-" + title;
    // 把 panel-head 之后的内容包进 panel-body
    const body = document.createElement("div");
    body.className = "panel-body";
    let n = head.nextElementSibling;
    while (n) { const next = n.nextElementSibling; body.appendChild(n); n = next; }
    panel.appendChild(body);
    // 表格包一层可横向滚动容器 (手机适配)
    body.querySelectorAll("table.tbl").forEach((t) => {
      if (t.parentElement && t.parentElement.classList.contains("tbl-wrap")) return;
      const w = document.createElement("div"); w.className = "tbl-wrap";
      t.parentNode.insertBefore(w, t); w.appendChild(t);
    });
    // 标题加折叠箭头
    h2.classList.add("collapsible");
    const caret = document.createElement("span");
    caret.className = "caret"; caret.textContent = "▾";
    h2.prepend(caret);
    const saved = localStorage.getItem(key);
    const collapsed = saved === null ? DEFAULT_COLLAPSED.has(title) : saved === "1";
    if (collapsed) panel.classList.add("collapsed");
    h2.onclick = () => {
      panel.classList.toggle("collapsed");
      try { localStorage.setItem(key, panel.classList.contains("collapsed") ? "1" : "0"); } catch {}
      if (!panel.classList.contains("collapsed")) setTimeout(() => window.dispatchEvent(new Event("resize")), 60);
    };
  });
}

// ---------- 初始化 ----------
async function init() {
  applyTheme(localStorage.getItem("sm-theme") || "light");
  document.getElementById("theme-btn").onclick = () => {
    applyTheme(document.body.classList.contains("theme-light") ? "dark" : "light");
    if (sysRange === "live") renderSys(live); else loadHistory(sysRange);
    loadTraffic();
  };

  // 修改密码
  const pwModal = document.getElementById("pw-modal");
  const pwMsg = document.getElementById("pw-msg");
  const closePw = () => { pwModal.style.display = "none"; pwMsg.textContent = ""; ["pw-old", "pw-new", "pw-new2"].forEach((id) => (document.getElementById(id).value = "")); };
  document.getElementById("pw-btn").onclick = () => { pwModal.style.display = "flex"; document.getElementById("pw-old").focus(); };
  document.getElementById("pw-cancel").onclick = closePw;
  pwModal.onclick = (e) => { if (e.target === pwModal) closePw(); };
  document.getElementById("pw-submit").onclick = async () => {
    const oldPassword = document.getElementById("pw-old").value;
    const n1 = document.getElementById("pw-new").value, n2 = document.getElementById("pw-new2").value;
    if (!oldPassword || !n1) { pwMsg.textContent = "请填写完整"; return; }
    if (n1.length < 4) { pwMsg.textContent = "新密码至少 4 位"; return; }
    if (n1 !== n2) { pwMsg.textContent = "两次新密码不一致"; return; }
    pwMsg.textContent = "提交中…";
    try {
      const r = await fetch("/api/change-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ oldPassword, newPassword: n1 }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok) { pwMsg.textContent = "修改成功"; setTimeout(closePw, 1000); }
      else pwMsg.textContent = d.error || "修改失败";
    } catch { pwMsg.textContent = "网络错误"; }
  };

  // 一键清理
  document.getElementById("cleanup-btn").onclick = async () => {
    const msg = document.getElementById("cleanup-msg");
    msg.textContent = "清理中…";
    try {
      const d = await fetch("/api/cleanup", { method: "POST" }).then((x) => x.json());
      msg.textContent = `已清理, 释放 ${fmtBytes(d.freed)}, 现存 ${(d.rows || 0).toLocaleString()} 条`;
      loadStorage();
    } catch { msg.textContent = "清理失败"; }
  };

  // 数据保留时长切换
  const retSel = document.getElementById("retention-sel");
  retSel.onchange = async () => {
    await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ retentionDays: Number(retSel.value) }) }).catch(() => {});
    loadStorage();
  };

  // 首次使用初始化向导
  const initModal = document.getElementById("init-modal");
  try {
    const st = await fetch("/api/storage").then((x) => x.json());
    if (!st.initialized) initModal.style.display = "flex";
  } catch {}
  document.getElementById("init-done").onclick = async () => {
    const v = Number(document.getElementById("init-retention").value);
    await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ retentionDays: v, initialized: true }) }).catch(() => {});
    initModal.style.display = "none";
    loadStorage();
  };

  setupCollapsible();
  initCharts();
  const info = await fetch("/api/info").then(x => x.json());
  document.getElementById("host").textContent = info.hostname;
  document.getElementById("uptime").textContent = "运行 " + fmtUptime(info.uptime);
  trafficIface = info.primaryIface;
  // 网卡下拉
  const sel = document.getElementById("traffic-iface");
  sel.innerHTML = (info.physicalIfaces.length ? info.physicalIfaces : info.ifaces)
    .map(n => `<option value="${n}"${n === trafficIface ? " selected" : ""}>${n}</option>`).join("");
  sel.onchange = () => { trafficIface = sel.value; loadTraffic(); };

  // 系统图时间段切换
  document.querySelectorAll("#sys-ranges button").forEach(b => b.onclick = () => {
    document.querySelectorAll("#sys-ranges button").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    sysRange = b.dataset.r;
    if (sysRange === "live") renderSys(live); else loadHistory(sysRange);
  });

  // 刷新频率切换
  document.querySelectorAll("#refresh-rates button").forEach(b => b.onclick = () => {
    document.querySelectorAll("#refresh-rates button").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    startTick(Number(b.dataset.ms));
  });

  // 进程榜 CPU/内存 排序切换
  document.querySelectorAll("#proc-sort button").forEach(b => b.onclick = () => {
    document.querySelectorAll("#proc-sort button").forEach(x => x.classList.remove("active"));
    b.classList.add("active"); procSort = b.dataset.s; renderProcesses();
  });

  // 网络明细 时间档切换
  document.querySelectorAll("#nd-ranges button").forEach(b => b.onclick = () => {
    document.querySelectorAll("#nd-ranges button").forEach(x => x.classList.remove("active"));
    b.classList.add("active"); ndRange = b.dataset.r; loadNetwork();
  });

  // 流量时间段切换
  document.querySelectorAll("#traffic-ranges button").forEach(b => b.onclick = () => {
    document.querySelectorAll("#traffic-ranges button").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    trafficRange = b.dataset.r;
    document.getElementById("custom-range").style.display = trafficRange === "custom" ? "flex" : "none";
    if (trafficRange !== "custom") loadTraffic();
  });
  document.getElementById("apply-custom").onclick = loadTraffic;

  if (!info.vnstat) document.getElementById("traffic-total").innerHTML = '<span class="muted">vnStat 不可用</span>';

  await tick();
  loadNetwork(); loadTraffic(); loadProcesses(); loadServices(); loadDisks(); loadStorage();
  startTick(3000); // 默认 3 秒刷新, 可在界面切换
  setInterval(loadStorage, 60000);
  setInterval(loadNetwork, 5000);
  setInterval(loadProcesses, 5000);
  setInterval(loadServices, 6000);
  setInterval(loadDisks, 30000);
  setInterval(() => { if (sysRange !== "live") loadHistory(sysRange); }, 30000);
  setInterval(loadTraffic, 60000);
}
init();
