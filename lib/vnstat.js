// vnStat 封装: 调 `vnstat --json <mode>` 拿进出流量, 解析成统一的时间序列。
// vnStat 2.x JSON 里 rx/tx 单位是 字节(bytes)。
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

async function vnstatJson(iface, mode) {
  // mode: h(小时) d(天) m(月); 不传 mode = 完整(含 day+month+year+total). 指定网卡用 -i
  const args = ["--json"];
  if (mode) args.push(mode);
  if (iface) args.unshift("-i", iface);
  try {
    const { stdout } = await pexec("vnstat", args, { timeout: 8000, maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

function entryDate(e) {
  // 兼容 day/month/hour 三种: date={year,month,day}, time={hour,minute}
  const d = e.date || {};
  const t = e.time || {};
  return new Date(
    d.year || 1970,
    (d.month || 1) - 1,
    d.day || 1,
    t.hour || 0,
    t.minute || 0
  );
}

function extractSeries(json, mode) {
  if (!json || json.error || !Array.isArray(json.interfaces)) return [];
  const iface = json.interfaces[0];
  if (!iface || !iface.traffic) return [];
  const arr = iface.traffic[mode === "h" ? "hour" : mode === "d" ? "day" : "month"] || [];
  return arr.map((e) => ({
    t: entryDate(e).getTime(),
    rx: e.rx || 0,
    tx: e.tx || 0,
  }));
}

export async function listIfaces() {
  try {
    const { stdout } = await pexec("vnstat", ["--json"], { timeout: 8000, maxBuffer: 8 * 1024 * 1024 });
    const j = JSON.parse(stdout);
    return (j.interfaces || []).map((i) => i.name);
  } catch {
    return [];
  }
}

export async function available() {
  try {
    await pexec("vnstat", ["--version"], { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

// 取某网卡在 [from,to] 区间的进出流量序列 + 合计。
// 自动选粒度: 跨度<=2天用小时, 否则用天。
export async function traffic(iface, fromMs, toMs) {
  const spanDays = (toMs - fromMs) / 86400000;
  // <=2天用小时, <=60天用天, 更长用月 (vnStat 日数据默认只留 ~62 天)
  const mode = spanDays <= 2 ? "h" : spanDays <= 60 ? "d" : "m";
  const json = await vnstatJson(iface, mode);
  if (json.error) return { error: json.error, granularity: mode, points: [], total: { rx: 0, tx: 0 } };

  let points = extractSeries(json, mode).filter((p) => p.t >= fromMs && p.t <= toMs);
  points.sort((a, b) => a.t - b.t);

  const total = points.reduce(
    (acc, p) => ({ rx: acc.rx + p.rx, tx: acc.tx + p.tx }),
    { rx: 0, tx: 0 }
  );
  return { granularity: mode, points, total };
}

// 一次取所有网卡在 [from,to] 区间的进出合计 (一条 vnstat --json 全网卡)
export async function trafficByIface(fromMs, toMs) {
  const spanDays = (toMs - fromMs) / 86400000;
  const mode = spanDays <= 2 ? "h" : spanDays <= 60 ? "d" : "m";
  const json = await vnstatJson(null, mode);
  const out = {};
  if (!json || json.error || !Array.isArray(json.interfaces)) return out;
  const key = mode === "h" ? "hour" : mode === "d" ? "day" : "month";
  for (const iface of json.interfaces) {
    const arr = (iface.traffic && iface.traffic[key]) || [];
    let rx = 0, tx = 0;
    for (const e of arr) {
      const t = entryDate(e).getTime();
      if (t >= fromMs && t <= toMs) { rx += e.rx || 0; tx += e.tx || 0; }
    }
    out[iface.name] = { rx, tx };
  }
  return out;
}

// 当前小时/今日的实时累计(给概览卡片用)
export async function summary(iface) {
  const json = await vnstatJson(iface); // 完整 JSON, 含 day + month + total
  if (json.error || !Array.isArray(json.interfaces) || !json.interfaces[0]) {
    return { today: { rx: 0, tx: 0 }, month: { rx: 0, tx: 0 }, total: { rx: 0, tx: 0 } };
  }
  const tr = json.interfaces[0].traffic || {};
  const days = tr.day || [];
  const months = tr.month || [];
  const today = days.length ? days[days.length - 1] : { rx: 0, tx: 0 };
  const month = months.length ? months[months.length - 1] : { rx: 0, tx: 0 };
  const total = tr.total || { rx: 0, tx: 0 };
  return {
    today: { rx: today.rx || 0, tx: today.tx || 0 },
    month: { rx: month.rx || 0, tx: month.tx || 0 },
    total: { rx: total.rx || 0, tx: total.tx || 0 },
  };
}
