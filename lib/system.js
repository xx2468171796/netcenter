// 进程 TOP / Docker / PM2 / 磁盘多分区 采集。全部调系统命令, 失败优雅降级。
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);
const HOST_ROOT = process.env.HOST_ROOT || "/";

async function run(cmd, args, timeout = 6000) {
  try {
    const { stdout } = await pexec(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    return null;
  }
}

// 进程 TOP: 一次 ps 全量, JS 出 CPU/内存 两个榜
export async function topProcesses(limit = 12) {
  // 数值字段在前, comm 放末尾(可能含空格)
  const out = await run("ps", ["-eo", "pid,pcpu,pmem,rss,comm", "--no-headers", "--sort=-pcpu"]);
  if (!out) return { byCpu: [], byMem: [], error: "ps 不可用" };
  const rows = [];
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const f = t.split(/\s+/);
    if (f.length < 5) continue;
    const name = f.slice(4).join(" ");
    if (name === "ps") continue; // 排除测量命令自身(瞬时 CPU 假象)
    rows.push({
      pid: Number(f[0]),
      cpu: Number(f[1]),
      mem: Number(f[2]),
      rss: Number(f[3]) * 1024,
      name,
    });
  }
  const byCpu = [...rows].sort((a, b) => b.cpu - a.cpu).slice(0, limit);
  const byMem = [...rows].sort((a, b) => b.rss - a.rss).slice(0, limit);
  return { byCpu, byMem, total: rows.length };
}

// Docker: 容器存活 + CPU/内存 (合并 ps -a 与 stats)
export async function dockerStats() {
  const psOut = await run("docker", ["ps", "-a", "--format", "{{.Names}}\t{{.Status}}\t{{.Image}}\t{{.State}}"]);
  if (psOut == null) return { available: false, containers: [] };
  const map = {};
  for (const line of psOut.split("\n")) {
    if (!line.trim()) continue;
    const [name, status, image, state] = line.split("\t");
    map[name] = { name, status, image, state, cpu: null, mem: null, memPct: null };
  }
  // stats 只含运行中的
  const statOut = await run("docker", ["stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}"], 8000);
  if (statOut) {
    for (const line of statOut.split("\n")) {
      if (!line.trim()) continue;
      const [name, cpu, memUsage, memPct] = line.split("\t");
      if (map[name]) {
        map[name].cpu = parseFloat(cpu) || 0;
        map[name].mem = (memUsage || "").split("/")[0].trim();
        map[name].memPct = parseFloat(memPct) || 0;
      }
    }
  }
  const containers = Object.values(map).sort((a, b) => (b.cpu || 0) - (a.cpu || 0));
  return { available: true, containers };
}

// PM2: jlist
export async function pm2List() {
  const out = await run("pm2", ["jlist"], 6000);
  if (out == null) return { available: false, procs: [] };
  let arr;
  try {
    // jlist 偶尔带前导日志, 截取第一个 [
    const i = out.indexOf("[");
    arr = JSON.parse(i >= 0 ? out.slice(i) : out);
  } catch {
    return { available: false, procs: [] };
  }
  const procs = (arr || []).map((p) => ({
    name: p.name,
    pmId: p.pm_id,
    status: p.pm2_env?.status,
    restarts: p.pm2_env?.restart_time ?? 0,
    uptime: p.pm2_env?.pm_uptime ?? 0,
    cpu: p.monit?.cpu ?? 0,
    mem: p.monit?.memory ?? 0,
    instances: p.pm2_env?.instances,
  }));
  return { available: true, procs };
}

// 磁盘多分区
export async function disks() {
  const out = await run("df", ["-B1", "-P", "-x", "tmpfs", "-x", "devtmpfs", "-x", "overlay", "-x", "squashfs", "-x", "efivarfs", "-x", "ramfs"]);
  if (!out) return [];
  const lines = out.split("\n").slice(1);
  const hostMode = HOST_ROOT !== "/";
  const list = [];
  for (const line of lines) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6) continue;
    let mount = f.slice(5).join(" ");
    if (hostMode) {
      // 容器内: 只取挂在 HOST_ROOT 下的宿主分区, 去掉前缀显示
      if (mount !== HOST_ROOT && !mount.startsWith(HOST_ROOT + "/")) continue;
      mount = mount.slice(HOST_ROOT.length) || "/";
    }
    if (/^\/(dev|run|sys|proc)(\/|$)/.test(mount)) continue;
    const total = Number(f[1]), used = Number(f[2]), free = Number(f[3]);
    if (!total) continue;
    list.push({ fs: f[0], mount, total, used, free, pct: +(used / total * 100).toFixed(1) });
  }
  list.sort((a, b) => b.total - a.total);
  return list;
}
