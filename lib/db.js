// 用 Node 内置 node:sqlite (免原生编译, 部署零依赖)。
// 存实时采样, 供系统曲线的历史查询; 流量进出走 vnStat 不存这里。
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

export class Store {
  constructor(dbPath, retentionDays = 7) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.retentionDays = retentionDays;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS samples (
        ts       INTEGER PRIMARY KEY,
        cpu      REAL,
        mem_pct  REAL,
        mem_used INTEGER,
        disk_pct REAL,
        disk_rd  INTEGER,
        disk_wr  INTEGER,
        net_rx   INTEGER,
        net_tx   INTEGER,
        conns    INTEGER,
        load1    REAL
      );
      CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples(ts);
    `);
    this._insert = this.db.prepare(
      `INSERT OR REPLACE INTO samples
       (ts, cpu, mem_pct, mem_used, disk_pct, disk_rd, disk_wr, net_rx, net_tx, conns, load1)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    );
  }

  insert(s) {
    const memPct = s.mem.total ? (s.mem.used / s.mem.total) * 100 : 0;
    const diskPct = s.disk.total ? (s.disk.used / s.disk.total) * 100 : 0;
    this._insert.run(
      Math.floor(s.ts / 1000),
      s.cpu,
      Number(memPct.toFixed(1)),
      s.mem.used,
      Number(diskPct.toFixed(1)),
      s.diskIO.rd,
      s.diskIO.wr,
      s.net.rx,
      s.net.tx,
      s.conns,
      s.load[0]
    );
  }

  // 返回 [fromSec, nowSec] 区间的采样, 按需降采样到约 maxPoints 个点(取每桶平均)
  history(fromSec, toSec, maxPoints = 600) {
    const span = Math.max(1, toSec - fromSec);
    const bucket = Math.max(1, Math.floor(span / maxPoints));
    const rows = this.db
      .prepare(
        `SELECT
           (ts/${bucket})*${bucket} AS t,
           AVG(cpu) cpu, AVG(mem_pct) mem_pct, AVG(mem_used) mem_used,
           AVG(disk_pct) disk_pct, AVG(disk_rd) disk_rd, AVG(disk_wr) disk_wr,
           AVG(net_rx) net_rx, AVG(net_tx) net_tx, AVG(conns) conns, AVG(load1) load1
         FROM samples
         WHERE ts >= ? AND ts <= ?
         GROUP BY t ORDER BY t ASC`
      )
      .all(fromSec, toSec);
    return rows.map((r) => ({
      t: r.t * 1000,
      cpu: round(r.cpu, 1),
      memPct: round(r.mem_pct, 1),
      memUsed: Math.round(r.mem_used || 0),
      diskPct: round(r.disk_pct, 1),
      diskRd: Math.round(r.disk_rd || 0),
      diskWr: Math.round(r.disk_wr || 0),
      netRx: Math.round(r.net_rx || 0),
      netTx: Math.round(r.net_tx || 0),
      conns: Math.round(r.conns || 0),
      load1: round(r.load1, 2),
    }));
  }

  setRetention(days) {
    this.retentionDays = Number(days) || 0;
  }

  prune() {
    if (!this.retentionDays || this.retentionDays <= 0) return; // 0 = 不自动清理
    const cutoff = Math.floor(Date.now() / 1000) - this.retentionDays * 86400;
    this.db.prepare(`DELETE FROM samples WHERE ts < ?`).run(cutoff);
  }

  rowCount() {
    try { return this.db.prepare("SELECT COUNT(*) c FROM samples").get().c; } catch { return 0; }
  }

  sizeBytes() {
    let total = 0;
    for (const suffix of ["", "-wal", "-shm"]) {
      try { total += statSync(this.dbPath + suffix).size; } catch {}
    }
    return total;
  }

  // 回收磁盘: 截断 WAL + VACUUM
  vacuum() {
    try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;"); } catch {}
  }

  stats() {
    return { dbBytes: this.sizeBytes(), rows: this.rowCount(), retentionDays: this.retentionDays };
  }
}

function round(v, d) {
  if (v == null) return 0;
  const p = 10 ** d;
  return Math.round(v * p) / p;
}
