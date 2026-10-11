# 跨镇向量备份真实验收（2026-10-11）

本次使用全新、仅含 synthetic 数据的 I/J 独立后端。两镇通过真实 LAN HTTPS 和精确私网授权执行正式 requestPair、approvePair、continuePair，形成双边 TRUSTED 配对。每镇初始化时居民数为 0，默认世界停止；fixture 只创建隔离的 synthetic 世界、居民和记忆，以及只读检查接口，没有伪造 peer trust、证书、签名包、向量或导入映射。

实际模型为受管理 Ollama `qwen3-embedding:0.6b`，1024 维。I 全镇只有 1 份 synthetic 记忆，正式验证提供方后完成 rebuild、完整覆盖、真实 query 检索样例校验和 activate。随后正式 `exportResident(includeVectors:true)` 导出带源签名的居民小包，包含 1 份记忆、1 份向量及可携带的历史生成证据。J 使用正式 preflight、importBackup merge 和 prepareVectorReuse/advance 导入与复用，整个链路不连接 D/E。

## 实际结果

| 项目 | 实际通过结果 |
| --- | --- |
| 源签名与存储 | 正式导入保存的原包从存储读回后通过签名校验；源公钥在导入当时已被本地正式配对信任。 |
| 记忆与所有权 | 原文内容保持；world、player、global owner 和 memory 映射来自正式 import 结果，目的地所有权正确重映射。 |
| UNKNOWN 否定 | 自报权重的 custom 目的配置返回 REBUILD / NO_AUTHORIZED_PROVIDER_EVIDENCE，没有把自报字段当可信兼容证明。 |
| 可信正向复制 | 目的提供方重新取得真实服务证书；正式恢复任务 copied 为 1、skipped 为 0，向量精确相同，保留原 generationEvidenceId。 |
| 历史证书 | 导入证书为 REVOKED、checkedAt 为 0 的历史生成证据，并绑定源镇和源公钥；不获得当地服务权限。 |
| 当地服务证书 | 最新本地 ACTIVE 服务证书与导入历史证书分离，仍由独立提供方验证建立服务权限。 |
| 目的覆盖与激活 | J 全镇 1 份记忆、1 份目标空间向量完成 coverage、validation 和 activate；真实 query 检索验证完成 1 个样例。 |
| 激活后的复核 | 再次只读检查确认目标空间为 ACTIVE、验证任务 DONE、存储签名有效、向量仍精确相同，历史证据和当地服务证书仍分离。 |

空间激活只发生在新建的全 synthetic I/J。J 原身份、既有 embedding profiles 与既有居民绑定摘要保持一致；D/E 的原身份、端点、全局模型配置、活动空间和居民没有参与或被修改。正式 canonical import 的自动索引自然完成后才启动快照复制，没有清除任务或绕过门禁。

## 本次发现与修复

实际 `includeVectors:true` 导出暴露了审计字段转发错误：导出把额外的 includeVectors 字段传给不接受该字段的正式审计 mutation，导致 ArgumentValidationError。提交 `b7e6e14` 改为明确传递审计需要的字段；正式备份专项 52 项、运行时专项 29 项通过。修复部署后沿用同一份 synthetic 源数据和同一次验收恢复执行，完成上述正式导出与跨镇链路，没有重新初始化源镇或伪造导出结果。

## 信任与验证边界

服务证据依赖部署管理员精确授权的模型管理服务准确报告 metadata，且请求间不替换后恢复模型 tag；它不是第三方权重签名，也不是对任意不可信远端权重的证明。源签名与本地源公钥信任、目的服务证书、生成证据和 canonical 所有权/内容映射分别检查。

恢复任务在复制结束后保留 PENDING_VALIDATION 状态；后续正式空间 coverage、validation、activate 的通过由空间与验证任务独立证明，不把该恢复状态名称当作激活结果。

此证据覆盖 1 份记忆、1 份向量的正式居民小包跨镇链路。它不代表选择性或分块大包、异构模型切换、长期并发写入、故障回滚、浏览器导入或所有切换场景均已完成。主任务已将 I/J 重新部署为正式产品版本，并实际调用原 fixture 接口确认两边均已不存在，私有证明仅保留计数、哈希与固定结果；仓库不保存运行标识、所有者标识、服务端点、向量、记忆原文、签名包或凭据。
