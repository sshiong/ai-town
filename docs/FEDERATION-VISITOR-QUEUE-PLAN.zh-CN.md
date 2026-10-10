# 持久访客排队实施计划

状态：2026-10-10 的历史实施计划；本批实现与实际范围见 `FEDERATION-VISITOR-QUEUE.zh-CN.md`。以下保留当时只读审查形成的计划。本轮仅新增本文档，没有修改业务实现、执行部署或读取实验环境凭据。下文明确区分原设计要求、当前事实与拟议方案；拟议接口和字段尚不存在。

本文所有相对代码路径均相对于仓库根目录。

## 1. 原设计范围与完成标准

| 原设计位置 | 要求及本批关联 |
| --- | --- |
| [FEDERATION-DESIGN.zh-CN.md:108](FEDERATION-DESIGN.zh-CN.md#25-效果-e每镇独立设置访客上限并防止过载)，第 110–114 行 | 管理访客上限、来源、时长与是否排队；负载和速率超限暂停新接待；不能先创建全部访客再校验容量。 |
| 同文第 419、427–437 行 | 申请、预留、出发、抵达、返回分阶段；排队取消回 Home；预留原子化、幂等、TTL、Saga、防双活。 |
| 同文第 548–554 行 | 独立访客、预留、模型、事件、决策限制；已抵达访客和有效预留共同占用总名额。 |
| 同文第 565–571 行 | 可信来源、容量、主机健康、任务积压、速率、协议兼容共同决定准入；OPEN/FULL/DEGRADED/CLOSED。 |
| 同文第 572–576 行 | 有最大长度和过期时间的 FIFO 排队；可加来源公平配额；排队不创建真实访客、不持续占用访客推理资源；管理员可移除、暂缓、拒绝特定来源。 |
| 同文第 638–644 行 | 管理面板显示排队人数与容量；批准、拒绝、驱离、清理；旅行审计与安全返乡条件。 |
| 同文第 690、693、701 行 | 自主旅行、同角色不并发出访、资源监控、自动暂停、排队与来源公平接待均属于完整方案。 |
| 同文第 952、990 行 | 被拒后合理冷却再发新 ID 指的是小镇互联申请；不是访客排队 TTL，也没有规定访客重试冷却秒数。 |
| 同文第 1139 行 | 驱离、关机维护、资源超限沿用可审计退出状态机。 |

第 573、687 行允许 MVP 拒绝满额、简化复杂排队，不能用于把用户完整目标降为 MVP。第 701 行要求实现的排队与公平接待仍需完成。本文确定访客等待队列的完整实施边界；主机指标采集、N 节点真实压力及其他完整联邦能力仍应在总验收中分别完成，不能以完成本文宣称全部联邦方案完成。

## 2. 当前事实与准确调用链

1. 手动旅行：`src/components/federation/TravelPanel.tsx` → `convex/federation/ledger.ts:startVisit` → `startResidentVisit`。Home 原子创建 `visitLedger(state=REQUESTED)`，将 `federationAgentRuntimes` 标为 `TRAVEL_PREPARING` 并取得独占 `visitId/agentAuthorityEpoch`，通过 `convex/federation/queue.ts:enqueueMessage` 发 `VISIT_RESERVE`。此时尚未执行地图冻结。
2. 自主旅行：`convex/aiTown/agentOperations.ts` 调用 `convex/federation/autonomy.ts:considerAutonomousTravel` → `claim` → 固定居民模型推理 → `finish` → 相同 `startResidentVisit`。`quotaAvailable` 已把被拒的手动请求计入滚动日配额；`eligibleResident` 与现有非终态 ledger 阻止同一居民重复旅行。
3. 接收：`convex/federation/transport.ts:receiveMessage` → `acceptMessage` → `dispatch` → `convex/federation/ledger.ts:dispatchLedgerMessage` → `receiveReserve`。Inbox 去重在事件预算消费之前；后者在一个 mutation 中校验名额、有效预留、来源配额、决策与模型积压。
4. 满额处理：`receiveReserve` 当前只写 `REJECTED + cleanupConfirmed=true + lastError`，发 `VISIT_REJECT`。存在 `HOST_CAPACITY_EXCEEDED`、`HOST_RESERVATION_CAPACITY_EXCEEDED`、`HOST_SOURCE_QUOTA_EXCEEDED`、`HOST_RESOURCE_DEGRADED`，没有持久等待项、排队 TTL、候补提名或队列管理。
5. 成功处理：Host `RESERVED + visitReservations` → `VISIT_RESERVED` → Home `FREEZING` → `runtime.ts:freezeHome` → `homeFrozen` 发 `VISIT_CONFIRM` → Host `CREATING` → `runtime.ts:createHostPresence` → `hostCreated` → `ACTIVE`。因此排队只能插在预留之前。
6. 返回：`ledger.ts:returnVisit/beginReturn` → `runtime.ts:removeHostPresence` → `hostRemoved/releaseSlot` → `VISIT_CLEANED` → Home `resumeHome/homeResumed`。未确认清理时等待已颁发授权租约加安全余量；过期但尚未物理删除的 ACTIVE/CREATING/REMOVING 仍占容量。
7. 恢复：`convex/crons.ts` 每 10 秒调用 `transport.ts:tick`，其顺序为 transport maintenance、`ledger.ts:reconcile`、待发 Outbox。复用此定时链可以恢复等待队列，无需进程内定时器。
8. `queue.ts` 是持久 **Outbox 传输队列**；`resources.ts` 的 `federationLlmRequests` 是模型队列；`remoteFairness.test.ts` 是观察调度公平性。三者都不是访客等待队列。
9. `capacity.ts:signingSnapshot` 第 112 行明确公开 `visitorQueue: 'REJECT_AND_RETRY'`；`admin.ts:status` 与 TravelPanel 没有排队计数或期限。`resourceMonitoring.ts:configureSourceQuota` 已有来源占用配额，但没有来源等待公平调度。
10. `peers.ts:setPolicy` 当前只更新策略、清除传输就绪，不撤销候补；`autonomy.ts:configure` 通过 revision 阻止尚未完成推理的旧选择，但不会取消已经发出的旅行申请。

## 3. 建议持久化模型：复用 ledger，避免第二个状态源

以下均为拟议实现，字段名称在开发前统一。

建议在 `convex/federation/schema.ts` 既有 `visitLedger` 上增加 `QUEUED` 非终态和可选字段 `queuedAt`、`queueExpiresAt`、`queueReason`、`queuePaused`；保留原 `visitId`、双方 deployment epochs、`agentAuthorityEpoch`、`visitLeaseVersion` 与 fencingToken 作为唯一身份边界。新增索引：

- `role_state_queued`：`role, state, queuedAt`，读 Host 队列、选取最早候补。
- `role_state_queueExpiry`：`role, state, queueExpiresAt`，有界回收过期项。
- `role_source_state_queued`：`role, homeTownId, state, queuedAt`，来源暂停/移除与来源队列检查。

队列上限严格有界，候补处理分批；不对完整历史 ledger 做无界扫描，也不只扫描固定前 N 条就宣称后续来源无资格。现有 `agentGlobalId` 索引用于一角色一非终态访问。确定顺序为 `queuedAt` 后按稳定 ID 打破同毫秒并列；事务重试不改变入队时间、不刷新期限。

`federationResourcePolicy` 增加可选队列配置：`visitorQueueEnabled`、`maxQueuedVisits`、`visitQueueTtlMs`，以及公平模式和可选来源等待上限。旧记录缺字段沿用当前拒绝重试行为；开关由管理员明确设置。新增/调整 `resourceMonitoring.ts` 的管理员 mutation 时必须保留既有来源与事件配置，并写 `federationResourceAudit`。建议最大队列验证上限沿用既有 1000 的预算风格；具体默认 TTL、队列长度和访问冷却数值不是原设计规定，需实现时明确作为产品默认值，而非冒充原文参数。

自治 provenance 建议记录在 Home ledger：请求来源 `manual/autonomous`、`autonomousPolicyId`、`autonomousPolicyRevision`。这允许授权变化只撤销相关自主请求，不误伤手动旅行。Host 无需获知私人策略内容；只接收排队是否允许与有效截止。

若下一轮选择独立 `visitWaitingQueue` 表，至少需要 `visitId` 唯一查询、`state/queuedAt`、`state/expiresAt`、`source/state/queuedAt` 索引，且必须与 ledger 在同一事务中变更；还需加入 storage、恢复、迁移、维护排空检查。复用 ledger 的方案更小且没有第二个可分歧的生命周期，优先采用。

## 4. 准入、提名与公平规则

### 4.1 拒绝与排队分类

建议新 `VISIT_RESERVE` payload 提供显式 `allowQueue`，手动和自治策略均可决定等待意愿；旧客户端未提供时保留现有拒绝行为。

- 身份、信任、协议、租约、重复角色或旧 authority 校验失败：拒绝，不能借排队绕过安全校验。
- 访客总名额/预留名额/来源占用暂满：当双方允许排队且队列未满时入队，否则沿用拒绝并给出可解释原因。
- DEGRADED：等待和暂停提名；不停止已有居民，不触发候补 LLM。
- CLOSED：不接受新的候补；已有候补按暂停/取消政策处理，并在 TTL 内有界终结。
- 队列已满：`VISIT_REJECT` 的明确业务原因；不能写入后再裁剪队列，也不能驱逐旧项给新项让位。

### 4.2 原子提名

建议将 `receiveReserve` 的实际准入检查复用为一个本地 helper，而不是再复制一套条件。在 `ledger.ts:reconcile` 和 `hostRemoved/releaseSlot` 后触发有界队列处理，并在资源/来源策略恢复后调度一次处理。

提名 mutation 重新检查启用、部署模式、维护锁、身份冲突、peer 信任与 inbound 许可、双向 fresh probe 与 epochs、剩余租约、来源配额、总名额、预留名额、决策/模型积压和速率策略。必须在同一事务中完成 `QUEUED → RESERVED`、创建 `visitReservations`、写 `VISIT_RESERVED` Outbox；任何失败均不能留下半个预留。先处理已有候补，再允许新请求直接取走同一名额。

`maxRemoteEventsPerSecond` 当前限制接受的入站业务事件；等待项已被接受后内部提名不应再次制造入站事件计数。若要求限制恢复时大量候补同时入场，建议独立的入场令牌桶/速率预算，原子消费于 `QUEUED → RESERVED` 和直接预留，两条路径共用。其数值和表是实现建议；第 561 行的 1 次/5 秒只是测试初值。事件速率为零时还需明确暂停候补提名，不能绕过管理员资源关闭意图。

默认 FIFO 采用最早仍有资格的候补：被来源占用配额或管理员暂缓挡住的项保留原位置/期限，允许其他来源有资格的项前进。UI 应显示这是“当前可接待候补的 FIFO”，不能宣称所有来源严格无跳过 FIFO。

完整公平策略建议提供可选 `SOURCE_ROUND_ROBIN`：来源之间轮转，来源内部 FIFO；用持久化上次获准来源游标（可选字段放在单例资源策略或独立 scheduling 单例）避免重启重置公平性。来源占用配额始终覆盖 ACTIVE、CREATING、REMOVING 与有效预留，不把候补算为占用。来源等待上限用于防止单来源耗尽全部等待长度；它和占用配额是不同限制。原文第 574 行把来源公平配额称为可增设，第 701 行要求完整公平接待；提供两种明确模式可以同时保留 FIFO 与完整来源公平目标。

### 4.3 协议兼容

新增 `VISIT_QUEUED` 生命周期消息，payload 含 `fencingToken`、`queuedAt`、`queueExpiresAt`、可公开的原因；不要发送完整队列或其他来源隐私。必须同步加入 `transport.ts:VISIT_TYPES`、ledger dispatch、类型能力公开和测试模块。

沿用 Inbox/Outbox、lease-control stream、签名鉴权和 authority/epoch fencing；不能仅将 HTTP 200 当为排队确认。需要在双方 capabilities/协议能力中确认支持等待消息：旧节点收到未知类型会拒绝，故仅添加 Host 开关不足以保证混合版本兼容。未知能力时保留拒绝重试，不擅自给老节点发新消息。

## 5. 状态、重试、取消、过期与授权变化

建议状态链：Home `REQUESTED → QUEUED → FREEZING → CONFIRMING → ACTIVE`；Host `QUEUED → RESERVED → CREATING → ACTIVE`。入队不创建 reservation，不插 `federationCreateVisitor`，不创建决策或模型任务。Home 当前独占 runtime 继续保留，实际地图冻结只发生于有效 `VISIT_RESERVED`；普通 Home 活动是否继续应按现有未冻结行为实现，等待本身不建立持续访客推理或反复 LLM 选目的地。

当前 `dispatchLedgerMessage` 的 `VISIT_RESERVED` 和 `VISIT_REJECT` 只接受 REQUESTED，必须覆盖 QUEUED，并验证 Host 返回的期限、方向、身份和授权代际。迟到的 QUEUED 不得倒退 RESERVED/ACTIVE；重复 reserve 不刷新位置；被取消或拒绝的旧 visitId 不得复活。

最小安全方案：`queueExpiresAt = min(申请接收时间 + queueTtlMs, 已持久化的 leaseExpiry)`；提名时只使用原 leaseExpiry。这样等待会占用总授权时长，管理界面必须明示剩余期限。Host 不能擅自延长 Home 租约。若产品要“等到名额后才开始完整旅行时长”，需另行实现 Home 重新授权协议及新 lease version，先持久化最大可能发放授权，再传输；不能通过修改 Host 时间字段伪造这一效果。

取消复用 `returnVisit/beginReturn` 和 `VISIT_RETURN/VISIT_CLEANED`。Host QUEUED 与 RESERVED 都是“未生成实体”的快捷事务清理路径；Home 收到可认证的清理证明再解除 travel runtime。取消与提名、确认并发时以 Host mutation 的最终状态为准；Home RETURN_PENDING 不能再处理迟到 RESERVED 触发 freeze。若没有清理证明，保留租约安全规则，不仅根据 UI 显示 QUEUED 就自行恢复 authority。

排队过期 Host 将等待项终结、写过期原因并通知 Home，继续保留审计；Home 自动恢复独占 travel runtime。必须兼容 Outbox 满额/网络失联：本地终结不能被通知失败回滚，定时恢复或认证 resync 能证明已结束。沿用 COMPLETED/REJECTED 终态加具体原因，可避免给所有备份、迁移和 UI 判定新增终态；如果新增 CANCELLED/EXPIRED 终态则必须统一全部 terminal 集合。

重试规则：传输重试继续原 messageId/visitId，业务重试使用新 visitId 和新的 authority，在旧请求真正终结后进行。建议访客拒绝原因提供 `retryAfterMs` 或期限提示，自治下一次选择服从既有 decisionInterval/daily quota；不要把 peer 配对的 60 秒节流当访客排队规则，也不循环调用 LLM 驱动候补重试。

| 变更 | 建议等待项处理 | 安全要求 |
| --- | --- | --- |
| 管理员暂缓某候补或来源 | 保留位置，暂停提名，TTL 继续走 | 解暂停后仍检查全部准入条件；所有操作管理员鉴权并审计。 |
| peer PAUSED / inboundVisitsAllowed=false | 暂停对应候补 | 不再提名；主动拒绝按钮可终结候补。 |
| peer REVOKED / 身份或 deployment epoch 改变 | 终结旧等待项，保留原因 | 使用既有允许撤信后的 cleanup 消息；不可等待重新配对后复活旧访问。 |
| 本镇 enabled=false / 非 ACTIVE / 维护 | 停止新入队与提名；已有候补暂停或管理员批量取消 | TTL 有界；清理仍可用；恢复时逐项重新验权。 |
| 关闭排队开关 | 建议终结已有候补并告知 Home | 明确 UI 影响人数；既有已预留/活动访问按既有生命周期处理。 |
| 降低 queue max/source cap/资源预算 | 拒绝新增超额，暂停不合格提名 | 不静默删除已有候补或已有实体；等待项按原 TTL 或明确管理员取消终结。 |
| 自主旅行策略停用、目的地撤销、revision 变化 | Home 取消受该策略影响的未出发候补 | 根据 provenance 区分手动访问；已冻结/出发的访问使用安全返回，不直接解除旧授权。 |

上述暂停/取消细则是为落实安全和可审计要求提出的政策建议，原文没有给出每个开关的精确行为；实现时须把决定写入 API/UI 和测试，不能静默选择。

## 6. API、UI、备份与维护落点

| 现有文件 / 函数 | 下一轮改动边界 |
| --- | --- |
| `convex/federation/schema.ts` | 等待字段、索引、持久队列配置及自治 provenance。 |
| `convex/federation/ledger.ts:startResidentVisit/startVisit/receiveReserve/dispatchLedgerMessage/beginReturn/reconcile/hostRemoved` | 排队请求、准入分类、提名事务、消息处理、无实体取消、过期、恢复；独占 authority 不放松。 |
| `convex/federation/transport.ts:VISIT_TYPES/tick/snapshot/dispatchControl` | 新类型识别和能力兼容；确保 resync、丢 ACK、gap 恢复均保持候补状态或安全终止。 |
| `convex/federation/queue.ts:enqueueMessage` | 确认新生命周期使用正确 stream；终结通知保留 critical headroom；撤信后仍允许必要 cleanup。 |
| `convex/federation/resourceMonitoring.ts`、`resources.ts` | 队列政策验证/审计、共享准入资源条件；必要的新入场速率预算不混充入站指标。 |
| `convex/federation/peers.ts:setPolicy` | 来源暂停/撤销及时关联候补；不能只清 probe。 |
| `convex/federation/autonomy.ts:configure/finish/claim`、`autonomySchema.ts` | 标记请求 provenance；候补期间不新起 LLM；授权撤回取消未出发候补；日配额沿用请求计数。 |
| `convex/federation/admin.ts:status`、`capacity.ts:signingSnapshot` | waiting/paused/expired 计数、明确策略和原因；签名公开能力仅汇总，不暴露名字、角色 ID、fencing 或来源私密队列。 |
| `src/components/federation/TravelPanel.tsx` | 手动是否排队；Home 排队确认、期限/剩余旅行授权、取消；Host 候补批准/提名、暂停、拒绝；明确无地图访客。批准不能绕过容量。 |
| `src/components/federation/FederationPanel.tsx`、`AutonomyPanel.tsx` | 队列配置、公平模式、来源暂停/拒绝与自治等待授权；降额和关闭影响明示。 |
| `src/components/federation/uiPolicy.ts`、`uiPolicy.test.ts` | 非终态可操作、排队原因/错误解释；若沿用终态，isOpenVisit 可保持语义。 |
| `convex/federation/backupHelpers.ts:validateResourcePolicy` | 新可选配置验证；旧归档兼容；等待运行凭证不作为可直接复活访问导出。 |
| `backup.ts`、`backupLargeHelpers.ts`、`backupSelectiveHelpers.ts`、`migration.ts:assertDrained`、`storagePolicy.ts` | 验证 QUEUED 被现有非终态检查涵盖；维护/迁移先取消或排空候补；历史终结项可安全清理；新字段不导致导入活跃旧授权。 |

现有 `federationResourcePolicy` 已在普通、大包、选择性备份范围；`visitLedger` 属运行恢复快照而非普通 dataTables。复用表仍需验证新配置导入与回滚，不能以“没有新增表”跳过归档回归。CPU/内存当前在 admin/capacity 返回 null/UNAVAILABLE，Host 原生指标采集与阈值健康证据仍是完整目标缺项，队列不能把 null 改成虚假健康。

## 7. 可分配的下一轮开发任务

建议先统一字段、消息 payload、TTL/公平/暂停政策后并行开发；以下边界减少同文件竞争。

1. **后端队列与协议负责人**：schema、ledger、transport、queue，完成事务准入/提名、FIFO/来源轮转、取消过期、恢复、消息兼容；负责新队列单测与 transport 集成用例。schema 和 ledger 只由此负责人编辑。
2. **策略、自治和生命周期集成人员**：resourceMonitoring/resources、peers、autonomy，完成配置审计、源禁用撤销、自治 provenance/授权撤回；schema/ledger 所需字段通过负责人合并；补自治/资源/撤信测试及 backup policy 验证。若原生指标采集加入本批，单列该任务，不能以队列完成替代。
3. **管理 API 与界面负责人**：admin、capacity、TravelPanel、FederationPanel、AutonomyPanel、uiPolicy；接口契约确定后接入计数、策略与候补动作；补公开隐私及 UI policy 测试。只使用后端提供的准入/队列事实，不在客户端计算权威名额。
4. **主线程集成与真实验收**：处理共享生成 API、备份/恢复/维护兼容、全套类型/相关测试；真实多来源抢位、断线重启、撤销和双向自治验收；收集主机/模型负载证据并更新完整方案验收文档。不要将内存 fixture 的 3/10 节点测试描述成真实节点压测。

## 8. 验收矩阵

现有测试基础：`convex/federation/transport.test.ts` 的原子容量、lost ACK、Saga、撤信 cleanup、物理清理占位；`resources.test.ts` 的独立预留预算、积压/来源配额、零预算；`capacity.test.ts` 的签名与隐私；`autonomy.test.ts` 的一次 Saga、策略变更、滚动配额、deadline；`remoteFairness.test.ts` 仅覆盖观察调度，不替代等待公平测试。本轮未运行测试。

| 场景 | 必须可观测的通过标准 |
| --- | --- |
| 旧配置/旧节点、队列关闭 | 仍拒绝满额；不发送未知等待类型、不改变老 API 默认行为。 |
| 满额且允许等待、两并发候补 | ledger 持久 QUEUED、长度不超上限；无 reservation、presence input、visitor、decision/LLM 工作。 |
| 队列重复包 / 同 ID 冲突 / 同毫秒到达 | 去重不重排不延长 TTL；冲突拒绝；稳定顺序可复现。 |
| 总名额与预留名额独立、多个并发释放/新申请 | 原子提名不超卖；老候补优先；同候补只生成一个预留及一次有效访问。 |
| FIFO 与跨来源轮转 | FIFO 顺序与来源内部顺序可断言；暂停/配额阻塞来源不饿死其他来源；重启保留轮转游标。 |
| 来源占用/等待上限 | 活动与未物理清理实体仍计占用；候补不计占用；单来源不耗尽等待长度。 |
| DEGRADED、模型/决策零预算、入场速率耗尽 | 暂停提名，原住民和已有访问保留；恢复后受同一预算控制分批入场，不能突发绕限。 |
| 候补到期、TTL 边界、剩余租约不足 | 不冻结/创建过期候补；通知终结与 Home runtime 恢复；不擅改已颁发授权。 |
| Home/Host 取消 × 提名/confirm/迟到 queued/reserved | 只有一个最终状态；取消不会被旧消息复活；已出发使用 Saga 返回。 |
| peer 暂停、inbound false、REVOKED、identity/epoch 更换 | 暂停或终结符合公开策略；旧授权不能在恢复信任后自动复活；撤信 cleanup 可投递。 |
| 自治禁用/目的地撤销/策略 revision 更新 | 旧 LLM 不出发；已发候补取消；手动请求不误取消；候补期间不重复决策，日配额仍按真实请求计。 |
| lost ACK、两端重启、网络断开、Outbox 满 | 持久恢复原位置；重复提名幂等；终结本地效果不回滚；resync 或安全期限完成恢复。 |
| Admin 权限、公开 capabilities | 非管理员不能改队列/取消他人请求；签名有效；公开仅汇总，不泄露居民、来源详细队列、凭据或 fencing。 |
| 备份恢复、clone、维护/迁移、存储回收 | 配置兼容老档；等待与凭据不被导入后立即复活；非终态阻止不安全迁移；终结审计正确保留/清理。 |
| 真实 3 来源、双向自治、并发抢最后名额 | 展示 Host ledger/物理实体/容量、Home 独占 runtime、排序与来源进展；名额释放后无需再次 LLM 即推进候补。 |
| 真实断线/重启/撤信与负载阈值 | 保存可核验事务/消息/实体与模型调用证据；观察恢复时间、零双活、原住民不中断；CPU/RAM 不用模拟值替代真实测量。 |

完成标准：实现持久、有界、可公平提名、可撤销、可过期、可恢复且受全部准入策略约束的访客等待闭环；同时交付管理员入口、自治授权联动、公开能力、归档兼容和确定性测试，之后通过真实多来源及故障验收。未完成的主机指标或完整方案其他能力继续作为未完成项追踪。
