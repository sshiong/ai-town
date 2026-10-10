# 联邦实体输入的失活引擎恢复

## 追加真实进程故障验收

2026-10-11，使用已部署版本和本机 Ollama 完成 `scripts/federation-fault-smoke.mjs` 两项演练。访客在 Host 实体创建后强制终止 Host，Home 请求返回；Host 停机期间持续检查 Home 身体未恢复，最终返回时间晚于最后租约截止 70.4 秒，满足默认 60 秒安全余量。重启 Host 后确认旧访客实体移除、预留释放且部署身份保持。另一项在访问中强制终止并重启 Home，确认部署实例与代数保留、Home 未创建第二身体、Host 仅一个对应访客，认证清理后原居民恢复。

脚本成功证明与恢复后的冷历史独立检查保存在本机私有测试目录，凭据不入仓库。两项属于特定阶段的进程故障验证；不替代完整网络分区、乱序重放和所有 Saga 阶段的验收。

## 真实故障证据

2026-10-10，本机 A/B/C 候补重启演练中，A 正常发出 B 的 VISIT_RESERVED，B 在约 79ms 后提交收件回执；双方没有对应消息的投递失败，但 B 没有发出 VISIT_CONFIRM。A 的 30 秒预留到期后清理，原 Home 长租约仍有约 178 秒。不是排队未晋级，也不能把此时的 LEASE_EXPIRED 文案解释成原旅行租约已经结束。

只读系统调度记录确认，Docker 重启时 B 的 runStep action 失败，错误为 Transient error while executing action。B 的 API 已恢复、worldStatus 仍为 running，但预留等待期间没有新的 runStep 链。freezeHome 调度成功并插入持久输入，最终该输入成功处理；处理发生得太晚，无法完成已经过期的预留。旧 schedulePresence 只对 inactive 世界启动引擎，对仍标 running 的失活引擎直接入队；每 60 秒 watchdog 的恢复不足以保证本次 30 秒预留及时处理。最终居民均已安全返乡。

## 修复与验收边界

复用原 kickEngine、generationNumber 校验与 watchdog 停滞阈值，在首次实体输入和 PENDING 输入重试时检查引擎进度。正常引擎不 kick；COMMITTED 输入不重新执行；重试 PENDING 输入沿用原 inputId。可选 lastRecoveryAt 节流记录只用于避免重复唤醒争抢，不替代实际进度；新 kick 使旧 generation 的保存被原事务校验拒绝。恢复不跳过原模拟时钟，不吞普通业务异常，管理员停机意图保持。

这一恢复路径使用原 2×ENGINE_ACTION_DURATION 停滞阈值；它并不承诺每种刚发生的故障都能在 30 秒预留内恢复。预留已经过期时仍按原 Saga 清理，不能延长 Home 授权或复活旧访问。自动恢复必须与真实进程重启联调分别核验。事务专项三套 89 项通过（runtime 23、普通备份 34、大型分块备份 32）；覆盖冻结、恢复、创建的重复输入、健康引擎、管理员停机与旧 generation 保存拒绝。普通及大型恢复均清除源端 lastRecoveryAt，私有回滚快照保持原运行状态。Convex TypeScript 和目标 lint error 检查通过。冻结修复部署到四个本机后端后，真实 A/B Docker 重启追加演练通过：原两份候补的位置/期限保留，暂停 B 后 C 入场并返乡，原 B 请求随后入场并返乡；另两份候补取消与过期均认证清理并恢复 Home。严格断言 ACTIVE 时 Host 仅一个实体，Home 原身体已冻结且同一 Agent/visitId 保留；候补时无实体/预留/推理任务。最后 A/B/C 原居民 ID、Chat/Embedding profiles 不变且全部 HOME_ACTIVE。私有证明为 visitor-queue-restart-live-proof.json；旧失败证明另存，均不入仓库。此为特定重启场景证明，不是全阶段网络分区或任意负载时延保证。
