# netcenter — 轻量自建服务器监控面板

实时 CPU / 内存 / 磁盘 / 网络监控 + 基于 vnStat 的进出流量统计,中文界面,ECharts 6 图表,单用户登录,Node.js 单服务,零原生依赖(用内置 `node:sqlite`)。一条 Docker 命令即可在任意 Linux 服务器一键启动。

> 制作:**alone**　交流 / 反馈:[Telegram 群](https://t.me/+RZMe7fnvvUg1OWJl)

---

## 功能一览

| 模块 | 说明 |
|---|---|
| 概览卡片 | CPU、内存、磁盘、网络上下行、连接数、今日/本月流量,一屏总览 |
| 实时监控 | CPU / 内存 / 网络速率 / 磁盘 IO 四张实时曲线(ECharts 6)。时间档:实时 / 1h / 6h / 24h / 7天。刷新频率 1s / 3s / 5s / 10s 可切 |
| 流量统计 | 基于 vnStat 的进/出流量,时间档:1天 / 1周 / 15天 / 1月 / 3月 / 当月 / 1年 + 自定义起止。区间合计 + 柱状图 |
| 进程 TOP | 按 CPU / 内存排序的进程榜 |
| Docker / PM2 | 容器(存活+CPU+内存)和 PM2 进程状态 |
| 磁盘分区 | 各挂载点用量条(超 75% 黄、超 90% 红) |
| 网络明细 | 各网卡当前速率、累计收发、连接数 |
| 存储与清理 | 数据库大小 / 采样条数 / 进程内存,保留时长设置,一键清理回收磁盘 |

界面支持**浅色 / 深色**主题切换、面板折叠、手机端自适应。CPU/内存图固定 0-100% 轴;网速主显 MB/s(悬停含 Mbps)。

---

## 一、Docker 一键启动(推荐)

公开镜像:`ghcr.io/xx2468171796/netcenter:latest`(GitHub Actions 自动构建)。

**目标机器只需装好 Docker**,然后一条命令:

```bash
docker run -d --name netcenter --restart unless-stopped \
  --pid host --network host --cap-add SYS_PTRACE \
  -e HOST_PROC=/host/proc -e HOST_ROOT=/host \
  -e SM_PORT=8055 -e SM_HOST=0.0.0.0 -e SM_USER=admin -e SM_PASS=123456 \
  -v /proc:/host/proc:ro -v /:/host:ro,rslave \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v netcenter-vnstat:/var/lib/vnstat \
  ghcr.io/xx2468171796/netcenter:latest
```

或用 compose(仓库自带 `docker-compose.yml`):`docker compose up -d`。

启动后浏览器打开 **`http://你的服务器IP:8055`**,默认账号 `admin` / `123456`,首次进入会弹**初始化向导**让你选数据保留时长。

> 为什么要这些参数:监控宿主机必须 `--pid host`(看宿主进程)、`--network host`(看宿主网卡)、挂载宿主 `/proc`、`/`、`docker.sock`。容器自带 vnStat 守护采集流量。
>
> 本地构建(不拉公开镜像):把 `docker-compose.yml` 里 `image` 注释、解开 `build: .`,再 `docker compose up -d --build`。

---

## 二、原生部署(systemd,适合监控本机)

```bash
# 1. 装依赖
apt-get install -y vnstat && systemctl enable --now vnstat   # 流量数据源
node -v   # 需 >= 22 (用到内置 node:sqlite)

# 2. 放到 /opt/netcenter, 装依赖
cd /opt/netcenter && npm install --omit=dev

# 3. systemd (把 deploy/server-monitor.service 里 __INSTALL_DIR__ 换成实际路径)
cp deploy/server-monitor.service /etc/systemd/system/
systemctl enable --now server-monitor

# 4. (可选) nginx 反代到子域名 + TLS, 见下方
```

原生模式默认绑 `127.0.0.1:8055`,建议用 nginx 反代到子域名加 HTTPS:

```nginx
server {
    listen 443 ssl;
    server_name mon.example.com;
    ssl_certificate     /path/fullchain.pem;
    ssl_certificate_key /path/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:8055;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## 三、配置

首次启动自动生成 `config.json`(含随机 cookieSecret)。可直接改文件,也可用环境变量覆盖(Docker 友好):

| config.json 字段 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `port` | `SM_PORT` | 8055 | 监听端口 |
| `host` | `SM_HOST` | 127.0.0.1 | 监听地址(对外直连用 `0.0.0.0`) |
| `username` | `SM_USER` | admin | 登录用户名 |
| `password` | `SM_PASS` | admin | 登录密码(登录后可在界面改) |
| `primaryIface` | `SM_IFACE` | 自动 | 主网卡,留空自动选物理网卡 |
| `sampleIntervalSec` | — | 3 | 采样落库间隔(秒);实时值固定每 1 秒刷新 |
| `retentionDays` | — | 35 | 采样保留天数,`0` = 不自动清理 |

改完 `config.json` 后 `systemctl restart server-monitor`(Docker 则重建容器)。

---

## 四、使用说明

- **首次初始化**:第一次打开会弹向导,选数据保留时长(35 / 60 / 90 天 / 1年 / 不自动清理,默认 35)。之后可在「存储与清理」面板随时改。
- **改密码**:右上角「改密码」→ 填原密码 + 新密码(≥4 位)。
- **主题**:右上角「浅色 / 深色」切换,记住选择。
- **折叠**:点面板标题折叠/展开,状态记住。次要面板默认折叠。
- **流量统计**:依赖 vnStat。注意 vnStat 从安装那刻起累计,装之前没有历史,往后每天/每月越来越全。
- **数据占用**:采样库按保留天数自动滚动清理(每小时删过期、每天 VACUUM 回收),体积稳定。选「不自动清理」则数据永久保留(体积会随时间增长,可随时点「立即清理」按当前保留设置手动收)。
- **资源占用**:进程约 70-80MB 内存、CPU 约 1%;代码+依赖约 30MB;采样库通常几 MB 到几十 MB(取决于保留天数与采样间隔)。

---

## 五、技术栈

- 后端:Node.js + Fastify,读 `/proc` `/sys` `fs.statfs` 出实时指标,内置 `node:sqlite` 存采样历史,`vnstat --json` 出流量。
- 前端:单页 + ECharts 6(本地内置,不依赖 CDN)。
- 登录:用户名/密码 + 签名 cookie。
- 容器内监控宿主机:通过 `HOST_PROC` / `HOST_ROOT` 读挂载进来的宿主 `/proc` 与根文件系统。

---

## 安全

默认账号密码请尽快修改。对外暴露时建议绑 `127.0.0.1` 走 nginx 反代加 HTTPS,或确保登录密码足够强。`config.json` 含 cookieSecret,权限 600。

---

制作:**alone**　·　交流反馈:[https://t.me/+RZMe7fnvvUg1OWJl](https://t.me/+RZMe7fnvvUg1OWJl)
