# 联邦网络与旅行验收矩阵

本文件记录当前 Direct HTTPS 实现的验证范围。产品设计以 `FEDERATION-DESIGN.zh-CN.md` v1.7 的第 21、22、27、29、30、31 节为依据。

## 当前实现和验证

| 要求 | 实现 | 验证证据 |
| --- | --- | --- |
| 未审批申请不成为可信节点 | 持久 `pairRequests`；接收管理员在本地独立输入 PSK 后验证；双向确认才持久化 `federationPeers` | `transport.test.ts` 的实际 HTTP handler 配对链、错误 PSK 测试 |
| 配对秘密不明文上线 | 32 字节随机 Base64 PSK；TLS；挑战证明、临时 ECDH 与 transcript 摘要绑定的 HKDF；每对节点单独凭证 | HTTP handler 测试检查所有出站请求不含 PSK，两端独立派生凭证一致且与 PSK 不同 |
| 双向探针与访客业务独立 | `/probe` 接收严格控制报文；没有 visit、角色、租约、动作或模型请求 | 空镇双向探针与伪造动作载荷拒绝测试 |
| 单向成功不能 Ready | 各端保存独立 inbound/outbound 验证时间；两向在 120 秒窗口内有效才 Ready | 单向失败、双向成功、在途修改端点测试 |
| HTTPS 错误不降级 | 默认补 HTTPS；仅接受 HTTPS；禁止跟随重定向；标准 TLS 验证 | 真实本地 TLS socket 双向探针；不可信证书拒绝；HTTP 地址拒绝 |
| 地址变化不改变身份 | 更新本镇地址与对端地址分别要求管理员认证；清空就绪结果并重新探测 | 本镇端点更新事务测试检查 townId、公私钥和部署代数保持一致 |
| 四类代数独立校验 | sender/recipient deployment 与角色 authority/lease version 分开存储、核验 | 四字段各自替换为旧/错误值均被拒绝的测试 |
| 投递失败能重试且不重复副作用 | 本地状态与 Outbox 同事务；Inbox 持久按 messageId/digest 去重；认证 ACK 与提交状态绑定 | HTTP 200 伪 ACK 拒绝、丢 ACK 重试、重复预约/确认测试 |
| 每方向、每流独立排序 | 持久 `messageStreamCursors`，最少 observations/actions/results/lease-control | 反向消息及独立流均可使用序号 1 的测试 |
| 有界乱序与 NACK 补发 | 窗口 16、缺口 30 秒；持久 Outbox 重放；连续 Inbox 顺序提交 | 缺号缓存/NACK/drain、已确认 Outbox 补发、超时测试 |
| 不可补发不能越过未知副作用 | 认证会话快照；暂停流并结束旧 visit；验证 Host 清理或等租约安全期限后返乡；旧流终止，新旅行使用新 visitId | 缺持久历史与清理后重试快照测试；游标只在旧执行会话结束后重置 |
| 预约名额原子且含在场实体 | 预约与 visitLedger 同事务；有效预约及创建/在场/清理中实体占容量 | 并发预约竞争、过期但尚未清理仍占槽测试 |
| 一名居民只有一份出访授权 | Home 在发送预约前原子占用 runtime，递增 authority；冻结后才确认 Host 创建 | 完整 reserve/freeze/confirm/active/clean/return Saga 测试 |
| 撤销与网络分区可安全退出 | 暂停/撤销后仍允许已认证清理控制；Home 等清理确认或最后签发租约加 60 秒余量 | revoked 清理、租约余量等待、满 Outbox 不能回滚本地退出测试 |
| 续租不会缩短安全返乡等待 | Home 在发送续租前先持久化最大可能授予的 expiry/version；Host 更新执行版本 | 续租持久化与旧 lease version 拒绝测试 |
| 冻结/取消竞态不丢居民 | 延迟任务检查账本当前状态；引擎输入按号执行；原 Player 快照与 ID 恢复；旧任务不改新旅行 | `runtime.test.ts` 的迟到冻结、已排冻结后取消、旧 resume、新旧 Host callback 测试 |
| 到期 Host 不再行动 | Player.tick 在物理更新前依据墙钟删除到期访客；队列行为执行入口再次检查租约 | 真实引擎事务测试：到期删除、迟到 action `LEASE_EXPIRED`、之后清理确认 |
| 撤信或满 Outbox 不阻塞已执行世界事务 | 回执 fact 与副作用同事务写入 pending action；50 条有界 receipt 队列独立补发，旧权限不补发 | 成功/拒绝结果各在撤信、满队列下提交并随后精确一次补发；新 lease 拒绝旧回执再授权的事务测试 |
| 保存期间权限变化不会重复阻塞世界 | saveWorld 事务检查持久账本、权限与租约；回滚后 loadInputs 只对失效远程行为返回 deadline=0 副本，让拒绝结果与后续输入正常提交，保留原输入审计 | 续租/返乡/authority 三类 saveWorld 实际回滚、重新加载、拒绝旧输入并前进 engine cursor 的事务测试 |
| 原本镇 AI 仍能完成活动与记忆 | 公开输入拒绝系统指令；工作线程通过专用内部入口提交完成输入 | 内部 activity/wander/remember 完成事务回归 |

上述测试使用 Jest 与 convex-test，网络测试包含两个实际 TLS socket 和临时测试 CA。测试中的 DNS 映射/CA 只属于测试客户端；产品使用平台标准 TLS fetch，不设置忽略证书验证。事务测试调用真实引擎输入处理及 `Game.saveDiff`，没有使用内存状态机替代账本。

命令：

```sh
npm test -- --runInBand convex/federation/transport.test.ts convex/federation/runtime.test.ts
npx tsc --noEmit
```

整体联调已在两个独立 Linux Convex 部署完成隔离 CA 的真实 HTTPS 配对、双向 Ready、旅行 Active、Home 思考、Host 发言、Home 记忆保存、自动清理与同一 Player ID 安全返乡。另已通过本机 Qwen 的真实模型探测和 1024 维 Embedding 配置验证与激活。claw 模型返回不支持该模型的 400，仍待确认可用模型。上述为整体联调记录；不等同于生产部署或实际公网可达性验收。

## 明文 HTTP 保持关闭

当前配置固定为 `allowUnencryptedHttp=false`、`allowPublicHttp=false`、`httpPayloadProtectionMode=DISABLED`，原因码为 `HTTP_AUTH_LIBRARY_UNAVAILABLE`。当前 ECDH/PSK 应用认证建立在标准 TLS 保护之上，并未实现经过互操作与主动攻击测试的明文传输认证握手库；不能移除 TLS 后把这份应用认证称为安全的 Noise/PAKE 替代品。

v1.7 第 21.5 与 31.4 节明确允许这一交付边界：安全库条件不满足时保留 HTTPS 必选路径并关闭 HTTP。当前没有可启用的 `HTTP-SIGNED-PLAINTEXT` 或 `HTTP-AEAD` 模式。未来引入 HTTP 时须使用成熟认证握手实现，独立验证双方授权、消息完整性、防重放和互操作；`HTTP-SIGNED-PLAINTEXT` 的正文仍无机密性，界面必须持续明确显示这一事实。

## 安全与可达性边界

Ready 只证明时间窗口内经过认证的双向 Direct 路由，不证明任意 NAT 拓扑自动可通，也不验证 LLM 可用性。当前没有 WSS、Relay、NAT 打洞、VPN 配置或自动路径选择。管理员需自行提供双向可达的 HTTPS 端点、匹配证书与网络路由。

安全返乡依赖可信节点遵守到期拒绝、持久授权账本、标准证书认证与有限时钟偏差假设。复制私钥的恶意双活节点或无限制时钟漂移不能由本地租约算法无条件排除；没有新增外部仲裁服务或区块链共识。
