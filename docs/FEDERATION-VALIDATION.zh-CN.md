# 本机联调记录与交付边界

2026-10-09，基于上游 `8e05997`，在 `sshiong/ai-town` fork 实现联邦 P0 Direct
HTTPS 闭环。原地图、像素素材、角色人格、寻路、对话与记忆反思继续使用上游代码。

## 实际运行验证

- 两个独立 Convex 后端、数据库及身份，在隔离 Linux 容器运行。独立测试 CA 只挂载到容器，不修改 macOS 信任库，不关闭 TLS 校验。
- 经真实 HTTP
  actions 完成申请、管理员审批、PSK 校验、双方 TRUSTED 及独立双向探针；探针先于访问，没有借助访客或模型请求生成 Ready。
- 两镇同时互访：Home 地图身体移除，永久 Agent 和绑定保留；Host 创建单一 visitor，不创建本地思考 Agent。
- 确定性 OpenAI-compatible 测试服务驱动 Home 决策，实际跨 HTTPS 提交 OBSERVATION / DECISION /
  ACTION_RESULT；Host 已存储访客发言，Home 已存储旅行记忆。此项验证链路与提交一致性，不验证外部模型质量。
- 访问租约到期后两镇完成清理及返乡，原 Player ID 和全局身份保留，本地寻路继续运行。
- 浏览器验证真实地图访客、来源小镇、旅行居民、容量和 ACTIVE 账本；真实下载备份，暂停目标 → 合并预检 → 恢复运行。未对实际双镇数据执行导入；导入及故障回滚在数据库事务测试中验证。
- 本机 Ollama `qwen3-embedding:0.6b` 实际返回 1024 维；两镇分别完成真实 provider
  probe、全量记忆重建、样本检索验证及新空间激活。
- 历史联调中，用户指定的 Chat 模型 `claw` 保留为 main 与居民显式绑定。用户启用新模型后，
  `/v1/models` 已包含 `vibe`、`weknora`、`draw`、`openrouterfree`、`write`、`claw`、`cli`、`code`、`glm`。
  简单请求实际通过，响应标识为 `glm-5.3-flash`，曾约 60 秒返回 `OK`。
- 旧地址的真实 `claw` 双镇业务检查曾失败：旅行决策收到空正文，产生 `EMPTY_MODEL_DECISION`，
  未产生伪造动作；请求扩大输出预算后仍出现空正文，单独结构化请求也出现超时。双方仍安全返乡。
  这次历史失败不能计为真实 Chat 跨镇业务验收；先前确定性测试服务验证结果仍单独列出。
- 用户更新 LAN 服务地址后，沿用原密钥、main 和固定居民绑定。真实 Chat 可用性探测约 2.2 秒返回非空正文；
  `scripts/federation-smoke.mjs` 的两方向均通过：真实 Home `claw` 决策在 Host 提交、认证动作回执在 Home 提交，
  原身份安全返乡、Host 访客清理。该冒烟没有管理员写入决策，也没有替换模型绑定；不等同于多轮交流与再次相遇验收。
- Host 回复等待可配置为 5–120 秒，默认仍为 25 秒。本机 A/B 为 90 秒，所有迟到动作和超过租约的等待仍被拒绝。
- 两个不同服务器加密密钥的真实 Convex 环境完成独立身份灾备恢复：错误密码拒绝、签名身份保留、
  私钥重新加密、新实例和更高部署代数、联邦默认关闭，以及恢复后同一身份重新签名导出。
- 大镇真实分块导出 760 条记录、67 个分块、534108 字节，并在独立暂停环境完成签名预检及恢复。
  原镇继续使用原身份，恢复环境保留居民且保持联邦关闭。二进制与特殊数值走 JSON 字符串边界，
  防止 Convex 保留字段 `$bytes` / `$float` 导致传输失败。
- 桌面及 390px 手机浏览器实际检查大归档、独立身份恢复和存储面板，保留原像素地图与素材。
  大包取消回滚、故障续作、引用修复、克隆身份和旅行恢复安全等待另有数据库测试覆盖。

浏览器截图在本地
`output/playwright/`，该目录不入仓库。凭据、测试数据库和证书保存在工作树外。自动测试覆盖持久账本、四类代数、幂等、乱序补发、回执拥堵、撤信、过期动作、冻结取消竞态、恢复安全等待、模型固定绑定、旧事实语义检索、Embedding 隔离与回滚。

## 本轮补充验证（完整对话与故障）

- 独立 Docker Host 在访客实际创建后被强制终止。持续检查 Home 地图没有恢复身体；
  最后租约到期加 60 秒安全等待后原角色返乡。Host 重启清除了残留访客并释放容量。
  另一轮强停/重启 Home，持久身份与账本保留，Host 始终只有一个访客，认证清理后同一居民恢复。
- 两镇实际引擎完成一次 19 条消息的对话，包含访客自述，Home 完整接收两页原文并生成稳定身份的相遇证据。
  重跑时在真实 HTTPS 代理中丢弃最后一页的已提交 ACK：Home 已 COMPLETE，Host 保持 WAITING_ACK；
  恢复 ACK 后幂等重试完成 DELIVERED，Home 没有第二份页面，原居民安全返乡。
  这两次测试由管理员驱动受权限与租约约束的测试决策，模型绑定未改变，不能计为 claw 自主交流成功。
- Home 以独立页与计数接收，150 页 / 300 条大文本的测试证明后续页不需重新读取全部原文。
  大文本原文完整保留；模型摘要输入有界并明确标示 excerpt，模型失败不会抹掉原文或确定的相遇事实。
- 最新分块归档实际包含 1227 条记录、89 个分块、868067 字节；独立暂停的 C 恢复后，
  两份对话头和三页原文逐项一致，结束事实引用已映射到新的数据库 ID；C 保持联邦关闭。
  该归档早于最后一轮 ACK 故障测试，不声称包含后来新增的记录。
- A/B 在 live query Embedding 端点重新执行真实命中检验，各通过三个样本；main 和居民绑定未改变。
  Chat 请求整体中止在真实 Convex runtime 验证：100ms 期限约 124ms 返回 CHAT_REQUEST_DEADLINE。
  旧地址的 Chat 检查曾 TCP 超时；更新地址后的真实 Chat 双向冒烟结果见上文。没有逐一验证其他模型别名。
- 小包补齐存储设置、已提交动作/事件证据和 Home 原始对话；签名恢复及单居民合并测试验证页引用、
  社会关系证据引用与原文保持。超过 500 条其他居民记忆的测试不再影响本角色小包导出。
- 桌面及 390px 浏览器核对模型面板：未通过有效连接检验的 profile 无法设为 main，文案与后端规则一致。
  页面无 console error；既有 Pixi/React warnings 单独保留。

本轮原始私有证据文件为工作树外 `fault-report.json`、`transcript-live-ack-proof.json`、
`archive-live-current-result.json`、`model-space-live-proof.json`、`diagnose-chat-runtime-result.json`。
它们不包含模型密钥，完整产品未完成项继续见 `FEDERATION-COMPLETION-AUDIT.zh-CN.md`。

## 可复跑的两镇冒烟检查

先部署两镇、初始化身份和居民、设置有效模型，并提供双方可达的 HTTPS 端点。`scripts/federation-smoke.mjs`
使用真实后端接口；会审批配对、发起两方向访问，并验证远端决策及原身份安全返乡。它会改变测试镇的数据，应使用独立测试部署。

创建工作树外、权限为 `0600` 的 JSON 配置，结构为：

```json
{
  "towns": [
    {
      "url": "https://town-a-api.example",
      "adminKey": "<Convex admin key>",
      "adminToken": "<federation admin token>",
      "endpoint": "https://town-a-http.example/federation/v1"
    },
    {
      "url": "https://town-b-api.example",
      "adminKey": "<Convex admin key>",
      "adminToken": "<federation admin token>",
      "endpoint": "https://town-b-http.example/federation/v1"
    }
  ]
}
```

```sh
FEDERATION_TEST_CONFIG=/absolute/private/two-towns.json node scripts/federation-smoke.mjs
npm test -- --runInBand
npm run build
npm run lint -- --quiet
```

冒烟脚本等待真实 Home 模型决策，模型不支持/服务不可达时会超时失败，不用模拟成功结果替代。

## 构建与回归结果

- `npm test -- --runInBand`：24 个测试套件、217 个测试通过（切换本机聊天模型前的回归）；本次额外验证见下文。
- `npm run build`：TypeScript 与生产构建通过；保留依赖 Browserslist 及 Pixi 主包体积提示。
- `npm run lint -- --quiet`：零 error；全仓仍有类型安全相关 warning，未将其声称为零 warning。
- 仓库内容扫描未发现用户提供的模型 API 密钥。

## 当前边界

- HTTP 始终 DISABLED；按设计第 31.4 节的安全回退交付 HTTPS。无 NAT 穿透、WSS 或 Relay。
- 普通备份不包含身份私钥；独立加密身份包已提供。同镇恢复要求目标已有匹配身份；身份恢复本身要求空目标及来源停止。
- 小包仍受 5 MiB / 500 条原子事务边界约束；大包支持 1 GiB / 20000 分块，每块上限 900000 字节。
  大包导入须维护暂停，分批应用不是原子世界切换；失败保留锁，可续作或通过私有目标快照回滚。
  回滚重分配数据库 ID 并修复引用。居民合并继续使用小包单世界流程。
- 存储预算、分页估算、容量告警和安全清理已提供；冷位置只是配置元数据，备份频率只是到期提醒，
  未实现外部存储自动上传。已验证大备份更新最后备份时间。估算含受管理归档描述的 payload，非平台物理账单。
- 联调没有宣称公网拓扑、持续 30 天运行、大规模压力测试或所有 P1/P2 功能已经验收。长期记忆不进入 TTL 清理，旧事实检索由跨 60 天的自动测试验证。


真实进程故障复跑使用 `scripts/federation-fault-smoke.mjs`。上面的两镇配置还需为每镇添加
`containerName`（例如 `aitown-federation-a` / `aitown-federation-b`）；API 地址必须是本机，
容器名称必须使用该测试前缀且发布端口与 API 地址一致。脚本会强制终止这些测试容器并在 finally 重启。

```sh
FEDERATION_TEST_CONFIG=/absolute/private/two-towns.json node scripts/federation-fault-smoke.mjs
```


## 2026-10-10 本机聊天模型切换

按用户新指令，两镇现有居民的显式聊天绑定与新居民默认模型均切换为本机 Ollama
`qwen3.5:4b`。模型配置中显式设置 `reasoningEffort: none`，兼容接口请求发送
`reasoning_effort: none`；避免思考内容耗尽短决策的输出预算。旧配置仍保留供审计，
本次不更改 embedding profile、向量空间或 embedding 默认设置。两镇真实 provider
探测成功，分别约 222 / 163 ms，并比对确认 embedding profiles 与 spaces 完全不变。
实际端口、桥接地址、管理员令牌及其他凭据只保存在本机私有配置中。

本轮同时纳入先前并行开发完成的资源限额、全历史分页记忆检索、正式身份迁移及管理界面。
资源限额覆盖居民、人类、访问预留、并行本地模型及两个待处理队列；CPU/RAM 指标仍不可用。
全历史检索使用限定居民、世界和向量空间的分页精确余弦扫描，整体最多 60 秒；复杂度仍为
O(N × dimensions)，未实现 ANN 或冷存储。隔离 C 环境中 2501 条合成 1024 维旧记忆检索
分 45 页成功，旧事实排名第一，约 2470 ms；这不是模型生成质量验收。

正式迁移提供来源永久冻结、目标证明、来源签名交接、目标激活和可信邻居重新交换凭据。
D → E 经真实独立部署验证，保留小镇身份和原居民，提升 epoch，完成邻居重新握手及访镇返乡；
该验证不证明真实模型决策，也没有绑定某份归档的摘要。迁移恢复时引擎的历史输入游标不再
用于新的输入队列，小包与大包路径均有回归测试。新的完整 A → C 大包复跑在导入阶段失败，
不能声称该次恢复成功；A 已恢复运行，C 继续隔离。

仍需完成真实多轮对话、再次来访、异构模型及长期运行验收；完整优化目标尚未全部完成。

本机聊天切换后的完整回归：24 个测试套件、218 项测试通过，生产构建与 lint
quiet 检查通过。真实访镇冒烟失败：模型已生成决策，但 Host 动作记录为 REJECTED，
未在期限内出现 accepted 的已提交动作；脚本 finally 已请求返乡。该次结果不能作为
双向自治决策通过证据。
