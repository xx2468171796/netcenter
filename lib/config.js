// 配置加载: 首次自动生成 config.json (随机 cookieSecret), 默认 admin/admin。
// 账号密码为单管理员, 直接改 config.json 即可 (文件应 chmod 600 root-only)。
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";

const DEFAULTS = {
  port: 8055,
  host: "127.0.0.1",        // 只绑本地, 对外走 nginx 反代
  username: "admin",
  password: "admin",        // ⚠️ 首次登录后请改
  primaryIface: "",         // 留空=自动选第一个物理网卡
  sampleIntervalSec: 3,     // 采样落库间隔(秒); 实时值固定每 1 秒刷新
  retentionDays: 35,        // SQLite 采样保留天数 (0 = 不自动清理)
  initialized: false,       // 首次使用初始化向导是否完成
  dbPath: "./data/metrics.db",
  cookieSecret: "",         // 自动生成
};

export function loadConfig(path) {
  let cfg;
  if (existsSync(path)) {
    cfg = { ...DEFAULTS, ...JSON.parse(readFileSync(path, "utf8")) };
  } else {
    cfg = { ...DEFAULTS };
  }
  if (!cfg.cookieSecret) {
    cfg.cookieSecret = process.env.SM_COOKIE_SECRET || randomBytes(32).toString("hex");
    try { writeFileSync(path, JSON.stringify(cfg, null, 2)); chmodSync(path, 0o600); } catch {}
  }
  // 环境变量覆盖 (Docker 友好, 无需 config.json)
  if (process.env.SM_PORT) cfg.port = Number(process.env.SM_PORT);
  if (process.env.SM_HOST) cfg.host = process.env.SM_HOST;
  if (process.env.SM_USER) cfg.username = process.env.SM_USER;
  if (process.env.SM_PASS) cfg.password = process.env.SM_PASS;
  if (process.env.SM_IFACE) cfg.primaryIface = process.env.SM_IFACE;
  return cfg;
}

export function saveConfig(path, cfg) {
  writeFileSync(path, JSON.stringify(cfg, null, 2));
  try { chmodSync(path, 0o600); } catch {}
}

export function verifyLogin(cfg, user, pass) {
  if (typeof user !== "string" || typeof pass !== "string") return false;
  const okUser = safeEqual(user, cfg.username);
  const okPass = safeEqual(pass, cfg.password);
  return okUser && okPass;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // 仍跑一次比较防时序泄漏
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}
