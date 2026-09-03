# PNDS 池谱中继（Telematic Hub）

单文件、token 鉴权的 Socket.IO 中继，用于 PNDS 跨互联网演奏。部署在一台公网 VPS
上，任意数量的 PNDS 站点（每台 Mac 运行 [PNDS App](https://github.com/xO-xN/PNDS-App)
加一个支持互联网演奏的工程）即可跨网络交换消息。

hub 刻意保持「哑」：只做鉴权、分房、回声、盖戳转发。它从不解读消息内容、不聚合
指标、不保存状态——这让它在运维上便宜、省心，任何实现了下述瘦协议的客户端都能
使用。

**它不承载音频。** 站点间实时音频由外部方案（如 JackTrip）承担；hub 只承载
控制/数据消息。

**开箱即用的基础测试。** PNDS App 内置了
[Telematic Network Diagnostics](https://github.com/xO-xN/Telematic-Network-Diagnostics)
工程：各站点的 Mac 在 App 里打开它（⌘O）、连上本 hub，每台 monitor 就会显示同一份
网络视图——逐站点的 RTT、抖动、丢包，以及演出前的 go/no-go 判定。因此第一次跨
互联网检查不需要任何自研工程；实现了下述协议的工程复用同一个 hub。

## 架构

```
站点 A（Mac，PNDS App + 工程）──────┐
站点 B（Mac，PNDS App + 工程）──────┼──►  pnds-hub（公网 VPS）
站点 C（Mac，PNDS App + 工程）──────┘
        站点仅出站连接，Socket.IO over wss://，token 鉴权
```

- 所有连接都是站点**出站**发起——无需端口转发，双方都在 NAT 后也能工作。
- 同一**房间**的客户端互相可见 relay 消息；房间之间完全隔离。一场演出 = 一个房间。
- 演奏者手机不接触 hub——照常通过局域网连自己站点的本地 server。

## 环境要求

- 一台带 systemd 的 Linux VPS（最低配即可——见[运维](#运维)）。
- Node.js ≥ 18、npm、git（用系统包管理器装 Node，systemd 才能找到它）。
- 生产环境：一个指向 VPS 的域名，由反向代理终结 TLS。

## 安装

```bash
sudo git clone https://github.com/xO-xN/pnds-hub /opt/pnds-hub
cd /opt/pnds-hub
sudo ./install.sh
```

`install.sh` 会：

1. 安装依赖（`npm ci`）；
2. 生成 `HUB_TOKEN` 写入 `/opt/pnds-hub/hub.env`（`chmod 600`；已存在的文件不会被
   覆盖，重装保留原 token）；
3. 安装并启动 `pnds-hub` systemd 服务。

token 首次生成时会打印在终端上——记下来，每个站点都要用。hub 默认监听
`127.0.0.1:4000`（仅回环）：生产上应通过 TLS 反向代理访问（见下一节）。

### 无代理的明文快速测试

还没有反向代理时，编辑 `/opt/pnds-hub/hub.env`：

```
HUB_HOST=0.0.0.0
```

然后 `sudo systemctl restart pnds-hub`，在防火墙开放端口，站点用
`ws://<vps-ip>:4000` 连接。这是公网明文传输——试用可以，演出不行。

### TLS（生产）

用 Caddy 的话，WebSocket 代理和证书都是自动的：

```text
hub.example.com {
    reverse_proxy 127.0.0.1:4000
}
```

（Nginx 也行——记得加 WebSocket 的 `Upgrade`/`Connection` 头。）防火墙开 443、
关 4000。站点用 `wss://hub.example.com` 连接。

## 站点接入

每个站点需要四个值：

| 值 | 含义 |
|---|---|
| URL | `wss://hub.example.com`（快速测试用 `ws://<ip>:4000`） |
| token | hub 的 `HUB_TOKEN`——所有站点共用 |
| room | 一场演出一个房间；不同房间的站点互不可见 |
| node | 本站点的显示名，如 `site-berlin` |

运行 [Telematic Network Diagnostics](https://github.com/xO-xN/Telematic-Network-Diagnostics)
工程的站点，通过 monitor 页的连接表单填写（或使用 PNDS App 注入的 `PNDS_HUB_*`
环境变量）。面向工程作者的接入文档由 PNDS App 的文档体系承载。

## 更新

```bash
sudo /opt/pnds-hub/update.sh            # 更新到最新 release tag
sudo /opt/pnds-hub/update.sh v0.2.0     # 更新到指定 tag
```

`update.sh` 会拉取代码、切到目标 tag、重装依赖、同步 systemd unit 并重启服务。
**只在演出间隙执行**——重启会断开所有已连接站点；客户端会自动重连，但重连突发
在遥测里会被判为故障（见[运维](#运维)）。

随时确认运行版本：

```bash
curl http://127.0.0.1:4000/
# → PNDS telematic hub v0.1.0
```

## 协议速查

服务端排障参考；面向工程作者的接入文档在 PNDS App 文档体系中。

| 条目 | 内容 |
|---|---|
| 传输 | Socket.IO v4（WebSocket） |
| 握手 `auth` | `{ token, room?, node? }`——token 绝不进 URL |
| 鉴权失败 | `connect_error`，message 为 `"invalid hub token"` |
| `welcome`（服务端 → 客户端） | 入房时发 `{ room, node, hubTime }` |
| `echo`（客户端 → 服务端） | 任意 JSON → 盖戳后**只发回发送者**（测 RTT） |
| `relay`（客户端 → 服务端） | 任意 JSON → 盖戳后发给**同房间其他所有客户端** |
| 盖戳 | `from` = 经鉴权的发送者名，`hubReceivedAt` = hub 接收时刻——两个键都由 hub 强制覆盖（发送者自带的值无法存活） |
| 命名 | room：trim 后 ≤ 128 字符，回退 `default`；node：trim 后 ≤ 64 字符，回退 `socket.id` |
| 载荷包裹 | 数组/原始值以 `{ value: <payload> }` 形式传输 |
| 投递语义 | 单条连接内有序可靠；重连间隙的消息按设计丢弃（沉默即断线信号） |

## 运维

**容量。** 只有各站点的 score server 连接 hub——演奏者不直接接触 hub。一个遥测
客户端以约 15.5 条/秒的节奏探测（2 秒 30 条/秒 burst ↔ 2 秒 1 Hz 平静交替），每秒
relay 一条小快照。十个站点 ≈ 每秒 300 个事件、几十 KB 带宽——无论房间怎么分，都
比最便宜的 VPS 的处理能力低几个数量级。

**注意事项：**

- **单点故障。** 一个进程服务所有房间；systemd 兜住进程崩溃，兜不住 VPS/机房网络
  中断。重要演出宁可加第二台机器跑第二个 hub，不要换更大的机器。
- **不要在演出中重启。** 重连突发会让遥测工程的 go/no-go 横幅翻红（15 秒内 ≥ 2 次
  重连）。部署与更新只在演出之间做。
- **所有人共用一个 token。** 所有房间共享 `HUB_TOKEN`；token 泄漏即暴露 hub 上的
  所有演出。圈子变大时轮换它（改 `hub.env` 后重启）。
- **机房位置决定数字底数。** VPS 的地理位置决定了各站点测向 hub 的 RTT/抖动基线；
  跨洲部署选一个对各方都折中的位置。
- **端到端延迟是两条腿之和。** 存储转发的处理开销在毫秒以下，但一条消息跨站点要走
  站点 → hub → 站点（跨洲约 100–300 ms+）。这是否适合一个作品，由作曲者判断。

## 排障

| 症状 | 可能原因 / 处理 |
|---|---|
| 站点报 `connect_error: invalid hub token` | 站点与 hub 的 `HUB_TOKEN` 不一致（注意 `hub.env` 里行尾的空白/换行） |
| 站点都连上了但互相看不见 | 两边 `room` 名不同 |
| 通过代理连不上 | 代理没有转发 WebSocket 升级；确认站点对公网地址用的是 `wss://` |
| 维护后出现红色「重连」横幅 | hub 在会话中途被重启过——预期行为；等 15 秒窗口过去 |
| `curl http://127.0.0.1:4000/` 显示版本文本 | hub 活着——那就是健康检查 |
| `update.sh` 报 git origin 错误 | 活动目录是 zip 解压而非 git clone——重新 clone |

## 许可证

[MIT](LICENSE)
