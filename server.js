// 轻量服务器监控面板 — 后端入口
// CPU/内存/磁盘/网络实时采集 (/proc) + SQLite 历史 + vnStat 流量统计 + 登录
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import fastifyFormbody from "@fastify/formbody";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { MetricsCollector } from "./lib/metrics.js";
import { Store } from "./lib/db.js";
import { loadConfig, verifyLogin, saveConfig } from "./lib/config.js";
import * as vnstat from "./lib/vnstat.js";
import * as sys from "./lib/system.js";
import { hostname } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.SM_CONFIG || join(__dirname, "config.json");
const cfg = loadConfig(CONFIG_PATH);

const store = new Store(resolve(__dirname, cfg.dbPath), cfg.retentionDays);
const collector = new MetricsCollector();

// ---- 采样循环 ----
let lastSample = collector.sample(); // 基线 (速率为0)
let primaryIface = cfg.primaryIface || pickPrimaryIface(lastSample);

function pickPrimaryIface(s) {
  const phys = Object.entries(s.perIface).filter(([, v]) => v.physical);
  return phys.length ? phys[0][0] : Object.keys(s.perIface)[0] || "";
}

// 实时值每 1 秒刷新一次(供前端高频轮询); 落库按 sampleIntervalSec 节流省空间
let sampleTick = 0;
const storeEvery = Math.max(1, Math.round(cfg.sampleIntervalSec));
setInterval(() => {
  try {
    lastSample = collector.sample();
    sampleTick++;
    if (sampleTick % storeEvery === 0) store.insert(lastSample);
    if (!cfg.primaryIface) primaryIface = pickPrimaryIface(lastSample);
  } catch (e) {
    app.log.error(e, "sample failed");
  }
}, 1000);

setInterval(() => store.prune(), 3600 * 1000); // 每小时清理过期采样
setInterval(() => { store.prune(); store.vacuum(); }, 24 * 3600 * 1000); // 每天回收磁盘空间

// vnStat 概览缓存 (避免高频调用)
let trafficSummaryCache = { ts: 0, data: null };
async function getTrafficSummary() {
  if (Date.now() - trafficSummaryCache.ts < 30000 && trafficSummaryCache.data) {
    return trafficSummaryCache.data;
  }
  const data = await vnstat.summary(primaryIface);
  trafficSummaryCache = { ts: Date.now(), data };
  return data;
}

// 通用 TTL 缓存 (给 docker/pm2/ps/df 这类系统命令降频)
const _cache = new Map();
async function cached(key, ttl, fn) {
  const e = _cache.get(key);
  if (e && Date.now() - e.ts < ttl) return e.data;
  const data = await fn();
  _cache.set(key, { ts: Date.now(), data });
  return data;
}

// ---- Fastify ----
const app = Fastify({ logger: { level: "warn" }, trustProxy: true });
await app.register(fastifyCookie, { secret: cfg.cookieSecret });
await app.register(fastifyFormbody);
await app.register(fastifyStatic, { root: join(__dirname, "public", "static"), prefix: "/static/" });

const COOKIE = "sm_auth";
const SESSION_TTL = 7 * 24 * 3600 * 1000;

function isAuthed(req) {
  const raw = req.cookies[COOKIE];
  if (!raw) return false;
  const un = app.unsignCookie(raw);
  if (!un.valid || !un.value) return false;
  const [user, exp] = un.value.split("|");
  if (!user || !exp || Date.now() > Number(exp)) return false;
  return user === cfg.username;
}

function setSession(reply) {
  const val = `${cfg.username}|${Date.now() + SESSION_TTL}`;
  reply.setCookie(COOKIE, app.signCookie(val), {
    path: "/", httpOnly: true, sameSite: "lax",
    secure: false, // nginx 终止 TLS, 内部 http
    maxAge: SESSION_TTL / 1000,
  });
}

// 鉴权守卫: 放行登录页 + 静态资源 + 健康检查
app.addHook("preHandler", async (req, reply) => {
  const url = req.raw.url.split("?")[0];
  const open = url === "/login" || url === "/healthz" || url.startsWith("/static/");
  if (open) return;
  if (!isAuthed(req)) {
    if (url.startsWith("/api/")) return reply.code(401).send({ error: "unauthorized" });
    return reply.redirect("/login");
  }
});

// ---- 页面 ----
app.get("/healthz", async () => ({ ok: true }));
app.get("/", (req, reply) => reply.sendFile("index.html", join(__dirname, "public")));
app.get("/login", (req, reply) => {
  if (isAuthed(req)) return reply.redirect("/");
  return reply.sendFile("login.html", join(__dirname, "public"));
});
app.post("/login", async (req, reply) => {
  const { username, password } = req.body || {};
  if (verifyLogin(cfg, username, password)) {
    setSession(reply);
    return reply.redirect("/");
  }
  return reply.redirect("/login?e=1");
});
app.post("/logout", (req, reply) => {
  reply.clearCookie(COOKIE, { path: "/" });
  return reply.redirect("/login");
});

// ---- API ----
app.get("/api/info", async () => ({
  hostname: hostname(),
  uptime: lastSample.uptime,
  coreCount: lastSample.coreCount,
  memTotal: lastSample.mem.total,
  diskTotal: lastSample.disk.total,
  primaryIface,
  ifaces: Object.keys(lastSample.perIface),
  physicalIfaces: Object.entries(lastSample.perIface).filter(([, v]) => v.physical).map(([k]) => k),
  vnstat: await vnstat.available(),
  sampleIntervalSec: cfg.sampleIntervalSec,
}));

app.get("/api/realtime", async () => {
  const s = lastSample;
  return {
    ts: s.ts,
    cpu: s.cpu,
    cores: s.cores,
    load: s.load,
    mem: { total: s.mem.total, used: s.mem.used, available: s.mem.available, pct: s.mem.total ? +(s.mem.used / s.mem.total * 100).toFixed(1) : 0, swapTotal: s.mem.swapTotal, swapUsed: s.mem.swapUsed },
    disk: { total: s.disk.total, used: s.disk.used, free: s.disk.free, pct: s.disk.total ? +(s.disk.used / s.disk.total * 100).toFixed(1) : 0 },
    diskIO: s.diskIO,
    net: s.net,
    conns: s.conns,
    uptime: s.uptime,
    traffic: await getTrafficSummary(),
  };
});

// 系统曲线历史 (来自 SQLite, 上限保留期内)
app.get("/api/history", async (req) => {
  const now = Math.floor(Date.now() / 1000);
  const range = (req.query.range || "live").toString();
  const map = { live: 600, "1h": 3600, "6h": 21600, "24h": 86400, "7d": 604800 };
  const span = map[range] || 600;
  return { range, points: store.history(now - span, now, 600) };
});

// 当前网卡明细 (range=boot 显示自开机累计; 其他时间档显示该区间 vnStat 进出)
app.get("/api/network", async (req) => {
  const range = (req.query.range || "boot").toString();
  const ifaces = Object.entries(lastSample.perIface).map(([name, v]) => ({
    name, rx: Math.round(v.rx), tx: Math.round(v.tx),
    rxTotal: v.rxTotal, txTotal: v.txTotal, physical: v.physical,
  }));
  if (range !== "boot") {
    const [from, to] = resolveRange({ range });
    const period = await cached("netperiod:" + range, 15000, () => vnstat.trafficByIface(from, to));
    for (const i of ifaces) {
      const p = period[i.name];
      i.hasPeriod = !!p;
      i.periodRx = p ? p.rx : 0;
      i.periodTx = p ? p.tx : 0;
    }
  }
  ifaces.sort((a, b) => (b.physical - a.physical) || (b.rx + b.tx - a.rx - a.tx));
  return { conns: lastSample.conns, primaryIface, range, ifaces };
});

// 进程 TOP (CPU/内存 两个榜)
app.get("/api/processes", async () => cached("proc", 3000, () => sys.topProcesses(12)));

// Docker 容器 + PM2 进程
app.get("/api/services", async () => {
  const [docker, pm2] = await Promise.all([
    cached("docker", 5000, () => sys.dockerStats()),
    cached("pm2", 5000, () => sys.pm2List()),
  ]);
  return { docker, pm2 };
});

// 磁盘多分区
app.get("/api/disks", async () => cached("disks", 20000, () => sys.disks()));

// 存储占用
app.get("/api/storage", async () => {
  const s = store.stats();
  return { ...s, initialized: cfg.initialized, processRss: process.memoryUsage().rss, uptime: lastSample.uptime, sampleIntervalSec: cfg.sampleIntervalSec };
});

// 设置: 数据保留时长 (0=不自动清理) + 初始化标记
app.post("/api/settings", async (req, reply) => {
  const { retentionDays, initialized } = req.body || {};
  if (retentionDays !== undefined) {
    const v = Number(retentionDays);
    if (![0, 35, 60, 90, 365].includes(v)) return reply.code(400).send({ error: "无效的保留天数" });
    cfg.retentionDays = v;
    store.setRetention(v);
  }
  if (initialized !== undefined) cfg.initialized = !!initialized;
  try { saveConfig(CONFIG_PATH, cfg); } catch { return reply.code(500).send({ error: "保存失败" }); }
  return { ok: true, retentionDays: cfg.retentionDays, initialized: cfg.initialized };
});

// 手动清理 (prune + VACUUM 回收磁盘)
app.post("/api/cleanup", async () => {
  const before = store.sizeBytes();
  store.prune();
  store.vacuum();
  const after = store.sizeBytes();
  return { ok: true, before, after, freed: Math.max(0, before - after), rows: store.rowCount(), retentionDays: store.retentionDays };
});

// 修改密码 (需已登录; 验证原密码后写回 config.json)
app.post("/api/change-password", async (req, reply) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!verifyLogin(cfg, cfg.username, oldPassword)) return reply.code(400).send({ error: "原密码错误" });
  if (typeof newPassword !== "string" || newPassword.length < 4) return reply.code(400).send({ error: "新密码至少 4 位" });
  cfg.password = newPassword;
  try { saveConfig(CONFIG_PATH, cfg); } catch (e) { return reply.code(500).send({ error: "保存失败" }); }
  return { ok: true };
});

// 流量统计 (vnStat): 进/出, 时间段
app.get("/api/traffic", async (req) => {
  const q = req.query;
  const iface = (q.iface || primaryIface).toString();
  const [fromMs, toMs] = resolveRange(q);
  const data = await vnstat.traffic(iface, fromMs, toMs);
  return { iface, from: fromMs, to: toMs, ...data };
});

function resolveRange(q) {
  const now = Date.now();
  if (q.start && q.end) {
    return [new Date(q.start).getTime(), new Date(q.end).getTime()];
  }
  const day = 86400000;
  const r = (q.range || "7d").toString();
  if (r === "month") {
    const d = new Date();
    return [new Date(d.getFullYear(), d.getMonth(), 1).getTime(), now];
  }
  const presets = { "1d": 1, "7d": 7, "15d": 15, "30d": 30, "90d": 90, "1y": 365 };
  const days = presets[r] || 7;
  return [now - days * day, now];
}

const addr = await app.listen({ port: cfg.port, host: cfg.host });
app.log.warn(`server-monitor listening on ${addr}, primaryIface=${primaryIface}`);
console.log(`[server-monitor] up at ${addr} | iface=${primaryIface} | user=${cfg.username}`);
