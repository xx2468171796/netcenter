# CLAUDE.md — netcenter 开发接棒文档

> 给后续接手的 AI / 开发者:读完这份就能顺利继续开发。这是一个**轻量服务器监控面板**(中文 / ECharts 6 / vnStat 流量统计),Node.js 单服务,零原生依赖。原作者 **alone**,交流 https://t.me/+RZMe7fnvvUg1OWJl。

## 一、这是什么

实时监控一台 Linux 主机的 CPU / 内存 / 磁盘 / 网络,加上基于 vnStat 的进出流量统计(按时间段)。前端单页 + ECharts,后端 Fastify,自带用户名密码登录。可原生 systemd 部署,也可 Docker 一键监控任意宿主机。

## 二、目录结构

```
server-monitor/
├── server.js              主入口: Fastify, 路由, 采样循环, 鉴权, 缓存
├── lib/
│   ├── metrics.js         读 /proc /sys 出 CPU/内存/磁盘/网络 (MetricsCollector 类, 维护上次计数算速率)
│   ├── db.js              node:sqlite 采样存储 (Store 类: insert/history/prune/vacuum/stats)
│   ├── vnstat.js          调 `vnstat --json` 解析进出流量
│   ├── system.js          ps(进程TOP) / docker stats / pm2 jlist / df(多分区)
│   └── config.js          config.json 加载 + 环境变量覆盖 + 改密码持久化
├── public/
│   ├── index.html         主面板结构 (各 section.panel)
│   ├── login.html         登录页
│   └── static/
│       ├── app.js         前端全部逻辑 (轮询/ECharts/折叠/主题/弹窗)
│       ├── style.css      样式 (CSS 变量主题, 浅/深色)
│       └── echarts.min.js ECharts 6 本地内置 (不依赖 CDN)
├── Dockerfile             node:22-slim + vnstat + procps + docker 客户端
├── docker-compose.yml     一键启动 (pid/network host + 宿主挂载)
├── entrypoint.sh          容器启动: 拉起 vnstatd + node
├── deploy/server-monitor.service  systemd 单元模板 (__INSTALL_DIR__ 占位)
├── .github/workflows/docker.yml   push main 自动构建推 ghcr 公开镜像
├── config.example.json    配置样例
├── README.md              面向用户的使用文档
└── docs/promo.md          博客推广文
```

## 三、运行机制(关键)

- **采样循环**(server.js):`setInterval` **每 1 秒**调 `collector.sample()` 更新内存里的 `lastSample`(供 `/api/realtime`);每 `sampleIntervalSec` 秒(默认 3)才 `store.insert()` 落一次库(节流省空间)。**实时值=1秒,落库=3秒,别混淆。**
- **速率计算**:`metrics.js` 的 `MetricsCollector` 维护上一次的 `/proc` 原始计数,两次采样做差除以时间得 CPU%/网速/磁盘IO。首次采样速率为 0(基线)。
- **前端轮询**:`/api/realtime` 默认每 3 秒(可在界面切 1/3/5/10s);`/api/network` 5s;`/api/processes` 5s;`/api/services` 6s;`/api/disks` 30s;`/api/traffic` 60s;`/api/storage` 60s。
- **缓存**:系统命令(docker/pm2/df)结果在后端 `cached()` 缓存 3~20s;vnStat 概览缓存 30s。避免高频 spawn。
- **历史**:`/api/history` 从 SQLite 按时间桶降采样(最多 600 点)。采样库每小时 `prune()`(留 `retentionDays` 天,默认 35,`0`=不清理)、每天 `vacuum()` 回收。

## 四、坑 / 非显而易见的设计(务必看)

1. **vnStat 必须取完整 `vnstat --json`,不能只取 `--json d`**。只取 `d`(天)拿不到 `month` 数组 → 本月流量恒为 0(曾经的 bug,已修)。见 `vnstat.js` 的 `vnstatJson(iface, mode)`:不传 mode = 完整(含 day+month+total)。
2. **vnStat 从安装那刻起统计,没有历史回溯**。装之前的流量不存在,所以刚部署时"本月"≈"今日",跑满才完整。这是 vnStat 特性不是 bug。
3. **vnStat 落库间隔 SaveInterval=1 分钟**(我们调过,默认是 5)。生产改 `/etc/vnstat.conf`;镜像在 Dockerfile 里 sed 写死 1 分钟。所以流量数字最多 1 分钟变一次。
4. **进程 TOP 的 CPU% 是 `ps` 的"生命周期平均",不是瞬时值**(ps 特性)。内存(RSS)是准的当前值。若要瞬时 CPU 需改成两次采样 `/proc/[pid]/stat` 求差。
5. **node:sqlite 是实验特性**,启动加 `--disable-warning=ExperimentalWarning` 压告警。选它就是为了**零原生编译依赖**,node_modules 跨机可移植(部署直接 rsync,不用在目标机 npm install)。
6. **容器内监控宿主机**:靠 `HOST_PROC`/`HOST_ROOT` 环境变量把 `/proc`、根文件系统重定向到挂载点(`metrics.js`/`system.js` 读这两个变量)。配合 `--pid host --network host`。`ps` 命令本身靠 `--pid host` 看宿主进程(不走 HOST_PROC)。
7. **磁盘分区**(system.js `disks()`):容器内 `HOST_ROOT=/host` 时,过滤 `df` 里挂在 `/host` 下的项并去前缀显示。
8. **PM2 监控容器内不可用**(PM2 是宿主用户态守护),原生部署才有。`pm2 jlist` 失败时优雅降级"PM2 不可用"。
9. **SQLite WAL 文件**会涨到几 MB 再 checkpoint,属正常;`/api/cleanup` 的 `vacuum()` 用 `PRAGMA wal_checkpoint(TRUNCATE); VACUUM;` 真回收。
10. **登录**:`config.js` 单管理员账号密码(明文存 config.json,文件 600);会话是 `@fastify/cookie` 签名 cookie(`signCookie`/`unsignCookie`),value=`username|expiry`。改密码走 `/api/change-password`(验原密码→写回 config.json)。
11. **端口默认 8055**(避开常见 8080)。`SM_HOST` 默认 127.0.0.1(配反代);Docker 默认 0.0.0.0。

## 五、API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/info` | 主机名/核数/网卡列表/vnstat 可用性 |
| GET | `/api/realtime` | 当前快照(cpu/mem/disk/net/conns + 流量概览) |
| GET | `/api/history?range=live\|1h\|6h\|24h\|7d` | SQLite 系统曲线历史 |
| GET | `/api/network?range=boot\|1d\|7d\|30d\|month` | 各网卡明细(boot=自开机累计,其他=vnStat 区间) |
| GET | `/api/processes` | 进程 TOP(byCpu/byMem) |
| GET | `/api/services` | docker 容器 + pm2 进程 |
| GET | `/api/disks` | 磁盘多分区 |
| GET | `/api/traffic?iface=&range=\|start=&end=` | vnStat 进出流量(时间段) |
| GET | `/api/storage` | DB 大小/采样数/保留天数/initialized/进程内存 |
| POST | `/api/cleanup` | prune + VACUUM 回收 |
| POST | `/api/settings` | 改 retentionDays(0/35/60/90/365)+ initialized |
| POST | `/api/change-password` | 改密码 |
| POST | `/login` `/logout` | 登录/登出(form) |

所有 `/api/*` 和 `/` 走 `preHandler` 鉴权;放行 `/login` `/healthz` `/static/*`。

## 六、配置(config.json / 环境变量)

见 `config.example.json` 与 README。环境变量 `SM_PORT/SM_HOST/SM_USER/SM_PASS/SM_IFACE/SM_COOKIE_SECRET` 覆盖,Docker 用。`sampleIntervalSec`(默认3)、`retentionDays`(默认35,0=不清理)、`initialized`(首次向导标记)只走 config.json。

## 七、开发与部署流程

**改代码 → 上线**:
```bash
# 1. 改代码, 语法自检
node --check server.js && node --check public/static/app.js
# 2. 提交推送 (push 到 GitHub 会触发 Actions 自动构建并发布镜像)
git add -A && git commit -m "..."
git push <remote> main
# 3. 部署: 整个目录(含 node_modules, 纯 JS 可跨机移植)同步到目标服务器
rsync -az --delete --exclude data/ --exclude config.json --exclude '*.log' \
  ./ <user>@<your-server>:/opt/netcenter/
# 4. 改了后端(server.js/lib/*)需重启服务; 纯前端(public/*)刷新即可
ssh <user>@<your-server> 'systemctl restart server-monitor'
```
- 生产建议:systemd `server-monitor.service`,绑 `127.0.0.1:<端口>`,前面用 nginx 反代到你的域名 + HTTPS(证书自备,泛域名亦可)。也可直接用 Docker 镜像(见 README)。
- 镜像:push 到 GitHub 触发 Actions 构建并发布 `ghcr.io/<owner>/netcenter:latest`(公开)。
- 真实生产环境信息(IP / 域名 / 凭据等)请放私有处,**不要写进本公开仓库**。
- 验证习惯:改完用 curl 打 `/api/*` 看返回,别只信代码。前端改动强刷。

## 八、怎么加一个新指标/面板(扩展指南)

1. 采集:在 `lib/metrics.js`(实时类)或 `lib/system.js`(命令类)加读取函数。
2. 接口:`server.js` 加一个 `app.get("/api/xxx", ...)`,慢的用 `cached()` 包。
3. 前端:`index.html` 加一个 `<section class="panel">`(会自动支持折叠,默认折叠见 app.js `DEFAULT_COLLAPSED`);`app.js` 写 `loadXxx()` + 在 `init()` 里调用 + `setInterval`。
4. 图表用 `mkChart()` + `lineOption()`;颜色走主题变量(`AXIS/GRID/TIPBG` 等,`applyTheme` 切换)。
5. 部署验证(见上)。

## 九、风格约定

- 全中文界面,**不用 emoji**(用文字/几何符号)。
- 网速主显 MB/s(tooltip 带 Mbps);流量总量用 `fmtBytes`(1024 进制);卡片用紧凑 `fmtB`。
- 百分比图(CPU/内存)固定 0-100% 轴。
- 进/出 用"进""出"文字,不用箭头。
- 改动尽量小而清晰,保持现有结构。
