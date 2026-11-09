# PNDS 池谱中继（Telematic Hub）

token 鉴权的 Socket.IO 中继，用于 PNDS 跨互联网演奏。部署在一台公网 VPS
上，任意数量的 PNDS 站点（每台 Mac 运行 [PNDS App](https://github.com/xO-xN/PNDS-App)
加一个支持互联网演奏的工程）即可跨网络交换消息。

hub 做鉴权、分房、回声、盖戳转发，不聚合指标、不持久保存演出消息。为诊断地图
增加的状态只有容量受限的内存 IP 位置缓存；普通消息仍使用原有的透明转发协议。

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

### 网络位置

hub 向每条已鉴权连接提供它观察到的公网 IP 和可选的估计位置。查询只在 Node 侧
使用内建 `fetch` 向固定 HTTPS 端点 `https://api.ipapi.is/` 发送 JSON POST，
不阻塞 welcome、echo 或 relay。定位服务会收到被查询的公网 IP；Token、房间、
节点名和手动校正坐标不会提交。可选的定位服务 key 不会发给浏览器。

在 `/opt/pnds-hub/hub.env` 中设置以下变量，**只在演出间隙重启**。安装脚本不会
覆盖现有环境文件。

| 变量 | 缺省与含义 |
|---|---|
| `HUB_GEO_API_KEY` | 可选的 ipapi.is key，仅保留在 hub |
| `HUB_TRUST_PROXY` | 缺省为空；可信反向代理的**精确 IP**，逗号分隔，不接受 CIDR 或主机名 |
| `HUB_LOCATION_LABEL` | 可选的 hub 实际部署地点名称 |
| `HUB_LOCATION_LATITUDE` | 部署纬度，−90…90，须同时提供经度 |
| `HUB_LOCATION_LONGITUDE` | 部署经度，−180…180，须同时提供纬度 |

本机 Caddy 通过 `127.0.0.1` 连接时，显式设 `HUB_TRUST_PROXY=127.0.0.1`；实际使用
`::1` 才把它加入。后端端口保持私有。代理必须将真实连接来源追加到
`X-Forwarded-For`；只有 TCP 来源精确位于该名单时，hub 才使用头部最后一项。
其他来源的头部和握手 IP 字段一律忽略。私网、回环和保留地址不会提交定位服务。
未配置可信代理时，节点位置显示未知，不会把所有节点误放到代理所在地。

成功结果缓存 24 小时，失败退避五分钟；LRU 缓存最多 512 个地址。相同 IP 查询
合并，最多两个查询并发、64 个地址等待，每次两秒超时。每个 UTC 自然日，匿名最多
提交 30 次、有 key 最多 1,000 次；收到 `403` 或 `429` 后停止新请求，直到下一个
UTC 自然日。缓存与计数只在内存中，重启不会重置服务商的实际额度；共享 NAT 也
可能共用服务商额度。依据见[匿名额度说明](https://ipapi.is/free-tier.html)及
[API 文档](https://ipapi.is/developers.html)。

IP 坐标估计的是公网出口，不保证区县或演出场地精度。节点可以通过下述 `location`
事件校正自己的位置。hub 仅为当前连接保留校正；工具若在本机记住校正，重连后须
再次发送。清除校正恢复已缓存的 IP 估计。定位失败不影响网络诊断，只将位置标为
未知；仍可使用拓扑图和节点列表。

hub 自身位置**只取部署坐标配置**。坐标缺失或无效时 `hubLocation` 为 `null`，
不会按域名或 IP 推断城市，也不会沿用原型中的南京示例。

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
# → PNDS telematic hub v0.2.0
```

## 协议速查

服务端排障参考；面向工程作者的接入文档在 PNDS App 文档体系中。

| 条目 | 内容 |
|---|---|
| 传输 | Socket.IO v4（WebSocket） |
| 握手 `auth` | `{ token, room?, node? }`——token 绝不进 URL |
| 鉴权失败 | `connect_error`，message 为 `"invalid hub token"` |
| `welcome`（服务端 → 客户端） | 入房时发 `{ room, node, hubTime, network }`；原有三个字段不变 |
| `network`（服务端 → 客户端） | 自动定位完成或手动校正后的新元数据 |
| `location`（客户端 → 服务端） | `{ label?, latitude, longitude }` 校正当前连接位置；`null` 恢复自动定位；可选 ack 为 `{ ok: boolean }` |
| `echo`（客户端 → 服务端） | 任意 JSON → 盖戳后**只发回发送者**（测 RTT） |
| `relay`（客户端 → 服务端） | 任意 JSON → 盖戳后发给**同房间其他所有客户端** |
| 盖戳 | `from` = 经鉴权的发送者名，`hubReceivedAt` = hub 接收时刻——两个键都由 hub 强制覆盖（发送者自带的值无法存活） |
| 命名 | room：trim 后 ≤ 128 字符，回退 `default`；node：trim 后 ≤ 64 字符，回退 `socket.id` |
| 载荷包裹 | 数组/原始值以 `{ value: <payload> }` 形式传输 |
| 投递语义 | 单条连接内有序可靠；重连间隙的消息按设计丢弃（沉默即断线信号） |

`network` 为 `{ ip, location, hubLocation, manualLocationSupported: true }`。
`ip` 是观察到的公网 IP，未知为 `null`；两个位置字段各自为 `null` 或
`{ label, latitude, longitude, source }`。`source` 分别为 `ip`、`manual` 或
`configured`；IP 估计另带 `provider: "ipapi.is"`。坐标必须是有限数值，零有效。
hub 拒绝非法校正，并覆盖客户端自带的 source/provider。

对 `type: "tnd-stats"` 的诊断消息，hub 在同房间转发前额外强制覆盖 `network`，
使用当前发送连接的元数据，发送者不能借此冒充别人的公网 IP。手动校正仍是操作者
提供的信息，不是 hub 验证过的真实机位。其他消息类型继续透明转发，包括自定义的
`network` 字段；echo 行为不变。

## 开发检查

```bash
npm ci
npm run check
npm test
```

测试注入定位服务响应，并使用本机回环 Socket.IO fixture；不查询真实参与者 IP、
不读取部署的 `hub.env`，也不部署或重启服务。`socket.io-client` 仅作为测试开发依赖，
运行中的 hub 不增加依赖。

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
