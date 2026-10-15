# 联邦实体输入的失活引擎恢复

## 长期旅行账本的有界恢复

安全返乡协调不再收集整个 `visitLedger`。每次事务按状态索引读取最多 20 个活跃访问，完成和拒绝的历史不参与扫描。入口先处理 `RETURN_PENDING`，再为其他活跃状态分别安排持久调度任务；每个任务只执行一个分页查询，有更多记录时保存游标续作。队列准入仅由入口调用自身有界 worker，分页续作不扩大一次候补处理额度。

专项覆盖 3000 个已结束访问和 51 个待返乡访问，逐页产生全部 51 个不同的恢复任务；另一项验证前页改变索引状态后续页仍不漏掉访问。三项新增测试与候补回归合计 63 项通过，冻结版本 Convex 类型和目标 lint 检查通过。2026-10-11，将该冻结版本部署到本机 A/B 后重新完成 Host 创建实体后强停、Home 访问中重启两项真实故障演练；原居民全部返乡且测试配置恢复。私有证明为 `ledger-reconcile-fault-proof.json`，不含凭据并留在本机测试目录。

## 追加真实进程故障验收

2026-10-11，使用已部署版本和本机 Ollama 完成 `scripts/federation-fault-smoke.mjs` 两项演练。访客在 Host 实体创建后强制终止 Host，Home 请求返回；Host 停机期间持续检查 Home 身体未恢复，最终返回时间晚于最后租约截止 70.4 秒，满足默认 60 秒安全余量。重启 Host 后确认旧访客实体移除、预留释放且部署身份保持。另一项在访问中强制终止并重启 Home，确认部署实例与代数保留、Home 未创建第二身体、Host 仅一个对应访客，认证清理后原居民恢复。

脚本成功证明与恢复后的冷历史独立检查保存在本机私有测试目录，凭据不入仓库。两项属于特定阶段的进程故障验证；不替代完整网络分区、乱序重放和所有 Saga 阶段的验收。

## 真实故障证据

2026-10-10，本机 A/B/C 候补重启演练中，A 正常发出 B 的 VISIT_RESERVED，B 在约 79ms 后提交收件回执；双方没有对应消息的投递失败，但 B 没有发出 VISIT_CONFIRM。A 的 30 秒预留到期后清理，原 Home 长租约仍有约 178 秒。不是排队未晋级，也不能把此时的 LEASE_EXPIRED 文案解释成原旅行租约已经结束。

只读系统调度记录确认，Docker 重启时 B 的 runStep action 失败，错误为 Transient error while executing action。B 的 API 已恢复、worldStatus 仍为 running，但预留等待期间没有新的 runStep 链。freezeHome 调度成功并插入持久输入，最终该输入成功处理；处理发生得太晚，无法完成已经过期的预留。旧 schedulePresence 只对 inactive 世界启动引擎，对仍标 running 的失活引擎直接入队；每 60 秒 watchdog 的恢复不足以保证本次 30 秒预留及时处理。最终居民均已安全返乡。

## 修复与验收边界

复用原 kickEngine、generationNumber 校验与 watchdog 停滞阈值，在首次实体输入和 PENDING 输入重试时检查引擎进度。正常引擎不 kick；COMMITTED 输入不重新执行；重试 PENDING 输入沿用原 inputId。可选 lastRecoveryAt 节流记录只用于避免重复唤醒争抢，不替代实际进度；新 kick 使旧 generation 的保存被原事务校验拒绝。最初版本保留旧模拟时钟；2026-10-15 的修复改为恢复时直接推进到当前时间，避免新输入等待长时间追赶停机窗口。输入队列与处理游标保持，generation 校验继续拒绝旧动作保存，联邦租约与时钟检查保持；管理员停机意图保持。

这一恢复路径使用原 2×ENGINE_ACTION_DURATION 停滞阈值；它并不承诺每种刚发生的故障都能在 30 秒预留内恢复。预留已经过期时仍按原 Saga 清理，不能延长 Home 授权或复活旧访问。自动恢复必须与真实进程重启联调分别核验。事务专项三套 89 项通过（runtime 23、普通备份 34、大型分块备份 32）；覆盖冻结、恢复、创建的重复输入、健康引擎、管理员停机与旧 generation 保存拒绝。普通及大型恢复均清除源端 lastRecoveryAt，私有回滚快照保持原运行状态。Convex TypeScript 和目标 lint error 检查通过。冻结修复部署到四个本机后端后，真实 A/B Docker 重启追加演练通过：原两份候补的位置/期限保留，暂停 B 后 C 入场并返乡，原 B 请求随后入场并返乡；另两份候补取消与过期均认证清理并恢复 Home。严格断言 ACTIVE 时 Host 仅一个实体，Home 原身体已冻结且同一 Agent/visitId 保留；候补时无实体/预留/推理任务。最后 A/B/C 原居民 ID、Chat/Embedding profiles 不变且全部 HOME_ACTIVE。私有证明为 visitor-queue-restart-live-proof.json；旧失败证明另存，均不入仓库。此为特定重启场景证明，不是全阶段网络分区或任意负载时延保证。

## 长时间停机后的及时输入处理

2026-10-15，`kickEngine` 与正常启动采用相同的时间接续方式：保存原 `currentTime` 为 `lastStepTs`，直接从当前时间恢复。runtime 的 29 项测试通过；恢复专项使用真实 `Game.runStep`，验证停机 24 小时后首步处理新输入、原 PENDING 输入保留以及旧 generation 提交被拒绝。类型检查与生产构建通过。

本机 N 部署后实际触发恢复，加入输入在 633ms 内完成，移动输入在 870ms 内完成，三名原居民保持；临时测试玩家已退出。此证据证明该次本机恢复的响应，不构成所有负载下的时延保证。

## 时钟热点事务隔离与空协调任务

真实 M/N 联通后的日志显示 `federationClock` 在地图保存与维护/账本协调之间频繁发生 OCC 重试。修复将常规 transport tick 的时钟观察单独提交，再执行维护扫描；直接 maintenance 调用仍保留同步观察语义。指定状态的 reconciliation 末尾空页不作任何授权决策，直接返回，不再为每轮八个空任务读取和写入共享时钟。有记录页与 root 入口继续观察时钟；返乡的 canResume 检查保持。相同字段的重复观察跳过 patch，每个更新的时间戳仍立即记录，不采用可能遗漏倒拨的定时节流。

ledgerReconcile、transport、timePolicy 82 项及 runtime 29 项通过，类型检查、生产构建和 diff 检查通过。测试覆盖 1ms 倒拨、观察间隙、UTC return 确认撤销、维护失败后的异常锁保留、空任务不读写 clock 以及有记录任务的安全门。

两镇部署后约 67 秒、每镇 16 个采样和 4 次主动 transport retry 的短窗口内，M 最大引擎延迟 4070ms、结束 1462ms，N 最大 1784ms、结束 740ms。M 在采样前仍有旧停顿，已通过原 testing:kick 唤醒，因此该数据不能证明旧动作自行恢复；N 未手动 kick。此前仅拆分 transport 的采样曾出现 N 98 秒停顿，未记作通过。最终私有证明 `clock-contention-final-live-proof.json` 保存在工作树外；短窗口不代表长期或任意负载下无冲突。
