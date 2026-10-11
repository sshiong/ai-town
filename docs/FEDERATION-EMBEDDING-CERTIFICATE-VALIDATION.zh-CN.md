# 可信 Embedding 服务证书真实验收（2026-10-11）

隔离 D/E 分别使用既有受管理 Ollama `qwen3-embedding:0.6b`、1024 维流水线执行实际验收。部署管理员精确授权既有服务端点的模型管理身份；现有服务器凭据只用于认证请求，不进入客户端证明或仓库。每镇新增 3 份 synthetic profile、2 个非活动 BUILDING 空间及 1 份 synthetic 记忆，正向验证与向量复制均限于这些独立记录。

正式 `verifyProvider` 从实际服务读取 `/api/tags`、`/api/show`、`/api/version`、`/api/ps`，获取模型 artifact digest、metadata digest、服务版本与流水线信息，检查已加载模型的 digest，并真实生成 query/document 样例。生成前后服务证据必须一致，证书由系统记录；表单自报 weightsDigest 不作为证书证据。

## 实际结果

| 验证 | D | E |
| --- | --- | --- |
| 正式服务验证 | 2 份 VERIFIED_PROVIDER 证书 | 2 份 VERIFIED_PROVIDER 证书 |
| 系统证书兼容判断 | 权重、metadata、pipeline、provider 一致；verifiedCompatible 为 true | 权重、metadata、pipeline、provider 一致；verifiedCompatible 为 true |
| 真实证书样例 | query/document 对应样例 cosine 均为 1 | query/document 对应样例 cosine 均为 1 |
| UNKNOWN 负例 | custom 自报权重 profile 返回 UNKNOWN；即使自报摘要与真实 artifact digest 一致，无证书也不兼容 | 同左 |
| 带证书生成 | explicit route 的真实 query/document 生成均绑定服务证书；document 重查 cache hit 为 1 | 同左 |
| 正式有界复制 | copyReusePage 复制 1 份 synthetic 向量到另一独立空间，向量精确相同并保留原 generation certificate | 同左 |
| 原活动空间 | planSwitch 仍为 UNKNOWN / REBUILD_REQUIRED，canReuse 为 false | 同左 |
| 不变检查 | modelSettings、联邦身份、原 embedding profiles/spaces、原居民 bindings 的摘要全部保持一致 | 同左 |

两镇合计取得 4 份真实服务证书，使用 4 个非活动空间、2 份 synthetic 记忆和 4 份向量记录。复制在每镇自己的两个隔离空间之间执行，没有声称跨镇向量传输或恢复已通过。未执行 activate、全局空间切换或全世界 rebuild；没有为了得到正向 planSwitch 而修改原活动空间，也没有自动认证旧向量。

## 信任与验证边界

授权受管理提供方必须准确报告 metadata，且管理员不能在请求之间替换模型 tag 后又恢复。这是明确的服务管理信任边界，不是第三方权重签名，也不能证明一个不可信服务的真实权重。正式检查还绑定服务版本、metadata、前处理、query/document prefix、normalization、维度与样例；仅相同模型名或自报 weightsDigest 仍不足以复用。

本次证明真实服务证书的正向兼容判断、UNKNOWN 否定、带证书生成与正式有界复制。既有活动空间缺少 generation evidence，继续要求安全重建。完整世界的正向 planSwitch、覆盖验证、activate/回滚、跨镇备份向量恢复、服务变更/撤销的实际故障注入及浏览器流程不由本次结果替代。

临时管理员 fixture 与执行脚本只保留在私有验收目录，不加入产品代码。私有 proof 保存模型标识、计数、固定结果码和样例相似度；仓库不记录私有运行标识、所有者标识、服务端点、样例向量、记忆原文或凭据。
