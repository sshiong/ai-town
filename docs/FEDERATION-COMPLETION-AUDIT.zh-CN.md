# AI Town v1.7 完整范围与完成证据审计

## 当前检查点（2026-10-10）

完整目标尚未全部证实。最新冻结版本 41 组、444 项测试通过，前端与 Convex TypeScript 检查及构建通过。实际 A/B 两次重复自然对话的双方记忆与来源、邻居凭证轮换、C 的选择性克隆与部分回滚已通过。三镇同名 Bob 的独立关系、六组原始来源、两条真实语义召回请求到有效发言及全部返乡已核验。实际 A 身份公钥轮换与 B/C 双方确认、三个签名容量接口，以及 Host 观测公平轮转已通过各自范围验收；持久的已验证来源公平 Chat 队列通过 7 项事务测试和真实 A→B 自然交流/安全返乡接入验收；访问排队仍缺。原生日常与旅行原文的私有冷档副本已通过实际写入、签名/摘要校验和精确读取；跨备份冷档恢复、热冷腾挪、完整多节点压力、长期运行等仍需补齐。

下列最初审计保留其原日期、基准和当时判定，用于追溯；后续检查点逐项补充证据，不能把最初的缺项当作当前版本仍缺失，也不能把单个新增测试替代整行要求。

## 最初审计（历史基准）

审计日期：2026-10-09。基准：`58e2cef`（`feat: add resumable archives and encrypted identity recovery`）。本报告完整阅读了 1902 行 `FEDERATION-DESIGN.zh-CN.md`，检查当前实现、测试断言、联调记录与本地截图。它是完成度审计，不是缩减后的实施方案；其他代理后续修改须重新核验下列结论。

**结论：完整目标尚未证实完成。** Direct HTTPS 的持久化旅行与远程决策基础已有较强实现及事务测试证据；全镇分块备份、身份加密恢复、长期记忆保留也已有实质代码。真实外部 Chat 模型双镇交流仍未通过，资源保护、正式迁移信任连续性、已检测克隆隔离、严格 Embedding 激活校验及部分数据管理要求仍有缺项。156 项通过不等于这些未覆盖的要求通过。

## 范围与证据规则

- 第 22、27、29、30、31 章覆盖旧示例的协议冲突。当前网络只要求双方可达的 Direct HTTP(S)；WSS、长轮询回程、Relay、自动 VPN、NAT 穿透及 HTTP-AEAD 明确留到以后，**不计为当前实现缺陷**。
- 第 21.5、31.4 节允许安全库条件不满足时关闭 HTTP、交付 HTTPS 必选路径。当前固定 `DISABLED / HTTP_AUTH_LIBRARY_UNAVAILABLE`，符合这个明确回退边界；它不是“HTTP 已可用”，也不是虚假加密模式。
- P0 可只验 1 个访客/会话与 1 对端点，但不能免除持久账本、Home 大脑、真实 Host 行动、长期记忆、故障返乡、模型固定绑定及数据预检等要求。非网络的 P1/P2 产品目标仍逐项保留，不能仅因当前 P0 测试通过宣布完整方案完成。
- 状态：**已证实**表示与要求相同范围的当前代码及已执行测试支持；**部分**表示仅实现或仅较窄范围通过；**缺失**表示明确实现链不存在；**待真实验收**表示模拟/事务证据不足以证明真实部署要求；**后续明确项**表示设计明确延后的能力。
- `FEDERATION-VALIDATION.zh-CN.md` 的历史联调陈述记作已有记录，未把它当成本轮重新运行的证据；截图仅证明当时一帧的视觉结果，不证明持续行走、交流或故障恢复。

## 本轮实际执行与证据索引

| 证据 | 本轮观察 | 能证明的范围与限制 |
| --- | --- | --- |
| E1：`npm test -- --runInBand` | 退出 0；19 套件、156 测试通过；40.728 秒 | 下面列出的具体断言；不含真实外部 Chat 提供商双镇自然交流或生产压测 |
| E2：`npm run build` | 退出 0；TypeScript 与 Vite 构建通过 | 可编译；保留 Browserslist 与大于 500 kB 的包体积提示 |
| E3：`npm run lint -- --quiet` | 退出 0，无 error 输出 | 不证明零 warning；`--quiet` 会隐藏 warning |
| E4：`git diff 8e05997 --stat -- assets data src/components/PixiStaticMap.tsx src/components/Character.tsx convex/aiTown/movement.ts` | 只见 Character 加 5 行访客标签；原素材、地图数据、地图渲染与 movement 未变 | 支持保留原像素资产与基础寻路；不是完整游戏行为回归 |
| E5：`output/playwright/town-b-visitor-map.png` | 已实际查看：原像素地图、`From Local Town A` 标签、另一旅行居民列表 | 一帧访客可见及画风；不证明来源真实模型、移动轨迹或对话链 |
| E6：`docs/FEDERATION-VALIDATION.zh-CN.md` | 记录独立 Linux Convex 部署、隔离测试 CA、确定性 OpenAI-compatible 决策、真实 Qwen 1024 维 Embedding、760 记录/67 分块实际恢复 | 历史可复跑记录；真实 `claw` 决策仍为空/超时；不是本轮重做，也不是公网或所有故障拓扑验收 |
| E7：`scripts/federation-smoke.mjs` | 已检查断言：两独立 townId、配对/探针、Home 身体移除、Host 无新增 Agent、任意接受动作/回执、安全返乡 | 脚本尚不强制 say、moveTo、本地 AI 轮流对话、旅行记忆、不同模型/维度、Host 模型关闭、强停/网络分区；不能单靠此脚本通过证明 §2.10 完整演示 |
| E8：`convex/federation/transport.test.ts` | 配对真实 HTTP handler；临时 CA/两个真实 TLS socket；顺序、NACK、Resync、丢 ACK、容量、租约 | 网络测试用客户端适配与临时 CA；数据库测试大量采用 seeded visit，不等价真实进程崩溃 |
| E9：`runtime.test.ts`、`engineInputs.test.ts` | 真正 Game 输入、saveDiff 与数据库事务；到期清理、迟到输入、冻结/取消、回执拥堵、原活动完成 | 强证明游戏提交边界；仍需独立真实运行故障矩阵 |
| E10：`models.test.ts`、`agent/conversation.test.ts` | 固定绑定、独立提供商请求、不同维空间、回滚、全局参与者、60 天旧旅行事实检索、提示词数据隔离 | 提供商请求在测试中控制；60 天为构造时间数据，不是持续 60 天运行 |
| E11：`backup*.test.ts`、`identityRecovery.test.ts`、`storagePolicy.test.ts` | 回滚、引用重映射、克隆、来源停止/租约等待、密码/篡改拒绝、容量/安全清理 | 覆盖已有备份格式与路径；不自动证明未实现导出范围或 peer 迁移接受链 |

## 需求 → 当前实现/证据 → 判定

下面 R01–R46 是需求的规范化清单。重复章节映射到同一行，避免把重复叙述误计为多个已完成功能。

| ID | 需求及方案位置 | 当前实际实现/证据 | 判定及尚需完成的证明 |
| --- | --- | --- | --- |
| R01 | 独立数据库/世界、本地自治、不依赖 Registry（§1–4、2.1、3.1） | 每部署独立 Convex；无 Registry 业务依赖；E6 两后端；E7 townId 不同 | **部分/待真实验收**：需核验地图/数据库/角色不同、A/B 独立断开后本地仍正常；townId 不同独自不能证明数据库独立 |
| R02 | 保留原游戏、角色人格/记忆与像素画风（§4.2、10、11.4） | E4 原 assets/data/寻路保留；E5 地图；E9 本地 activity/wander/remember 回归；原 conversation/memory 仍使用 | **已证实到所测范围**：应补真实本地 AI 日常对话、反思及换模型后的记忆回归，不能用地图未改声称所有行为无回归 |
| R03 | 稳定随机 townId、长期身份、公钥/秘密/地址/TLS 分层（§3、18.3） | admin.initialize / security / federationIdentity / resident bindings；独立 peer credential；公开状态剔除秘密 | **已证实**：E8、E10、E11 支持当前 HTTPS 身份分层 |
| R04 | 人工申请/批准拒绝、双方本地独立输入高熵 PSK、密钥不明文上线、双方凭证确认（§18.1/4、21.1/4–8） | peers.requestPair/approvePair/continuePair/finalizePair；P-256 ECDH+HKDF+PSK/MAC+Ed25519，依赖标准 TLS；E8 handler 正确/错误 PSK 与出站不含 secret | **已证实 HTTPS 范围**：HTTP 不使用这份自制应用握手去替代成熟明文认证库 |
| R05 | 拒绝重申、冷却、过期/重启可查询、取消申请、通知未核验标签及未读提示（§21.1/4/8/12） | receiveRequest 持久队列、每来源/全局一分钟限流；rejectPair 与 continuePair 查询；UI 展示 claimed fingerprint、状态、期限 | **部分**：没有 cancelPair 操作、未读状态/角标或明确“全部自报身份尚未核验”提示；拒绝后新 ID/跨重启 pending-both-confirm 完整场景缺测试；通知推送本身属后续增强 |
| R06 | 空镇无副作用双向 Probe，TRUSTED 不等于 Ready，Ready 前拒绝 visit（§22.2、31.1/5） | 独立 /probe；严格禁止 visit/agent/action；持久双向时间窗；E8 空镇、伪 Probe、仅单向、身份/端点变更竞态 | **已证实**：探针及准入的当前代码/测试证明；E6 有真实部署记录 |
| R07 | Direct 域名/IPv4/IPv6/IP+定制端口 HTTPS；证书错误不降级；单向/双不通正确诊断（§18.2/9、22.3、29.1） | protocol.normalizeEndpoint 默认 HTTPS；directRequest 标准 fetch、redirect:error、8 秒超时；E8 两 TLS socket、错误 CA、HTTP 拒绝 | **部分/待真实验收**：没有域名/IP SAN/IPv6/已有 VPN 的完整实际部署矩阵；单向 Ready 拒绝已测，双不通 `NO_BIDIRECTIONAL_PATH` 和 TLS/DNS 精确错误未完整实现；directRequest 把非 2xx 压为 FEDERATION_HTTP_status，UI 诊断不细 |
| R08 | 双方明确 HTTP 开关、HTTP-SIGNED-PLAINTEXT 风险及防重放；库不足保持关（§21.2/5、31.4） | admin/status 固定 false/DISABLED；normalizeEndpoint 拒绝 HTTP；UI 明示无认证库、明文会泄露；E8 HTTP 拒绝 | **允许例外已证实**：符合 §31.4 fallback。不可声称签名 HTTP 已完成/已启用；恢复到开放 HTTP 需另做成熟握手与互操作测试 |
| R09 | 四代数独立、sender instance 匹配、旧动作/错目标无副作用（§22.4、27、31.2） | schema 独立字段；transport authenticateIdentity、ledger assertVisitAuthority；Host 提交前复检；E8/E9 四字段/权限竞态 | **已证实**：错误实例被拒绝；检测后隔离的额外要求另见 R26 |
| R10 | 持久 Inbox/Outbox 与状态同事务、至少一次/幂等/认证业务 ACK、重启重试（§6.7、12、27） | queue enqueueMessage、transport Inbox、visitLedger；E8 丢 ACK/重复/伪 ACK，E9 保存回滚重新执行 | **已证实数据库范围/待真实故障验收**：明确不能把 HTTP 200 当业务完成；真实进程重启每阶段仍待 E20 类证明 |
| R11 | 每方向每流序号、有界缺号、NACK 补发、Resync 不跳未证副作用（§22.4、27.3、31.3） | streamKey 五字段、四流、窗口16/30秒、持久 Outbox 重放、终止旧访问快照重对账；E8 独立 seq1/补发/缺历史 | **已证实**：P0 小窗口与终止旧访问的最小重同步满足允许范围 |
| R12 | 原子容量含预留/在场/正在清理、防重复出访/同访客副本（§3.4、5、7.1） | startVisit 原子 runtime 排他；receiveReserve 同事务算 occupiedSlots；presenceJob/create 幂等；E8/E9 | **已证实**：当前 maxVisitors 总槽；分类型容量另见 R22 |
| R13 | AgentIdentity/Runtime/Presence 解耦；旅行 Home 保留脑/固定绑定/记忆而无实体，Host 无本地 Agent（§4.3、24） | federationAgentRuntimes；原 Agent 旅行挂起、presence snapshot；decision.run 独立 Home 工作器；E9 出发/返乡 ID、Host no Agent；E6/E7 | **已证实实现与测试闭环**：真正外部模型成功思考另见 R15 |
| R14 | Host 权威动作白名单、合法路径/碰撞、邀请与聊天、不可任意代码，结果回执（§6、26） | parseDecision say/moveTo/invite/accept/reject/leave/wait；engineInputs 本地 movement/conversation；E9 非法动作/坐标/旧租约拒绝 | **已证实最小动作范围**：performActivity 是草案扩展动作，未实现但 P0 明确只要求 say/moveTo；不能宣称已有远程活动/任务能力 |
| R15 | 真正 Home LLM → Host 说话/移动/本地居民轮流交流；A/B 不同模型，Host 停模型不替访客思考（§2.3/4/9/10、15） | E6 确定性测试服务证明网络与提交；真实 claw 空正文/超时；E7 只检查任意 accepted action（wait 也可通过） | **待真实验收/当前未通过**：须持久真实模型调用/绑定证据、say 与 moveTo、当地 AI 回复、多轮对话、不同模型、Host 模型关闭后 Home 仍成功；不可用测试服务代替 |
| R16 | Conversation 全局身份、turn/deadline、15秒typing与18秒迟到、合法性先于落库（§26） | federationTurns 与 conversation.federationTurn；Game.saveDiff/engine action 同步校验；E9 15秒指示器独立、过期/旧轮拒绝、保存竞态 | **已证实事务范围**：有效18秒回复允许、失效18秒回复拒绝的规则已有断言；真实慢模型/轮次压力另需验收 |
| R17 | Home 保存 Host 已提交原事件，不依赖伪本地 Conversation；去重，模型生成未执行不是事实（§2.6、19.6、25、26） | travelMemory.recordConfirmedObservation / recordConfirmedEvent；ACTION_RESULT；先写文本后异步 Embedding；E10 重复message/event与全局参与者 | **已证实**：消息原文/参与者/旅行身份和检索；真实完整旅行记忆演示仍需纳入 R15 |
| R18 | 两方分别形成长期关系；再次相遇凭global ID识别同名异人（§2.6/16、13.3、25.2） | memory.concernsParticipant / conversation.globalIdentity、travel participants；E10 全局参与者与60天检索 | **部分**：具有身份关联记忆，尚无 A/B/C 再次相遇、同名不同镇、双方生成/召回关系的真实验收；独立社会关系图/历史查询UI未完成 |
| R19 | LLM慢/离线局部化、Host Tick非阻塞、模型限额等待与可见状态（§2.7、6.7、9） | 异步 jobs、每runtime一推理、远程running硬上限2、replyTimeout5–120、Home错误、Host pendingTurn；E9/E10 | **部分/待真实验收**：远程推理独立已有；缺共享本地/出访LLM并发预算、P95/平均指标、满队列背压策略与真实其他居民持续活动测量 |
| R20 | 强停B/网络分区/A重启/B重启/创建后丢ACK/Saga失败最终安全返乡（§5、9、19、27.2） | beginReturn/recoverVisits、最大可能租约持久化、60秒安全余量、Host墙钟执行前拒绝/清理、presence callbacks幂等；E8/E9/E11 | **已证实事务模型/待真实故障矩阵**：E6 实际到期返回不等于强停/分区/重启；需逐阶段真实进程与网络故障证据，含旧快照不复活 |
| R21 | 时长可配置、心跳不等于执行租约、可显示最后durable/acked/安全返乡条件（§5.3、19.4/5/8、11.1） | maxVisitDuration/replyTimeout可配；其他 reservation30秒、probe120秒、gap30秒、安全60秒固定；UI lease期限/状态与重试 | **部分**：固定参数未全部提供管理员配置；无lastDurableEventSeq/lastAckedEventSeq/恢复条件完整UI，时钟异常不能建立安全期限的隔离策略待完善 |
| R22 | 八类独立容量/资源限流、CPU内存阈值、事件速率、平均/P95、OPEN/FULL/DEGRADED/CLOSED、暂停新访客不停止居民（§2.5、7、11.1、14） | 只有maxVisitors、maxDuration；queue900/1000、nonce4000硬预算，remote decisions并发2；human原MAX_HUMAN_PLAYERS保留；storage有另一类空间预算 | **缺失/部分**：maxResident/maxHuman可配、maxReservations/maxLocalLLM/maxEventsPerSecond/maxPending、CPU内存真实指标/阈值与负载状态未具备；存储预算不是CPU/模型保护；必须真实压测Host本地响应 |
| R23 | 满员允许拒绝；FIFO/来源配额/黑白名单公平接待（§7.4、12） | 满员拒绝与peer入/出方向权限已实现；无队列 | **P0已证实；后续完整产品未完成**：P0不要求FIFO；来源公平配额、居民黑名单、可审计队列是非网络后续范围 |
| R24 | 多候选endpoint、身份验证更新地址、签名endpoint-update、peer凭证轮换/吊销交叠、身份key合法轮换链（§18.5–9、20、21） | 单endpoint；管理员updateEndpoint验旧公钥/同instance+epoch；setPolicy暂停/撤销；重新配对可替换同实例凭证；E8本地端点不变身份 | **部分**：没有endpoints数组/自动尝试备用、签名地址通知、受控credentialId轮换交叠、身份公钥轮换链与旧密钥丢失重新核验流程；地址验证正常不等于正式迁移 |
| R25 | 旧实例冻结→signed handoff→新instance更高epoch→peer接纳新实例/拒旧→Probe，身份历史不断（§23、29.2、28.2） | backup/identityRecovery会生成新instance、更高epoch且disabled/NEEDS_RECONCILIATION；sourceStopped人工确认；peers.finalizePair/updateEndpoint严格拒instance/epoch变化 | **缺失**：没有migrationHandoffRecord/证明链或peer受验证更新入口，恢复后原peer不能完成信任连续迁移；sourceStopped复选框不是旧机签名交接证据 |
| R26 | 已检测同Town克隆持久冲突/QUARANTINED并暂停新配对/旅行/敏感授权，保留本地活动（§23.4、31.2/5） | 报SENDER_DEPLOYMENT_MISMATCH / IDENTITY_OR_DEPLOYMENT_CONFLICT；备份恢复新instance；没有持久冲突实体/模式转态 | **部分/缺失隔离**：只拒某个报文，不等于检测后冻结敏感操作；应记录合法签名同Town异instance证据与管理员解除流程。分区未知克隆不要求魔法即时发现 |
| R27 | Chat与Embedding独立provider/URL/secret/router，按固定居民绑定，首个main、main只影响以后、手动审计（§2.9、4.6/10、11.2） | models/profiles/schema、独立llm Chat/EmbeddingConfig、residentModelBindings、main事务、显式setResidentChat与modelAudits；E10独立真实请求/绑定不漂移 | **已证实关键绑定语义**：不足部分见R28；当main已是legacy时首次显式Profile替换main是上游兼容路径，未自动改旧居民 |
| R28 | 首次有效保存与可用性区分、没有有效main拒绝新AI、Model健康/用量/错误率按provider/resident、删除禁用引用、操作者审计（§4.10、11.2） | saveChatProfile只验证格式直接设main；probeChat独立返回ok/ms不持久；bindResident无main自动创建环境legacy；modelAudits无operator；UI可探测 | **部分/缺失**：没有持久健康/额度/用量/失败统计、Profile停用/引用管理；没有“未通过探测/凭证缺失”的创建门禁与状态。不能把合法URL=有效模型；保留legacy需明确标识而非无声推断 |
| R29 | 一镇单活跃Embedding，跨镇不同维/厂商不传向量；只按owner/space检索（§4.7/8、25.4） | modelMemoryVectors按world/player/space；Home自建检索；普通旅行只文本/结构化事件；E10不同维空间与owner隔离 | **已证实实现与测试**：真实双镇不同Embedding维度+旅行完整闭环尚待R15 |
| R30 | 严格兼容：固定版本/权重可信证据+流水线+样本结果；UNKNOWN拒复用；状态非管理员强置（§4.7.1/2、25） | compatibility.verifiedCompatible比较管理员填revision/weightsDigest/配置；planSwitch可返回VERIFIED_COMPATIBLE；实际切换都建新空间/重建 | **部分**：保守重建安全；可信证据来源/固定版本核验/辅助样本一致性没有。自报相同字符串不能证明兼容；不宜把计划结果宣称严格验证成功 |
| R31 | 切换先预检、全部文本含增量重建、旧索引查询/失败回滚、覆盖维度/样例检索/owner/旅行验收后原子激活（§2.11、4.7.3、13.4） | beginRebuild/rebuildPage、allWritableSpaces持续双写、verifyCoverage、旧space保留、activate/rollback；E10coverage/multidim/failed rebuild | **部分**：validateSpace只为最多3条记忆请求query向量并验证维度，没有实际检索/期望命中或语义样例判定，却markValidated可激活。大镇verifyCoverage/planSwitch collect全部也缺容量验证 |
| R32 | cache按space+fingerprint+preprocessing+query/document+hash，写/查/反思/重建隔离（§25.3） | embeddingsCache.cacheNamespace与namespace_text索引；显式目标route；E10相同文本跨模型/空间/模式miss | **已证实**：没有复用legacy文本哈希条目；E11导入重建不复用旧向量 |
| R33 | 长期原文/事实/关系不14天TTL，第30天以后可检索，故障不能假造丢事件（§2.16、25） | crons.TablesToVacuum=[]；storage仅清安全操作数据；travel文字先持久；E10 60天事实；E11保护未ACK/事实压缩 | **已证实保留与合成历史检索**：不能声称连续30天生产稳定性；事实文本/长期增长另见R34 |
| R34 | 分层记忆/反思去重/关系图、热冷归档成功前不删除、存储预算与告警、旧归档可发现检索（§25.2、28.3） | storagePolicy预算/分页估算/告警/缓存重建暂停/安全facts保留；coldArchiveLocation只是字符串、backupInterval是提醒；memory getSpaceVectors>2000抛错，RemoteDecision退近50条原文 | **部分**：无真正冷归档上传/验证/按需恢复或历史搜索；长期超过2000向量无法正常语义检索；没有分层Canonical/Episodic/Social归档作业、长事实压缩和查询链。不得将地址元数据=可用冷档 |
| R35 | 管理UI状态、居民/预留/访客/容量、来源/租约/驱离、故障日志/重试（§11.1、21） | Federation/Travel面板、runtime.worldPresence、returnVisit、transport.diagnostics最近100 | **部分**：基础已实现且E5/E6；缺负载/last-event、安全条件、完整持久旅行审计事件与按时间历史查询；不是完整生产监控面板 |
| R36 | 世界前端访客同一地图/规则、来源标签、公开介绍/当地聊天、Home旅行态、抵达/离开传送特效（§2.2、11.4） | Player/Character来源标签、PlayerDetails家乡/访客/描述/聊天，Game.away列表；E5截图 | **部分**：核心像素实体已可见；没有portal/抵达离开动画或旅行过场；一帧不能证明出现→走动→说话→离开全过程 |
| R37 | 全镇普通备份version/schema/hash/signature/identity/model/raw/maps/history、不出机密；向量可不带（§17、28） | 小JSON town/resident、签名manifest/section摘要/500条5MB；大分块1GiB/2万块、严格签名、includeVectors:false；E11、E6 760真实恢复 | **部分**：大包核心范围已实现；小包dataTables未含storagePolicies/federationActionFacts/federationEventFacts，安全清理后只存facts的历史会漏导；小包只含部分向量表且无明确includeVectors选项。需统一完整配置/原事件范围 |
| R38 | 六类导出scope、多居民选择、类别/时间筛选、可选vector快照及指纹、普通敏感文本强加密（§11.3、17.1/2） | 仅town/resident两scope；大包仅town且不带vectors；身份包有加密，普通数据包明文 | **缺失/部分**：agents-selected/config-only/memories-only/history、时间/类别选择、向量选择、普通私密记忆数据加密未实现；身份私钥包的加密不能替代私人聊天备份加密 |
| R39 | 单居民可独立从大镇导出、原Home恢复原ID/或明确克隆映射；关系引用不泄露其他私记忆（§17.7/8、13.4） | getResident先collect全部各表take501，再选择；只resident→merge允许；clone/merge新身份映射；E11居民关系/引用 | **部分**：只支持合并成新居民，不能restore单居民原Home身份；从大镇取原始memories前501会截断指定居民较旧记录，且无pagination/分块居民导出，可能返回有效但不完整包 |
| R40 | 导入先验完整性/schema/身份/引用/model mapping/容量估算，冲突策略显式，不半覆盖（§17.3–5） | validateBundle/validateFields，ID重映射、Profile引用保留/缺secret清楚错误，preflight、paused维护；E11损坏/foreign/引用/事务回滚 | **部分**：已有严格拒绝与安全新ID；没有管理员profile手动映射/skip/restricted-merge计划、配额/存储成本预估、详细失败/跳过/各Profile结果与检索报告；小包无ZIP则ZIP-Slip不适用 |
| R41 | Restore/Migrate/Clone/Merge不同；目标快照/二次确认/中断续作回滚；活跃授权不重放（§17.3/5、28.2） | 小事务rollback；大stage/checkpoint/maintenanceLock/private target snapshot/retry/cancel rollback；clone新town/key；restored resident安全余量；E11 | **已证实已有路径安全性/部分完整范围**：分批维护导入不是原子世界切换，报告应保持限制；真正迁移可信peer连续性R25尚缺；大包尚不支持居民merge |
| R42 | 恢复原身份独立强加密包/错误密码拒绝/新instance/来源停机/联邦不自动信任（§18.7、21.11、28.1） | identityRecovery AES-GCM+PBKDF2、重wrap目标key、强口令/空目标/sourceStopped、public身份不变、enabledfalse；peer REAUTH_REQUIRED；E11/E6 | **已证实当前身份私钥恢复路径**：没有必要peer凭证加密灾备/轮换历史包；旧peer接受恢复新instance仍R25阻塞，不可称无缝互联恢复 |
| R43 | 备份/恢复/导出审计谁/何时/范围；下载访问限权/保留；定期隔离恢复演练（§17.2/6、28） | adminToken门禁；identityRecovery审计与backupImports；大包私有storage、客户端下载；E11/E6恢复 | **部分**：普通导出审计/操作员身份不完整；长期自动备份/外部上传未实现（设计“建议定期”非P0阻断），持续恢复演练还无计划证据；分享下载链接TTL不是当前本地下载形式的等价功能 |
| R44 | SSRF/滥用防护、消息限长、时间nonce/重放、访问scope、隐私等级、日志敏感清理（§8、18.6、21.8） | normalizeEndpoint拒部分loopback/linklocal、固定路由、不重定向；64KiB、签名MAC/replaywindow、作用域lease/turn；E8/E9 | **部分**：解析域名到禁网段/DNS变更检查、允许的管理私网网段清单没有；pair限流按自报Town+全局，未按来源IP/前缀；公开health无独立限流；无访客privacy等级/敏感历史主动清理选择。需按真实管理员网络范围设计，不直接删除内网合法Direct需求 |
| R45 | 双向自主旅行（性格/记忆/计划在白名单配额内）、任意节点扩展、第三提供商/3–10节点压力（§2.8、12 P1/P2、13.3） | startVisit只有adminToken公共mutation，由Travel表单调用；无本地Agent发起旅行决策/调度；可手动配多个peer（查询上限100） | **后续完整产品未完成**：管理员指令满足P0最小出发，不证明自主旅行；第三异构节点和多节点故障/压力验收缺失。Registry可选不阻断Direct当前闭环 |
| R46 | 协议能力协商、兼容套件、可选目录、复杂跨镇任务/资产/永久迁居（§6.4、12 P2/P3） | 固定PROTOCOL检查；/health有限身份公开信息；动作集合固定 | **后续明确项**：当前不声称Registry/开放生态/资产/永久迁居已具备；未来实现不应改原身份或复制私人向量。草案具体REST路径并非必须照抄，现有单/messages可承载同语义 |

## 显式验收清单逐项映射

括号序号均按设计原节的项目出现顺序，从 1 开始。这样原文每个 checkbox/矩阵场景都有对应证据与缺项，避免只抽取已通过的一组。

| 原节 | 每个项目的审计定位 |
| --- | --- |
| §13.1（14项） | 1→R01；2→R04/R12/R35；3→R12/R13；4→R15/R36；5→R13/R15；6→R14；7→R20；8→R10/R12/R16；9→R19；10→R07/R08；11→R20；12→R27/R15；13→R27/R28/R31；14→R29/R15 |
| §13.1.1（12项） | 1→R33；2→R13；3→R32；4→R17；5→R10/R20；6→R16；7→R06/R15；8→R07；9→R09；10→R11；11→R08；12→R26 |
| §13.2（7项） | 1→R20；2→R20/R21；3→R24/R25；4→R17；5→R19/R22；6→R04/R09/R14/R44；7→R01/R46 |
| §13.3（6项） | 1→R45；2→R22/R45；3→R18；4→R35；5→R30/R31；6→后续单居民多Embedding（§4.6.2已明确MVP暂缓，不能误判当前单空间隔离实现） |
| §13.4（11项） | 1→R27；2→R27；3→R27；4→R28；5→R30/R31；6→R29/R15；7→R37/R41；8→R39；9→R40；10→R31/R40/R41；11→R41/R20 |
| §13.5（5项） | 1→R24/R25；2→R37/R42；3→R20；4→R20；5→R26 |
| §18.9（6项） | 1→R07/R08；2→R24/R25；3→R24；4→R03/R24/R26；5→R08；6→R07 |
| §19.9（8项） | 1→R20；2→R20；3→R24/R25；4→R20；5→R13/R15/R20；6→R09/R24；7→R25/R42；8→R26 |
| §21.12（16项） | 1→R04/R06；2→R07/R08；3→R05；4→R04；5→R04/R06；6→R07/R08；7→R08；8→R07/R24；9→R24/R25；10→R24/R26；11→R05/R07；12→R05/R10；13→R04/R44；14→R12/R22；15→R37/R42；16→R20/R24 |
| §29.1（9网络场景） | 公网HTTPS→R07/R15；LAN/VPC→R07/R08；已有VPN→R07；单向A NAT→R06/R07；单向B NAT→R06/R07；双NAT无路→R07；IPv4/IPv6不通→R07；错误证书→R07；原身份换地址→R24/R25。**不要求为这些不可通拓扑实现WSS/中继** |
| §29.2（10项） | 1→R26；2→R25；3→R33；4→R13；5→R32；6→R17；7→R16；8→R10/R20；9→R04/R05/R06；10→R15/R27/R29 |
| §31.5（7项） | 1→R06；2→R06；3→R06/R15；4→R09/R25；5→R11；6→R08；7→Direct范围规则，R07 |

## 所有章节与产物覆盖检查

| 章节/明确产物 | 规范化覆盖与未完成边界 |
| --- | --- |
| §1/3/4 身份、归属、架构原则 | R01–R03、R09、R12–R14、R27–R32；AgentRuntime不是删除永久角色 |
| §2 效果A–O/完整演示 | A→R01；B→R12/R36；C/D/完整演示→R15；E→R22；F→R17/R18；G/M→R19/R20；H→R45/R46；I→R27/R28；J→R30/R31；K→R37–R43；L→R24/R25；N→R06–R08；O→R13/R16/R26/R33 |
| §5 Saga表/时间参数，§6 事件/动作/API草案 | R10–R16、R20/R21；实际/messages封装可替代示意REST路径；未实现performActivity不可宣称已具备 |
| §7容量/4C24G示例与必须实测，§8安全，§9异常 | R19–R23/R44；8本地+5访客只是测试起点，未取得机器容量保证 |
| §10代码改造表，§11四类管理/地图UI | R02/R13/R14/R17/R27/R35–R43；文件命名可不同；模型/数据/UI必须真实调用后端 |
| §12 P0十项路线 | 1→R01/R13；2→R32/R33；3→R04/R08；4→R06/R07；5→R09–R12；6→R13–R15；7→R16；8→R17；9→R20；10→R27–R29/R37/R40 |
| §12 P1/P2/P3 | 非网络Saga/稳定恢复/记忆关系/资源/数据迁移/多节点仍R18–R46保留；WSS/Relay/自动组网按版本明确延后；Registry可选；P3开放生态不作为当前P0门禁 |
| §13/18.9/19.9/21.12/29/31验收checkbox | 已完整映射前表；未把事务模拟改名为真实VPS故障 |
| §14风险决策/§15结论/§16参考 | R01/R12/R15/R22/R27–R43；参考上游链接是背景，不是当前完成证据；本轮未调用远程参考代替本地检查 |
| §17归档/manifest/六scope/三导入模式/预检/恢复演练 | R37–R43；JSON/分块格式可替代推荐zip/NDJSON，但scope/范围/模型映射/安全性需求不能因此消失 |
| §18身份/地址/key轮换/backup，§20优先级 | R03–R08/R24–R26/R42；当前单地址更新与完整迁移/合法key轮换不同 |
| §19失联/安全时间/恢复/最后确认数据 | R09/R17/R19–R21/R25/R26；不能承诺找回未落盘最后消息 |
| §21审批、HTTP、通知、信任分层 | R04–R08/R12/R24/R35/R42/R44；HTTP库不足fallback明确记录 |
| §22/27/31消息信封/独立Probe/四代数/四流/账本/恢复 | R06/R09–R11/R16/R20；持久visitLedger、reservations、in/outbox、transportSessions、streamCursors、deploymentRecords、turns有对应表；迁移证明/克隆隔离R25/R26仍缺 |
| §23迁移SOP，§24Runtime，§25长期记忆/cache，§26Conversation，§28灾备 | R13/R16/R17/R25/R26/R30–R34/R37–R43 |
| §29/30当前阶段界限 | R06–R08/R15/R20与本报告范围规则；Direct不是只模拟请求，完整业务仍必须真实验证 |
| `docs/FEDERATION.md`、网络验收/联调记录 | 文档存在；NETWORK-ACCEPTANCE仍写“claw返回400”，VALIDATION已记录最新空回复/超时，应同步消除过期陈述；必须链接可复跑日志而非只更新“通过”字样 |
| `scripts/federation-smoke.mjs` 交付命令 | E7检查实际断言；需增强动作/记忆/异构/故障覆盖后才能支撑完整演示。当前本轮未重新运行私有配置冒烟 |
| Git推送 `sshiong/ai-town` | 基准本地提交58e2cef已在本轮看到；父代理负责读取远端实际分支与push结果，本审计未联网核验或执行commit/push，不声称远端最新完成 |

## 优先开发与验证分工建议

1. **正式迁移与克隆隔离**：实现受原身份验证的migrationHandoffRecord、新instance/epoch接受与peer更新、旧实例fencing、已检测冲突持久化/冻结及管理员解除。先证明旧peer能验新部署，再真实做迁移后互访；覆盖R24–R26。
2. **模型/Embedding门禁**：持久健康状态/配置错误、新AI有效main门禁、共享本地/出访并发与审计；Embedding真正样本检索、可信兼容证据保守判定。固定绑定保持不漂移；覆盖R27–R32。
3. **容量与资源保护**：补独立预算、决策队列/事件速率、CPU/内存可信报告/新访客暂停、延迟指标与状态UI；采用实际并发居民+访客压测校准阈值。不能拿队列常量或存储告警替代；覆盖R19/R22/R35。
4. **数据和长期增长**：统一小/大包facts/配置；分页单居民导出、原Home单居民恢复、范围/时间/模型映射；普通敏感数据加密、实际冷归档/恢复检索与大镇检索预算，补恢复后检索报告；覆盖R34/R37–R43。
5. **根代理真实验收**：保留指定claw/main及固定居民绑定，在用户已启用模型范围内诊断真实模型兼容；让真实Home产say/moveTo、Host本地AI多轮回应、双方记忆/再次相遇，关闭Host模型仍由Home思考；用真实独立进程执行丢ACK、强停、分区、A/B重启、单向网络、租约清理、迁移与克隆检测。把原始状态/调用/行为/回执/记忆/回归结果存成可复查脱敏报告；覆盖R01/R15/R18/R20/R45。

完成审计应在这些缺项被实现或取得同范围证据后重跑。只有逐项证据证明实际完整目标成立，才可将开发目标标为完成；当前不得把P0子集、模拟模型成功或760条恢复演练扩张成完整联邦产品验收。


## 本轮实现后的证据增量

基准审计结论仍保留，以下代码与联调证据修正部分缺口，不把全表自动改为完成：

- R17/R33：`agent/travelTranscript.ts` 与 `federation/transcripts.ts` 接入真实 Game.saveDiff，
  可靠回传全部已提交消息（含自己发言），缺页不总结，稳定身份相遇证据、固定模型异步摘要和原反思入口已接入。
  实际 19 条/两页、最后 ACK 丢失重试、以及大文本有界页测试已证实；实际外部模型自主多轮交流仍缺证据。
- R20：实际 Host 强停、Home 重启和已提交历史 ACK 丢失已新增证据；不同创建阶段丢 ACK、全部网络分区、
  单向公网拓扑和迁移后的旅行验收不能因此视为完成。
- R30/R32：Embedding 实际 query 检索样本门禁、跨 profile 声明保守拒复用、Chat 成功 probe 才能设 main、
  已有 profile 无 main 时显式错误已实现。A/B 的 Qwen live 检索分别通过三样本；共享全镇并发策略仍待补齐。
- R37/R38：小包已包含 storagePolicies/actionFacts/eventFacts/原始对话，单居民导出改为按 owner/history 索引取数，
  其他角色 >500 条记忆不会截断本角色。原 Home 单居民 restore、其他归档范围、冷档检索和普通数据加密仍有缺项。
- R42：新完整对话及证据引用通过真实 1227 记录、89 分块恢复到独立暂停 C，原文逐项相等；
  正式 migrationHandoffRecord、旧 peer 信任连续性和克隆隔离仍未完成。
- 现有 main 和居民固定模型仍为用户指定 claw；用户更新 LAN 地址后，真实聊天探测及双向旅行决策/Host提交/Home回执/安全返乡已通过。
  管理员驱动的历史测试继续单独记录，多轮自主交流与再次相遇尚待证据。

更新后的验证细节、明确边界和复跑命令在 `FEDERATION-VALIDATION.zh-CN.md`。
完整目标保持未完成；后续应继续覆盖正式迁移/克隆隔离、资源保护、长期增长与剩余数据范围。


## 2026-10-10 增量证据（覆盖上表对应的旧状态）

- R25：正式来源冻结、目标准备、签名交接、目标激活及可信邻居重新交换密钥已实现。
  真实 D → E 独立部署完成身份延续、epoch 提升、邻居握手及访镇返乡。交接尚未绑定
  具体归档摘要；持久克隆冲突隔离 R26 仍未实现。
- 资源保护：居民、人类、访问预留、并行本地模型和待处理队列限额已实现；
  本地模型请求有持久 FIFO 许可、30 秒排队与最多 90 秒整体请求期限。CPU/RAM
  指标、来源公平配额和平台算力层取消尚未验收。
- 长期记忆：不再只检索近期候选；按居民/世界/空间完整分页扫描并精确排序。
  真实隔离数据库的 2501 条合成向量检索通过；仍是 O(N × dimensions)，
  60 秒检索期限，未提供 ANN、冷存储或持续 30 天证据。
- 模型：按用户指令，本机 A/B main 及现有居民绑定已切换为 Ollama
  `qwen3.5:4b`，显式关闭思考输出；embedding profile 和空间保持不变。
  真实聊天探测通过；首次访镇决策因模型在受邀状态返回 say 被 Host 拒绝，
  后续动作提示与纠正重试的验收结果另行记录。旧 claw 验证属于历史证据。

上述增量不代表完整产品目标完成；其余条目仍按原证据与边界处理。

## 2026-10-10 后续增量（自主发起与恢复修复）

- R05：取消/离线取消重试、持久未读与已读、冷却后新申请及未核验身份警示已实现；
  A/B 真实 HTTPS 请求、已读及签名取消通过，原 peer 不变。
- R26：已验证签名的异实例证据、持久 QUARANTINED、新授权冻结和管理员审计解除已实现；
  合法迁移/旧格式时间证据保守处理。隔离 C 单签名报文真实事务验证通过；
  尚无两个完整克隆运行进程竞争授权的实际验收。
- R42：1655 记录/113 分块原失败任务已成功续作，关系/反思跨块引用修复。
  恢复后实际第一条 input 0 成功，不靠手改游标。97 条记忆、7 页、48 引用与绑定逐项一致。
- R45：按居民显式授权的原空闲脑模型自主旅行已实现；真实 Ollama 自主选择出访 A，
  ACTIVE 后正常返乡。默认关闭，不改变人格、原模型或 embedding。
  再次相遇及长期多节点自主行为仍需原范围证据。

完整目标仍按 R01–R46 的原要求继续验收；此增量不是全目标完成声明。

- R24：签名地址通知、持久更新/ACK/重试、认证 nonce 新地址验证与重新双向探针已实现。
  A 的实际同身份 TLS 端口更换及恢复原地址均 Ready；备用多地址、凭证交叠轮换、
  身份公钥轮换链仍未实现。
- R19/R22/R35：已增加来源访客占位配额与真实模型/排队/远程决策耗时、认证事件速率；
  三类待决策任务统一计数，策略/审计参与备份。真实 qwen 双向业务生成指标可见。
  CPU/RAM、完整来源公平队列和持续压力测试仍未证实。

- R39/R40：单居民原 Home 恢复已走独立事务路径，暂停/排空/源与目标摘要/覆盖确认
  及目标快照审计已实现；实际 C 签名导出、预检及恢复通过，main/其他绑定不变。
  小包传输修复保留原版朝向负零，兼容旧档案。大镇单居民分块导出、完整六范围、
  类别/时间选择、手动模型映射和普通数据加密仍缺，不把500行小包视为大镇方案。

## 2026-10-10 当前集成检查点

- 分项导出新增单居民、所选居民、配置、原始记忆、历史五范围，与原完整小镇范围并存；
  类别、半开时间范围、同所有者证据闭包及签名分块已实现。当前分项格式明确为只读归档，
  普通导入拒绝该格式；真正分项导入、手动模型映射和跨块合并仍待完成。
- 普通快照与分块归档支持浏览器 AES-256-GCM 加密及解密，口令不发送服务器。
- 社交历史、关系、证据与原始对话查询及像素管理界面已实现；跨所有者私有证据隔离。
- 认证远程工作事件持久令牌桶已实现。当前独立 A/B 真实签名 429、相同消息重试、
  来源配额拒绝及返乡恢复验证通过，原模型绑定和 embedding 不变。
- 当前集成版本 32 suites / 367 tests、TypeScript、生产构建及 ESLint quiet 均通过。
- 本机重启清除了旧 /tmp 联调数据库；上文旧验收属于历史记录。现已在持久私有缓存
  重建 A/B/C 独立环境。当前 qwen3.5:4b 实际探测、1024D embedding 和双向访镇均通过。
  多轮真实对话及分项导入验收继续执行；此检查点不代表 R01–R46 全目标完成。

- 真实多轮 A→B：Lucky/Bob 各两次发言，原始消息与 Home 转录逐字段一致，
  COMPLETE/DONE/DELIVERED 及同身份返乡均通过。第二次同身份相遇再次通过；
  A 的关系计数2/证据2且能读取两次来源，但 B 旧记忆缺失，因此双侧 R18 不宣称通过。
- 修复原 Host 调度的待记忆优先级、超时丢失及后续会话覆盖；原记忆生成链保持，
  持久队列、精确回调与摘要/关系重试去重已实现。相关5 suites /62 tests通过，
  真实第三次对话验证继续执行，旧已丢失待记忆项不声称自动修复。
- 普通快照导出增加操作者/理由/范围/manifest摘要本地审计，旧客户端明确未署名，
  不把声明名字视为独立账号认证，不把服务器生成成功视为浏览器保存成功。
- 实际浏览器 WebCrypto 往返与错误口令拒绝通过；320/390窄屏管理视图溢出已修复。

## 2026-10-10 真实记忆根因与后续修复

- 第三次同身份自然对话未达到各两次发言，虽然清理和绑定保持通过，不能计为社交验收成功。
- 后续真实 UDF 日志定位原生 Ollama embeddings 未携带已配置的认证头，导致代理401、
  Host 的原记忆链重试阻塞。已补 AuthHeaders，保持原embedding profile/space/1024D不变；
  20项模型测试通过。修复后下一次真实Lucky/Bob各两句及双方canonical记忆/关系/原始来源通过。
  双侧重复相遇仍继续验证，旧已丢失 c276/c433 待记忆不声称恢复。
- Home 同镇对方出访时，原 loadConversation 找不到被悬挂的地图身体；已从同世界的
  原agent.suspendedPlayer读取双方保留presence，不创建身体或更换身份。14项记忆测试通过。
- 旧RETURN_PENDING在currentauthority已更高时无操作重试导致历史账本永不结束；
  现仅旧lease+safety确已过期后关闭该旧记录，不修改当前身体/权限。真实旧记录COMPLETED，
  同居民仍HOME_ACTIVE，24项core/runtime回归通过。
- 邻居凭证ECDH交叠轮换已实测A/B双方提交及签名探针。95项专项覆盖重认证、丢ACK、
  同钥ACK、过期/撤销/重新配对/部署fencing与maintenance调度恢复。身份公钥链仍待实现。

- 上述认证/悬挂presence修复后，两次新的实际相遇 c648/c671 双方各两句，
  同一Lucky/Bob身份、两个Home的canonical关系与两次新证据、原始消息来源一致性均通过；
  Home摘要DONE、Host认证交付DELIVERED、返乡及模型/embedding空间不变。
  这证明两镇重复相遇链路，仍不能替代三镇同名或长期压力验收；旧B待记忆缺口仍保留。

## 2026-10-10 选择性 v2 导入检查点

此前 v1 只读归档边界保留；新 v2 选择性导入已实现显式所有者/Profile/外部记忆引用映射、全块闭包预检、确认摘要、持久恢复和部分回滚。12 项导入测试通过。隔离 C 实际签名 8 块/8 条记录克隆完成，原居民和模型配置不变；另一次实际 REMAP 后取消并恢复全部原记录和 ID。C 此包没有 canonical memory，实际 embedding 重建仍待验收。详情见 `FEDERATION-SELECTIVE-IMPORT.zh-CN.md`。完整 R01–R46 目标继续执行。

## 2026-10-10 身份轮换、容量与三镇来源检查点

- 39 组 / 430 项全量测试、两份 TypeScript 检查、构建及新模块定向 ESLint 通过。
- 真实三镇中两个同名 Bob 的 globalId 与关系证据分离；六组原始消息来源一致，两条实际语义记忆输入与 Home 决策/Host 发言提交对应；所有居民已返乡。C 第二轮原 Bob 没有达到目标句数，保留与克隆自然交谈的真实记录，不能宣称第二次原 Bob 相遇成功。
- 正常身份公钥轮换持久双签名链与随机挑战已实现，实际 A 激活新钥、B/C 均确认，固定模型/居民身份不变。公开备份 history 导入 verified=false，私有暂存和投递表排除。丢 ACK 后双运行时模拟重启通过；原运行时定时器会取消，不能改写成实际进程重启。
- 公开 signed capabilities 和 Host 来源公平轮转、分页决策恢复已实现。三实际接口签名核验与 CPU/RAM unavailable=null 通过；3/10 来源轮转和节点摘要是合成事务测试。本地 Chat 全镇 FIFO、访问满额拒绝重试保持，完整来源公平 Chat 和接待排队、多节点持续压力仍待完成。
- 子代理因工作区额度停止后由 root 核验整合；未完成的全目标保留，不把该批检查点宣布为完整交付。

## 2026-10-10：实际私有冷档副本与按需读取

R34 新增真实私有文件存取链，而非只保存地址元数据。历史证据页自动发现归属一致的已验证归档；C 原生日常 10 条、A 旅行原文 4 条均实际写入、回读、独立校验签名/摘要并逐字核对 UUID、作者和时间。7 项事务测试验证权限、失败安全、缺页、篡改、大小界限及原生 Tick 计数滞后。原记忆/关系与全部热原文仍保留；详细范围见 `FEDERATION-COLD-HISTORY.zh-CN.md`。

完整 R34 仍是部分：尚未完成超大冷档分块、文件实体跨备份恢复、外部配置位置和验证后的热数据腾挪，不把这一检查点当作热冷分层完成或热预算降低的证据。
