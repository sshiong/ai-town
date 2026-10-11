# 全方案残项重新审计（2026-10-11）

本次逐节读取 1902 行 `FEDERATION-DESIGN.zh-CN.md`，对照当前代码、测试和后续验收文档重新判断；不沿用历史审计 R01–R46 的旧判定。父任务提供基准为 `4bbe533`，本审计未运行 Git、全量测试、部署或读取凭据/私有聊天。下列“实测”均表示仓库验收文档已有记录，并非本次重新运行。测试数量不能证明完整产品已完成。

同一工作区的 CPU/内存监控、超大单会话冷档代理正在实施。其未冻结、未完成验证的改动标为进行中，不能计入已完成。本文是本次审计时点的清单；之后修复须附独立验证记录再关闭相应项。

## 已补齐、不能继续沿用的历史缺项

后续代码和记录已覆盖：配对取消及未核验身份提示、持久身份冲突隔离、签名地址更新、双边通信凭证轮换、身份公钥正常轮换及旧密钥丢失重核验、正式签名迁移、共享 Chat 预算与来源公平、持久访客队列、事件速率限流、全局关系图/历史面板、自主旅行最小链路、普通备份浏览器加密、六类选择性导出、显式 Profile/居民/引用映射、分块导入续作与回滚、原 Home 居民恢复、选择性及完整备份冷文件携带与独立校验。长期检索也已移除原 2000 向量硬拒绝，采用分页精确检索。

真实证据包括 A/B 自然对话与再相遇、三个独立后端的来源隔离和关系召回、Host 强停/Home 重启、真实队列暂停/晋升/取消/进程重启、真实 429 与相同事件重试、大完整备份 7182 条/396 块、选择性冷文件备份 197 条/28 块以及独立恢复原冷文件签名。各证据有边界，不自动覆盖异构模型、所有故障阶段、长期压力或组合恢复。

## 实现缺口（C）、进行中（P）

优先级按风险和当前契约排定；P1 表示应优先处理，不意味着设计原文全部归为 P1。

| 项 | 优先级 / 设计要求 | 当前代码依据与准确残项 |
| --- | --- | --- |
| C01 | P1，§2.9、4.10 首个有效 main / 新居民门禁 | `convex/models/profiles.ts:66` 保存只创建 Profile/settings；`:318` 成功 probe 仅写审计；`:89` main 仍需独立手动设置。`ModelsPanel.tsx` 的 Test 与 Set main 也分离。首个成功验证 Profile 未自动成为 main。`:151` 创建居民仅检查 main 存在，未检查其最新失败/凭据缺失状态；既有居民不得静默换供应商。legacy 路径须保留明确兼容语义。 |
| C02 | P1，§18.7、23、28 恢复后身份版本连续 | `identityRecovery.ts` 的 Header、加密 secret、installIdentity 均不携带 `identityVersion`；`backup.ts` 同镇 restore identity patch 与 `backupLarge.ts` finalizeImport restore patch 不复制版本。version 2 身份恢复后隐式变为 1；`identityKeyRotation.ts` 发起取本地版本 `?? 1`，接收要求与 peer 当前版本一致，下一轮正常轮换失败。需 version2→恢复/同镇备份还原→再次轮换组合回归，而非只测分别成功。 |
| C03 | P1，§23.5 恢复实例默认禁止直接激活 | `identityRecovery.ts:304` / `:314` 写 `mode: ACTIVE`，虽 enabled/incoming 为 false，但 `admin.configure` 可直接开启 ACTIVE 身份。正式 migration.prepareTarget 会改 MIGRATING_IN，却不是恢复后必经入口。与“新恢复实例默认 MIGRATING_IN，完成校验才 ACTIVE”不符。不得以一个 sourceStopped 复选框替代交接验证。 |
| C04 | P1，§5.3、19.1/4/7/8 故障可见性与时间策略 | `protocol.ts` 固定 skew 30s、probe 120s、gap 30s、safety 60s；visitorQueue reservation 30s 固定。visitLedger 无 lastDurableEventSeq、lastAckedEventSeq / 恢复条件汇总。peer probe 失败时 visit 可仍显示 ACTIVE，直至租约处理；TravelPanel 有期限/错误/重试，没有失联确认、安全返乡条件与事件进度的完整展示。没有时钟跳变/无法建立安全期限时的显式运行策略。不能声称心跳等于租约续期。 |
| C05 | P1，§4.7.3、25、27 长期历史有界执行 | `embeddings.ts:163` planSwitch、`:343` verifyCoverage 全 collect memories；`:401` 样例检索全 collect owner/space 向量。分页 rebuild/search 不足以保证切换可完成。`ledger.ts:363` reconcile 全 collect visitLedger，再筛非终态，长期旅行历史会扩大安全恢复每次读量。应分页/索引处理并验证完整覆盖，不能以 2501 条检索通过替代巨大切换/长期账本证明。 |
| C06 | P1/P2，§4.10、11.2 模型管理完整产品 | Chat Profile 尚无停用/删除及绑定引用处理入口；没有按 provider/Profile/resident 持久健康、额度、用量、失败率面板。resourceMonitoring 为镇级聚合，不是这些细分统计。modelAudits 有旧/新/原因/时间，无操作人字段。手动切换与固定绑定已经实现，不能再写“居民会随 main 漂移”。 |
| C07 | P1/P2，§18.2/5/6/8、22.3 连接诊断 / 备用地址 | schema identity/peer 为单 endpoint，没有候选地址数组/优先级/备用重试。`direct.ts:27` 将非 2xx 压为 FEDERATION_HTTP_status；未形成 DNS/TLS/双向不通 NO_BIDIRECTIONAL_PATH 的完整统一诊断。标准 TLS 校验及不自动降级已有，不缺安全 HTTPS 基础。 |
| C08 | P1/P2，§8、21.8 滥用 / 出站地址策略 | `protocol.normalizeEndpoint` 拒部分字面 loopback/link-local，但未核验域名解析后禁网段/DNS 变化；无显式合法私网清单。pair receive 按自报 townId 与全局限流，无来源 IP/前缀限流；公开 health 无独立限流。应兼顾合法 VPN/私网 Direct，不粗暴禁全部私网。访客披露等级/更细居民拒访名单也未具备完整产品入口。 |
| C09 | P2，§4.7.2、17.1/2、28.3 向量复用 / 可选快照 | `compatibility.verifiedCompatible` 始终 false，所有未知走安全重建，已纠正旧自报摘要可兼容的风险。尚无可信权重/流水线证据来源与严格 VERIFIED_COMPATIBLE 正向复用分支；大/选择性包 includeVectors:false，导入统一 REBUILD。安全重建路径可满足当前安全要求，但不能声称可选向量快照/已证明兼容复用产品完成。 |
| P01 | P1，§7 CPU/内存真实阈值 | 原代码 CPU/memory 为 unavailable；host_health 代理正在增加真实上报及准入，审计时不作完成判断。真实宿主报告、陈旧样本/伪造拒绝、阈值恢复、当地居民继续运行与性能校准均需对应验证。 |
| P02 | P1，§25.2、28.3 超大冷历史 | 审计基准冷文件为单文件、最多 1000 条/900000 bytes，超过明确拒绝；discover 仍声明 hotRecordsRetained。chunked_cold 代理正在实现分块。未验收前不能声称任意超大单会话已归档/可搬运；先验证完整性再删热副本、删后发现/查询、失败续作仍需验证。 |
| C10 | P2，§25.2 分层压缩 / 配置冷位置 | 真实私有 storage 冷归档、签名与备份搬运已实现；storagePolicy 的 coldArchiveLocation 仍是配置字符串，没有通用外部位置适配器。反思保留 relatedMemoryIds，但没有完整分层批处理压缩/纠错置信度链；不可将已有 reflection 或安全清理等同全部长期压缩产品。定期自动备份/外部上传属“建议”，不单独作 P0 阻断。 |
| C11 | P2，§17.6 操作审计 | 普通小包和选择性导出已有操作原因/范围审计；`backupLarge.startExport` 仅 adminToken，完整大包缺导出操作者/原因归属。模型切换审计操作者缺口见 C06。大包下载使用私有 storage，不能继续称公开下载无权限保护。 |
| C12 | P2，§11.1/4 世界/管理体验 | 像素资产、Home away、Host 来源和公开介绍已有；Character/PlayerDetails/Game 尚无抵达/离开传送特效。diagnostics 只取最近 100 条，未形成按 visit/time 的完整持久旅行审计查询面板。动画不应改变原有画风与碰撞机制。 |

## 真实验证缺口（V）

这些不等价于代码缺失；应先写可执行场景，再运行真实后端/浏览器/提供商，保留脱敏结果。历史模拟与函数测试仍有效，但不能升格为以下实测。

| 项 | 已有证据 | 尚须验证 |
| --- | --- | --- |
| V01 异构模型 | 独立 Chat/Embedding 路由与 owner/space 测试；当前真实 Qwen Chat、1024 维 Embedding | 不同镇同时使用不同真实供应商/模型/维度，访客仍固定 Home 绑定；Host Chat 服务关闭后访客 Home 推理继续成功。 |
| V02 完整旅行演示 | A/B 真实自然对话、返乡、再次相遇；原寻路/动作实现 | 一次可复现的出现→Home LLM moveTo→Host 合法路径/碰撞→双方多轮说话→离开全过程；完整 UI 来源/Home 缺席与实体排他。accepted wait 不能替代走动/说话。 |
| V03 故障矩阵 | ACTIVE Host 强停、Home 真重启、最终历史 ACK 丢失、队列真重启 | REQUESTED/reserved/frozen/CONFIRMING/CREATING/REMOVING/RETURN_PENDING 分别进程中断、创建后 ACK 丢失、Home 关闭但 Host 存活、Host 重启 Home 仍离线、真实双向网络分区和过期旧回复；每阶段证明唯一活体/最终回家。 |
| V04 克隆/身份组合 | 单部署注入合法签名冲突而隔离、真实迁移及一次身份公钥轮换 | 两个独立副本持相同私钥并发争夺权威，双方持久隔离且本地不依赖联邦活动继续；version2 加密/同镇备份恢复后再次轮换（C02）；身份轮换 commit ACK 丢失与真重启组合。 |
| V05 网络矩阵 | TLS socket/错误 CA、真实 HTTPS 端口变更，双向探针准入 | 真实域名/IP SAN、IPv6、已有 VPN 地址、DNS/证书更新、单向/双向阻断的准确诊断；不要求当前实现 Relay/WSS。 |
| V06 资源与规模 | 来源公平/事件 429/队列 A/B/C、共享预算测试 | 3–10 个独立部署同时互访、慢/离线模型、容量满、续约/返乡关键流量压力，本地 tick 平均/P95 与 CPU/内存阈值实测；10 个合成来源不等于 10 后端。4 OCPU/24GB 参数需实测校准。 |
| V07 Embedding 切换 | 真实 query 向量及最多三条期望召回校验；旧空间保留/覆盖/回滚测试；2501 条合成分页检索 | 真实不同维度空间、重建期间增量事实/旧查询、完整覆盖、原子切换、失败回滚、旅行记忆召回；超大 activation/coverage 读限（C05）。 |
| V08 数据完整流程 | 7182 条完整大包恢复、选择性显式映射/冷搬运、原 Home 小包恢复、事务测试 | 超过 500 条单居民选择性导出、各类别/模式 Profile map/skip 与引用映射；真中断/续作/取消回滚；重建完成后的长期检索；浏览器文件→预检→映射→加密/解密→应用→报告整链路。WebCrypto roundtrip 不等于管理整流程。 |
| V09 冷历史边界 | 本地/旅行原事件冷归档，独立恢复签名；完整/选择性搬运原 C 会话 | 真实超大单会话分块、部分写入/发布失败、存储 ACK 丢失、取消/重启、搬运旅行来源文件与来源图、热副本删除后发现/读取。验证 exact 原文可在测试内比较，报告不泄露原文。 |
| V10 长期成长 | 60 天合成年龄检索、关闭 14 天 vacuum、安全 facts 保留、关系图/多来源召回 | 验证第 30 天及更久的原始事件和记忆文本仍可查询，并覆盖增长、关系/反思、配额/告警、归档/备份恢复与本地自治。原方案 §13.1.1、§29.2 要求长期保留及可查询，没有要求交付前连续运行 30 个自然日；合成年龄可验证留存门禁，但不能代替持续运行耐久性证据。第二轮指定当地居民未说话的演示应据实际结果重试，不伪称命中。 |
| V11 自主旅行/本地自治 | 一次真实 B→A 自主旅行、三个独立后端 | 双向长期自主发起、性格/记忆/计划/来源配额共同约束，断联时独立当地生活；多节点长期故障压力与不同地图/居民数据回归。 |

## 原 R01–R46 范围重新定位

保留历史编号仅便于找到原需求；下表判定来自当前重新阅读。覆盖 §1–31，包括原明确验收清单和后续范围，不将“实现/测试有”写成“所有生产实测有”。

| 原编号 | 当前结论 / 残项定位 |
| --- | --- |
| R01 独立自治 | 独立部署与非 Registry 路径有；长期/断联/不同世界验证 V11。 |
| R02 原机制画风 | 原像素资产/寻路/对话保留；完整动态演示 V02，长期回归 V10。 |
| R03 长期身份分层 | 随机 Town、长期钥、peer 凭证、实例/TLS 分层有；恢复版本 C02。 |
| R04 双边人工配对 | HTTPS ECDH/PSK/MAC/身份签名与确认有；异构真实网络 V05。 |
| R05 配对取消/通知 | 取消、拒绝/过期/持久查询和未核验标签已补；IP 前缀滥用 C08。推送可选。 |
| R06 独立双向 Probe | 空镇无业务副作用、TRUSTED≠Ready 与准入有；真实拓扑 V05。 |
| R07 HTTPS Direct | 基础有；C07/C08/V05。 |
| R08 HTTP | 依 §31.4 明确禁用 fallback 合规，不能称 HTTP 明文认证已完成。 |
| R09 四类代数权威 | 独立字段/执行复检有；组合重启 V03/V04。 |
| R10 Inbox/Outbox/业务 ACK | 持久事务与幂等有，真实部分重启有；完整 V03。 |
| R11 序号/NACK/Resync | 有界窗口与最小安全重同步有；规模 V06。 |
| R12 排他/原子容量 | 预留/在场/清理容量及同访客副本拒绝有；全阶段 V03。 |
| R13 Home 脑/Host 身体 | runtime 分离、Home 固定绑定与 Host 无 Agent 有；V01/V02。 |
| R14 权威动作 | say/moveTo/invite/accept/reject/leave/wait 有；扩展活动 F03。 |
| R15 自然真实交流 | 已从旧失败推进到真实对话；异构/Host 模型关闭/动态演示 V01/V02。 |
| R16 turn/deadline/提交 | 有；实际慢模型压力 V06。 |
| R17 确认事实回源 | 原事件/参与者/去重和先文字后向量有；失联组合 V03。 |
| R18 关系/再次相遇 | 独立关系表、真实再相遇和多来源召回已补；长期 V10。 |
| R19 慢模型局部化 | 共享预算、等待、公平与硬超时已补；V06。 |
| R20 安全返乡 | 实现及真实 ACTIVE 强停/重启有；C04/C05/V03。 |
| R21 时钟/时间/可见安全条件 | C04。 |
| R22 分类容量/监控 | 多类容量、事件速率和统计有；P01/V06。 |
| R23 来源公平/队列 | FIFO/来源 RR/配额/恢复已补；细居民拒访 C08，压力 V06。 |
| R24 地址/凭证/身份轮换 | 签名更新、凭证交叠、身份轮换已补；备用地址 C07、组合 C02/V04。 |
| R25 正式迁移 | 旧实例冻结、签名 handoff、fresh credential/epoch 与真迁移有；C02/C03/V04。 |
| R26 克隆隔离 | 持久 conflict/QUARANTINED 与敏感操作阻断已补；两真实克隆 V04。 |
| R27 固定 Chat 绑定/main | 绑定不漂移/手动切换有；自动首 main C01。 |
| R28 可用性/管理/审计 | 持久探测成功/失败有；C01/C06。 |
| R29 单空间/owner | 隔离与不传跨镇私向量有；异构真实链路 V01。 |
| R30 严格兼容性 | UNKNOWN 全部安全重建；正向可信复用 C09。 |
| R31 重建验证/切换 | 已新增真实期望命中/负样本校验；C05/V07。 |
| R32 cache 命名空间 | 指纹/space/模式隔离有，恢复不误用旧向量。 |
| R33 长期保留 | vacuum 关闭与历史检索有；V10。 |
| R34 分层/冷历史 | 分页搜索、真实冷归档/搬运已补；C05/C10/P02/V09。 |
| R35 管理/审计UI | 容量/队列/来源/驱离等有；C04/C12。 |
| R36 世界UI | 来源/公开介绍/Home away 有；C12/V02。 |
| R37 完整普通备份 | 小包已补 facts/storage policies，完整大包有；向量选项 C09。 |
| R38 六类导出/强加密 | 已补选择性全部范围及浏览器加密；向量 C09/V08。 |
| R39 单居民独立导出/原ID恢复 | owner 查询与原 Home 恢复已补；大单居民 V08。 |
| R40 预检/映射/报告 | 严格预检、显式映射/skip/冲突策略已补；完整真实 V08。 |
| R41 不同模式/续作/回滚 | 实现/事务测试及大完整恢复有；C02/V08；分批应用维护模式不是原子世界切换。 |
| R42 加密身份恢复 | 加密/错口令/新instance/disabled 有；C02/C03/V04。 |
| R43 操作审计/演练 | 小/选择性已补；C11/V10；自动定期备份为建议。 |
| R44 安全/披露/限流 | 签名/nonce/lease/turn/bodysize 有；C08，HTTP fallback 合规。 |
| R45 自主/N节点 | 最小自主链路已补；V06/V11。 |
| R46 生态/兼容/扩展 | 固定协议及有限能力公布有；通用版本协商/开放兼容套件 F01，生态 F02/F03。 |

## 明确后续与可选项（F），不误判为当前 P0 阻断

- F01：通用协议版本/能力协商、对外兼容测试套件、N 节点开放接入。当前固定版本检查与最小能力公布不等于通用协商。
- F02：Registry/小镇目录、发现/推荐/社交管理、WSS/Relay/NAT 穿透及自动 VPN 编排。§22、29、30 明确当前仅 Direct，已知节点不依赖目录。
- F03：复杂跨镇活动/任务/商店/资产、永久迁居、单居民多个 Embedding、移动/PWA 与高级旅行过场。保留扩展点，不为当前闭环改原身份或泄露私向量。
- F04：HTTP 应用层成熟认证库及可选 AEAD。当前明确 DISABLED 是 §31.4 允许路径；未来开放需双方选项、标准库、互操作与风险提示，不把自制 HTTPS 配对协议直接当 HTTP 安全库。
- F05：自动定期备份/外部上传与长期运营演练安排属于生产建议；若声称这些功能已交付，则另需真实实现及证据。

## 下一步顺序与关闭条件

先修 C01/C02/C03 和安全恢复读量 C05，再冻结验证 P01/P02；随后补 C04 与 V03/V04 的组合故障，避免各模块单独成功而组合失效。真实异构模型和完整旅行演示 V01/V02 是用户目标证据，不能被测试数量替代。之后完成模型/网络/审计产品缺口、规模/长期验证及可选生态。

关闭每项须写清代码修复、对应测试、真实验证范围与仍未覆盖的条件。本文不声称 1902 行方案已经全部实现，不把后续项混入当前安全闭环，也不因部分长期能力已补而只留下超大冷档一个残项。

## 本轮身份恢复修复检查点（审计之后）

C02 的代码缺陷已修复：新加密身份包在经过签名和 AES-GCM 验证的 secret 内保存 `identityVersion`，无需变更现有 version 1 Header/格式；缺字段的 legacy 包按 version 1 兼容。普通和大包同镇恢复复制来源版本，预检拒绝非正安全整数。C03 的三个新部署实例恢复入口均改为 `MIGRATING_IN`，既有 admission configure 拒绝直接开启非 ACTIVE 部署；身份恢复界面提示导入普通包后走正式签名移交。

本次实际运行 `npm test -- --runInBand` 的 identityRecoveryRotation、identityRecovery、identityKeyBackup、migration、identityKeyRotation 五个套件，最终共 38 项通过。新增组合测试走独立 Convex 测试数据库与实际 HTTP handler：正常轮换 1→2，分别加密身份恢复 / 再普通同镇恢复 / 再大分块同镇恢复，验证无法直接 configure 开启，然后冻结源实例、签名 handoff、目标激活、协商 fresh peer credential，邻居继续接受正常 2→3 轮换。普通/大包场景刻意删除目标版本元数据后恢复，验证两个恢复 patch 独立发挥作用。另验 legacy 加密包、非法版本拒绝、现有密钥/迁移协议回归。

正式 signed handoff 也新增 optional `identityVersion`：新源镇明确签出当前版本，目标以已验证的源签名补回旧加密包缺失的版本，禁止向已知版本降级；邻居核对自身已信任的版本，若 handoff 使用历史公钥则要求经过验证的连续签名版本链。邻居自身描述的版本也与当前身份/历史签名链核对。旧 handoff 缺字段明确按 version 1，遇到已知 version 2 拒绝而不按公钥相同猜测。新增旧 version 2 加密包缺字段→新正规 signed handoff 补回 2→正常轮换 3 的组合，以及 legacy version 1 handoff 兼容、签名降级/非法版本拒绝、错误历史版本链拒绝。

这不是独立真实部署故障演练。V04 的真实恢复/重启/ACK 丢失组合仍需运行。旧加密包本身仍无法证明未知版本；可通过对应普通签名备份或带明确版本的新正规 handoff 补回，不能声称旧包凭私钥就能推断历史。原 C/P/V/F 表保留审计时点事实；其他并行修复未在此检查点宣告完成。

## Root 独立身份验收与最新检查点

身份修复已作为 `0afe259` 推送到 `sshiong/ai-town` 的 `feat/federation-town`。Root 从独立冻结目录运行身份组合四套件，32 项通过；冻结版本全量 45 套件、589 项通过，前端及 Convex 类型检查通过。这些结果针对冻结版本，不代表之后的冷档、模型配额与 Embedding 分页改动已统一验收。

随后新建三个隔离的本机 Convex 后端 F/G/H，部署该冻结版本，以标准 TLS 校验的真实 HTTPS 路由完成双边配对。源 F 正常轮换到身份版本 2，邻居 G 接受；将加密身份包恢复到 H，确认版本仍为 2、模式为 MIGRATING_IN，实际调用 configure 开启被 DEPLOYMENT_NOT_ACTIVE 拒绝。冻结源 F、生成目标声明、签名交接、激活 H、与 G 协商新通信凭证之后，H 正常轮换到版本 3，G 接受新公钥和版本，通信凭证在此次身份轮换前后保持一致；H/G 实际双向签名探针通过，旧源 F 保持 MIGRATING_OUT。凭据及恢复口令没有写入仓库，脱敏验收记录保存在本机私有实验目录。

此真实演练证明的是身份包恢复路径与正式交接后的下一次正常轮换。普通整镇与大分块恢复路径已有独立组合测试，尚未完成各自真实部署演练；丢失 commit ACK、进程重启及两克隆并发争权仍属于 V04 残项。C02/C03 的原代码缺陷已修复，不能将此演练扩大为 V04 全部完成。

其他已推送检查点：`5be7571` 修复首次有效 Chat main 与新居民健康门禁；`964761c` 引入真实宿主 CPU/内存报告与准入；`a27a4f0` 将活跃访问账本恢复改为持久分页，分别验证数千条终态历史不扩大活跃恢复读量，以及独立 A/B 的 Host 强停和 Home 重启恢复；`3c84f57` 修复资源面板 React key 冲突，并检查 320px 窄屏没有横向溢出。C05 的 Embedding 部分、P02 冷档最终真实验收、C06 模型管理及 C04 时间策略仍需后续独立检查点。

## C07 Direct 候选地址与诊断实现检查点（2026-10-11，待独立冻结验收）

历史 C07 的单地址实现缺口已补入当前代码：identity/peer 可保存最多四个 HTTPS 候选（主地址及三备用），每项为有界 URL 与管理员优先级；旧单 endpoint 自动等价为唯一候选。配对请求/响应与现有签名 endpoint-update 绑定完整地址集合，更新继续验证可信公钥、通信凭证、部署实例、顺序及有效期。接收新集合须通过独立签名挑战，候选变更递增 endpointGeneration 并清除旧双向就绪证据。

Direct probe、业务消息及签名端点通知在 DNS/TLS/timeout/网络不可达和 HTTP 502/503/504 时按候选优先级有限重试；备用业务投递前必须验证同一可信身份的签名 probe。身份/鉴权/代数/冲突或协议拒绝不继续尝试其他主机，响应提交事务再检查身份公钥、信任、凭证、部署与 endpointGeneration。备用成功不隐式改变地址集合/代数，丢 ACK 重试保持原消息 ID、nonce、序号与操作内容；Home 思考/固定模型绑定和 Host 执行职责不变。双向独立 probe 仍是旅行准入条件，单向成功显示 NO_BIDIRECTIONAL_PATH 的“反向尚未验证”诊断。

诊断区分 DNS_RESOLUTION_FAILED、TLS_VERIFY_FAILED、CONNECTION_TIMEOUT、FEDERATION_HTTP_status 与 NETWORK_UNREACHABLE；底层 fetch 未提供 DNS/TLS 细因时不编造细因。管理 UI 可配置地址优先级并显示可信候选、最后验证的出站入口和原因。TLS 仍由系统验证，拒绝重定向及 HTTP，不因 TLS 失败降级。HTTP/外部 VPN 自动配置仍不在此次实现范围。

普通/大包/选择性导入复用地址集合语义预检，拒绝不一致主地址、重复/过量/越界候选与非法代数；恢复/克隆换址和 migration prepareTarget 清除源地址集合，只保留目标入口，避免目标激活前访问旧源实例。正式签名 handoff 仍是身份迁移权威，候选入口不是迁移授权。

尚未完成本轮独立冻结验收；新增的模拟两镇备用路由、丢 ACK 去重、同主地址代数变化、DNS/TLS/timeout/HTTP 分类与恢复/克隆旧候选清除测试不能计为已通过。真实多域名/IPv4/IPv6/VPN 备用入口切换、真实双向防火墙/NAT 分区与证书轮换仍属于 V05 网络验收缺口，既有真实 TLS socket 测试不等价于上述多主机实测。

## 分块冷档、模型管理与有界切换集成检查点

`52041f7` 已推送到 `sshiong/ai-town`。独立冻结目录的全量回归 49 套件、630 项通过（666.431 秒）；后续只读心跳修复的 3 项测试另行通过，完整前端构建及 Convex 类型检查通过。没有混入仍在开发的 C04/C07。lint 为 0 错误、5490 警告，未将警告写成零。

C05 的 Embedding 原全量 collect 路径已替换为持久分页规划/覆盖/检索样本验证：一事务最多一次 paginate，源记忆页 25 条/512KB，向量反向验证页 4 条以约束解引用原文预算。超过 2500 条记忆的测试涵盖完整覆盖、最后页缺向量、错误 owner、后段检索负样本、原子激活与旧空间回滚；有限并发新增记忆触发重扫并最终纳入。源文本/归属 material revision 与 space vector revision 绑定最终证书，lastAccess 不使证书失效。持续 material 写入仍需要稳定验收窗口：最多三次自动重扫后显式失败，管理员可续作；不能说任意持续写入下都会完成。已有旧向量没有 sourceDigest 时需 Rebuild / catch up 后重新 Validate，旧 validatedAt 无法绕过新证书要求。规模测试为 Convex-test 与 mock provider，不代替 V07 真实异构模型切换。

C06 增加 Chat/Embedding 停用、引用保护删除、受影响居民确认、管理员角色审计、provider/Profile/resident 三层 UTC 日请求配额以及真实调用统计。统计区别已知 tokens 与未报告 tokens，缓存命中不计供应商请求；配额和停用策略在普通、大分块、选择性备份中可验证恢复，用量桶/回执不是可移植策略。C01 也补上新居民 main 凭据缺失门禁，已有绑定保持不变。模型与调用链专项 112 项、配额及 C11 导出审计专项 11 项已通过；全量冻结回归包含这些专项。

C11 的整镇大导出新增 operator/reason 并在签名发布事务写成功审计，记录实际清单 digest、各表计数与字节数，重试完成不重复记审计。旧客户端明确 legacy-admin-token，UI 要求填写声明标签和原因；operator 是共享管理员令牌下的自报标签，不能当成独立认证用户身份。

P02 的 v2 冷档独立恢复和浏览器完整链路实际通过：隔离 D/E 的 1207 条合成原文、49 个带原签名分块，重复首块幂等，上传过程中重启目标后继续并发布；再导出 root/所有分块与源一致，全部原文匹配，两端热副本保留。浏览器在另一个匹配原文且无冷档目标中选 root、核验指纹、显式映射审阅、49 文件上传和验证发布后，再以独立 API 验证原签名/原文和锁释放。320px 窄屏没有横向溢出。归档本身不截断、不删除热原文、也尚未实现 C10 的压缩或外部存储适配；真实完整/选择性大包搬运、所有故障阶段及长期增长仍按 V08/V09/V10 继续验收。

## C04 时间策略与安全返乡实现检查点（2026-10-11）

时间参数已采用有界配置：reservation、lease、允许 UTC skew、双向 probe freshness/interval、stream gap、请求 timeout、return margin 与持久 clock observation gap。每趟保存 maximum trip deadline 和实际 return margin `max(configuredMargin, 2 * observationGap + 60s)`；默认新访问实际 margin 为 300s，legacy 缺字段仍保留原 60s 边界。配置修改、续租、普通/大型恢复都不得缩小保存边界。Home 在投递前持久保存最大可能有效 lease；probe 只更新通信就绪，不能延长 lease。

持久 clock 记录在 transport maintenance、ledger reconcile 和成功的 world saveDiff 事务观察墙钟。回拨/超出 observation gap 时锁存 uncertain；之后时间前进、普通 probe 或重试不会自行解锁。锁定阻止新访问、队列晋升、续租、Host 创建/动作/物理活动及单凭未确认墙钟返乡。runtime 排队、engine loadInputs、纯 input、saveDiff 与动作/实体提交都有相应门禁，提交前异常会回滚 side effects 和 engine cursor；重新加载会拒绝旧输入，推进正常本地模拟。

签名清理和已提交历史页可继续补传。时钟锁定下只对无新动作授权的清理/历史类型放宽墙钟 TTL，时间仍须安全整数且 envelope TTL 长度有上限；消息继续验证可信签名、MAC、部署实例、部署/角色/租约代数、visit/fencing/stream、原 canonical digest 与幂等 ID。普通 DECISION/OBSERVATION/续租/创建不能借恢复豁免进入。每趟显示通信 SUSPECT/最后双向 probe、安全返乡条件/实际 safeAfter、保存 margin/deadline，以及 Host durable history page seq / Home ACK seq；Home 的 ACK issued 是本地持久回执，不冒充 Host 已收到回执或未收到原文。

管理员恢复分两步：显式确认服务器已重新同步 UTC 后，只允许已保存 lease+margin 的期限返乡（returnClockConfirmedAt），新准入/续租/Host 动作仍锁定；等所有访问结束后才允许完整解锁。后续回拨或 observation gap 会撤销 return-only 证明。这避免 Home 时钟锁定且 Host 永久离线时，必须先结束访问才能证明安全期限的互等。确认 UTC 不是 Host 清理证明，不能把 checkbox 写成签名 cleanup。缺本地 clock 观察的旧旅行灾备恢复要求先明确 UTC 确认；resident 选择性同镇恢复既有 source/target HOME_ACTIVE、无 visit 门禁继续保留。

首轮核心检查最终 5 套件、159 项通过，Convex TypeScript 检查通过。之后补入保守 margin 的新访问/改配置/续租、普通/大型备份 saved margin 与缺 clock 证明、以及两阶段恢复组合测试；这些新增检查的最终结果待追加。没有部署或真实校时/进程故障演练。本策略仍依赖可信节点正确同步 UTC（误差上限 30s）；墙钟自观察和保守单次跳变 margin 不能证明持续漂移或任意错误时钟的上限。V03/V04 的真实时钟/分区/宕机组合与长期运行仍未据此关闭。

## C08 网络边界与访客披露实现检查点（2026-10-11）

联邦出站改由 `nodeNetworkRequest/send` 的 Node internalAction 执行：每次请求重新解析域名，检查全部地址，随后用自定义 socket lookup 将本次连接固定到一个已经检查的地址。TLS 的 Host、SNI 和证书域名校验保留原始域名，IP 字面量仍要求有效的 IP SAN 证书；禁用连接池复用，不跟随重定向，不自动降级 HTTP。解析/连接/响应读取共享超时，响应上限继续为 64 KiB。默认 Convex runtime 的 fetch 没有 DNS 固定接口，因此没有以“先查 DNS 再 fetch”冒充防重绑定。已信任 Town 的签名/MAC、部署代数及 ACK 核验继续独立生效，DNS 地址变化不能改变信任身份或覆盖 peer 公钥。

LAN/VPN 地址需要部署管理员通过 `FEDERATION_PRIVATE_NETWORK_ALLOWLIST` 明确填写逗号分隔 CIDR，例如批准自己的 LAN 子网、CGNAT VPN 子网或 IPv6 ULA 子网；清单只能落在 RFC1918、100.64.0.0/10 或 fc00::/7 内，不接受公网或跨出私网父网段的广泛授权。回环、链路本地、组播、未指定/保留地址、IPv6 转换/隧道目标及已知云元数据地址始终拒绝，清单不能解除这些禁止。检查全部 DNS 结果，所以混合“公网+禁止地址”的域名也会拒绝。没有配置清单时私网地址返回 PRIVATE_ENDPOINT_NOT_AUTHORIZED；配置清单不会创建 VPN/路由，Convex 云环境是否实际能到达私网仍取决于部署条件。

公开 pairing 在解析/验签之前持久消耗来源预算，来源仅取 Convex `ctx.meta.getRequestMetadata().ip`，不信任请求者提交的转发 Header。按来源 IP、IPv4 /24 或 IPv6 /64 前缀以及全局预算限制，申请 Town 声明和本地发起账户另有预算；账户未登录时使用共享本地管理员预算。health 使用独立计数器及来源/前缀/全局预算，429 返回 Retry-After。计数器按分钟窗口有界保存和清理；health 保留配对身份所需的签名协议/身份/部署信息，不再披露候选地址或内网入口。

Home 为每位居民保存 PUBLIC / FRIEND_TOWNS / WHITELIST 披露策略。出发时只构造姓名、外观、公开简介和 Home 镇名；未获简介披露权限的目的地收到空简介。FRIEND_TOWNS 仅向 TRUSTED 节点披露（当前互访本身也要求 TRUSTED），WHITELIST 使用精确 Town ID 清单。默认 PUBLIC 保留既有公开简介行为；策略不会复制记忆、模型设置/密钥或管理员审计原因，也不会撤销已有租约。Travel 管理页提供设置入口；新策略只影响之后的出发，已发送的简介不会自动从远端删除。备份恢复必须随居民身份映射保存披露策略，避免隐私选择因恢复丢失而退回 PUBLIC。

本检查点列明代码实现，未把定向测试或真实部署当作已通过。新增测试覆盖全部 DNS 结果检查、固定 TLS lookup、解析超时后禁止迟到连接、IPv6 VPN、重定向/响应大小、来源/前缀/账户/town 限流及披露过滤。既有协议集成测试只在测试模块内模拟 Node 网络边界，不是实际 DNS/TLS/VPN 证明。Node action 部署、真实证书/域名切换、真实 IPv4/IPv6/VPN 可达性及自托管 Convex 请求来源元数据仍需独立部署验收；运行环境若不支持 Node DNS/socket 能力必须保持失败，不得退回未固定 DNS 的 fetch。


## 当前整合检查（2026-10-11）

继对话翻译检查点 `e376d4b` 后，正在整合 C07/C08/C09/C10，而非将已有专项测试视为全方案完成。

- Root 补入新模型用量、证书/重建任务、公开限流和披露策略/审计的存储分类。当前存储专项 11 项通过，包括实际对象字节、共享引用去重和新记录计量；现有 lint 警告仍存在。
- 外部冷存储新增 Node 请求层与服务器环境绑定，使用 HTTPS、每次 DNS 全结果核验与固定 socket、AWS SigV4 签名、2 MB 有界对象、上传后逐字节读回。5 项测试使用注入 socket 验证策略与读回，不是真实 S3/MinIO 验收。签名格式依据 [AWS S3 单请求认证说明](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html)。
- 外部请求层已接通管理员归档任务、逐片持久断点、失败重试、取消及中英管理界面；签名根对象最后上传，原本地归档保留。Node 层 5 项、实际签名归档任务 5 项与存储策略 11 项合计通过。前两套使用注入网络结果，不能作为真实 S3 证明。已建立独立 MinIO 实验环境，其官方客户端 8 项真实操作通过；应用端真实上传正在验收，没有配置用户云存储。
- C09 证书选择与恢复绑定、C10 摘要来源证据和备份映射修复已经进入本轮冻结。官方 codegen、前后端类型检查及前端构建通过。全量 Jest 首次为 66 套通过、一套大备份的 6 项失败；修正旧测试数据假设后，大备份整套 45 项复测通过，生产表顺序校验没有放宽。组合证据覆盖全部 67 套、817 项；前端 7 套、55 项另行复测通过，已经包含在上述总数内。
- 隔离 D 已部署集成代码。实际 registered Node action、默认拒绝 loopback/metadata/未授权私网均有运行证据。裸自托管后端会将客户端 X-Forwarded-For 纳入平台来源元数据，来源不可伪造这一项当前不通过；需要受控入口覆盖转发头，并阻止外部绕过入口直达后端。全局预算保留，不能用此前模块测试代替实际入口保障。
- 当前批次尚未提交；真实冷归档、记忆压缩和向量证书联调，以及原 V01–V11 验证矩阵仍需完成。上述专项结果不关闭全方案目标。

### 后续实际证据

隔离 D/E 的真实记忆来源链已通过：现有 Ollama qwen3.5:4b 经正式异步压缩处理 4 份原文，生成 2 份带主观来源证明的摘要；追加 1 份纠正后，关联摘要不再 current。签名居民导出、正式同居民恢复及跨镇 merge 保留原文、纠正和失效状态，原全局设置及原居民绑定摘要相同。模型桥接恢复后由正式任务自然重试，没有清除 claim/permit。详见 `FEDERATION-MEMORY-PROVENANCE-VALIDATION.zh-CN.md`。这不证明完整向量兼容认证、复用或重建已通过。

冷归档实际 Node 请求在隔离 E 遇到 UNABLE_TO_VERIFY_LEAF_SIGNATURE；私有诊断证明 action 没有继承外部 NODE_EXTRA_CA_CERTS。官方 mc 的成功仍不能替代应用端 TLS/签名上传。正在补入服务器配置的附加 CA 信任，并保持默认根、证书身份核验与 rejectUnauthorized；错误证书不得借此绕过验证，应用端验收仍未通过。

上述 CA 问题随后已由正式 `serverTlsTrust` 共用配置修复，5 套相关回归 70 项通过。E 实际 S3 全链 9 项通过，包含停机/恢复重试、根文件最后、取消终态和官方 mc 独立读回，原件及身份/世界/main 指纹不变。详见 `FEDERATION-COLD-MIRROR-VALIDATION.zh-CN.md`。这不覆盖公网、服务器重启续作或所有浏览器操作。

D/E 实际可信 Ollama 证书的最小链均通过：权重 artifact/pipeline/provider 证据、1024 维查询/文档样例一致、正式正向兼容和单个合成向量复制保留生成证书。仅自报权重仍 UNKNOWN，原未证书化活动空间仍要求重建；没有激活新空间或改全局配置。详见 `FEDERATION-EMBEDDING-CERTIFICATE-VALIDATION.zh-CN.md`。完整备份向量导入、全局切换及重建验收仍需独立证据。

### 验收范围与冷归档后续补证

重新核对原方案后，V10 不再把交付前连续 30 个自然日运行当作原文硬性条件；长期事实保留和历史查询要求保持。持续运行耐久性仍是单独待验证范围。隔离 E 的真实 Convex 后端重启续作已通过 5 项检查，完整浏览器上传、根文件最后和取消流程已有中英验收记录，分别见 `FEDERATION-COLD-MIRROR-VALIDATION.zh-CN.md`、`FEDERATION-COLD-MIRROR-UI-VALIDATION.zh-CN.md`。这两项更新覆盖上述旧时点的“尚待”判断，不关闭其余 V01–V11 或完整方案目标。
