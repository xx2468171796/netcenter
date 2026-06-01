// 指标采集: 全部从 /proc /sys + fs.statfs 读取, 无外部依赖。
// 速率类指标(CPU/磁盘IO/网速)需要两次采样做差, 故维护上一次的原始计数。
import { readFileSync, statfsSync } from "node:fs";

// 容器内监控宿主机时, 把 /proc /根 重定向到挂载点 (HOST_PROC=/host/proc, HOST_ROOT=/host)
const HOST_PROC = process.env.HOST_PROC || "/proc";
const HOST_ROOT = process.env.HOST_ROOT || "/";

function readProc(path) {
  const real = path.startsWith("/proc") ? HOST_PROC + path.slice(5) : path;
  try {
    return readFileSync(real, "utf8");
  } catch {
    return "";
  }
}

// 主网卡判定: 物理网卡(eno/eth/ens/enp), 排除 lo/docker/veth/br/虚拟
function isPhysicalIface(name) {
  if (name === "lo") return false;
  if (/^(docker|veth|br-|virbr|tun|tap|wg|kube)/.test(name)) return false;
  return /^(en|eth|wl|bond)/.test(name);
}

// 主磁盘判定: sda / nvme0n1 / vda (整盘, 不要分区/loop/dm/ram)
function isPhysicalDisk(name) {
  return /^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|xvd[a-z]+)$/.test(name) &&
    !/\d+$/.test(name.replace(/^nvme\d+n\d+/, "nvme")); // sda1 排除, nvme0n1 保留
}

function parseNetDev() {
  const out = {};
  const text = readProc("/proc/net/dev");
  for (const line of text.split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const name = line.slice(0, idx).trim();
    const f = line.slice(idx + 1).trim().split(/\s+/).map(Number);
    // f[0]=rx_bytes f[1]=rx_pkts ... f[8]=tx_bytes f[9]=tx_pkts
    out[name] = { rx: f[0] || 0, tx: f[8] || 0, rxPkts: f[1] || 0, txPkts: f[9] || 0 };
  }
  return out;
}

function parseCpu() {
  const text = readProc("/proc/stat");
  const result = { total: {}, cores: [] };
  for (const line of text.split("\n")) {
    if (!line.startsWith("cpu")) continue;
    const parts = line.trim().split(/\s+/);
    const label = parts[0];
    const nums = parts.slice(1).map(Number);
    const idle = (nums[3] || 0) + (nums[4] || 0); // idle + iowait
    const total = nums.reduce((a, b) => a + (b || 0), 0);
    const entry = { idle, total };
    if (label === "cpu") result.total = entry;
    else result.cores.push(entry);
  }
  return result;
}

function parseMem() {
  const text = readProc("/proc/meminfo");
  const m = {};
  for (const line of text.split("\n")) {
    const mt = line.match(/^(\w+):\s+(\d+)\s*kB/);
    if (mt) m[mt[1]] = Number(mt[2]) * 1024;
  }
  const total = m.MemTotal || 0;
  const available = m.MemAvailable != null ? m.MemAvailable : (m.MemFree || 0) + (m.Buffers || 0) + (m.Cached || 0);
  const used = total - available;
  const swapTotal = m.SwapTotal || 0;
  const swapUsed = swapTotal - (m.SwapFree || 0);
  return { total, used, available, cached: m.Cached || 0, swapTotal, swapUsed };
}

function parseDiskstats() {
  const text = readProc("/proc/diskstats");
  const out = {};
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const name = f[2];
    if (!isPhysicalDisk(name)) continue;
    // f[5]=rd_sectors f[9]=wr_sectors, 1 sector = 512B
    out[name] = { rd: Number(f[5]) * 512, wr: Number(f[9]) * 512 };
  }
  return out;
}

function diskUsage(path = HOST_ROOT) {
  try {
    const s = statfsSync(path);
    const total = Number(s.blocks) * Number(s.bsize);
    const free = Number(s.bavail) * Number(s.bsize);
    return { total, used: total - free, free };
  } catch {
    return { total: 0, used: 0, free: 0 };
  }
}

// ESTABLISHED 连接数 (state 01), tcp + tcp6
function countConnections() {
  let n = 0;
  for (const p of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const text = readProc(p);
    const lines = text.split("\n");
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].trim().split(/\s+/);
      if (cols[3] === "01") n++;
    }
  }
  return n;
}

function uptimeSeconds() {
  const t = readProc("/proc/uptime").split(" ")[0];
  return Math.floor(Number(t) || 0);
}

function loadAvg() {
  const f = readProc("/proc/loadavg").trim().split(/\s+/);
  return [Number(f[0]) || 0, Number(f[1]) || 0, Number(f[2]) || 0];
}

export class MetricsCollector {
  constructor() {
    this.prev = null; // { ts, cpu, cores, net, disk }
  }

  // 采一次原始计数 (含时间)
  _raw() {
    return {
      ts: Date.now(),
      cpu: parseCpu(),
      net: parseNetDev(),
      disk: parseDiskstats(),
    };
  }

  // 首次调用初始化基线, 之后每次返回带速率的快照
  sample() {
    const cur = this._raw();
    const mem = parseMem();
    const du = diskUsage();
    const conns = countConnections();
    const la = loadAvg();

    let cpuPct = 0;
    let cores = [];
    let netTotal = { rx: 0, tx: 0 };
    let perIface = {};
    let diskIO = { rd: 0, wr: 0 };

    if (this.prev) {
      const dt = (cur.ts - this.prev.ts) / 1000 || 1;

      // CPU 总使用率
      const dTotal = cur.cpu.total.total - this.prev.cpu.total.total;
      const dIdle = cur.cpu.total.idle - this.prev.cpu.total.idle;
      cpuPct = dTotal > 0 ? Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100)) : 0;

      // 每核
      cores = cur.cpu.cores.map((c, i) => {
        const p = this.prev.cpu.cores[i];
        if (!p) return 0;
        const dt2 = c.total - p.total;
        const di2 = c.idle - p.idle;
        return dt2 > 0 ? Math.max(0, Math.min(100, (1 - di2 / dt2) * 100)) : 0;
      });

      // 网卡速率 (bytes/s)
      for (const [name, v] of Object.entries(cur.net)) {
        const p = this.prev.net[name];
        if (!p) continue;
        const rx = Math.max(0, (v.rx - p.rx) / dt);
        const tx = Math.max(0, (v.tx - p.tx) / dt);
        perIface[name] = {
          rx, tx,
          rxTotal: v.rx, txTotal: v.tx,
          physical: isPhysicalIface(name),
        };
        if (isPhysicalIface(name)) {
          netTotal.rx += rx;
          netTotal.tx += tx;
        }
      }

      // 磁盘 IO (bytes/s) 累加所有物理盘
      for (const [name, v] of Object.entries(cur.disk)) {
        const p = this.prev.disk[name];
        if (!p) continue;
        diskIO.rd += Math.max(0, (v.rd - p.rd) / dt);
        diskIO.wr += Math.max(0, (v.wr - p.wr) / dt);
      }
    } else {
      // 首次: 仍给出当前网卡列表(速率为0)
      for (const [name, v] of Object.entries(cur.net)) {
        perIface[name] = { rx: 0, tx: 0, rxTotal: v.rx, txTotal: v.tx, physical: isPhysicalIface(name) };
      }
      cores = cur.cpu.cores.map(() => 0);
    }

    this.prev = cur;

    return {
      ts: cur.ts,
      cpu: Number(cpuPct.toFixed(1)),
      cores: cores.map((c) => Number(c.toFixed(1))),
      coreCount: cur.cpu.cores.length,
      load: la,
      mem,
      disk: du,
      diskIO: { rd: Math.round(diskIO.rd), wr: Math.round(diskIO.wr) },
      net: { rx: Math.round(netTotal.rx), tx: Math.round(netTotal.tx) },
      perIface,
      conns,
      uptime: uptimeSeconds(),
    };
  }
}
