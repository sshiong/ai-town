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
- 用户指定的 Chat 模型 `claw` 已保存为 main 和现有居民显式绑定，密钥只存在本地后端环境。服务的
  `/v1/models` 当前只列出 `code`，请求 `claw` 返回 HTTP 400
  `model not supported`；未将其计为真实 Chat 对话验收，未静默改用其它模型。

浏览器截图在本地
`output/playwright/`，该目录不入仓库。凭据、测试数据库和证书保存在工作树外。自动测试覆盖持久账本、四类代数、幂等、乱序补发、回执拥堵、撤信、过期动作、冻结取消竞态、恢复安全等待、模型固定绑定、旧事实语义检索、Embedding 隔离与回滚。

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

- `npm test -- --runInBand`：13 个测试套件、126 个测试通过。
- `npm run build`：TypeScript 与生产构建通过；保留依赖 Browserslist 及 Pixi 主包体积提示。
- `npm run lint -- --quiet`：零 error；全仓仍有类型安全相关 warning，未将其声称为零 warning。
- 仓库内容扫描未发现用户提供的模型 API 密钥。

## 当前边界

- HTTP 始终 DISABLED；按设计第 31.4 节的安全回退交付 HTTPS。无 NAT 穿透、WSS 或 Relay。
- 普通备份不包含身份私钥；同镇恢复要求目标已有匹配身份及安全保存的服务器密钥。暂无独立加密身份灾备包。
- 备份受 5 MiB /
  500 条原子事务边界约束；超限明确拒绝。居民合并仅接受单世界源包。大镇分块归档、存储预算及冷归档管理尚未实现。
- 联调没有宣称公网拓扑、持续 30 天运行、大规模压力测试或所有 P1/P2 功能已经验收。长期记忆不进入 TTL 清理，旧事实检索由跨 60 天的自动测试验证。
