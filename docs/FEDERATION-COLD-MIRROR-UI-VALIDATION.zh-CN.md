# 外部冷归档镜像浏览器验收（2026-10-11）

冻结的当前前端通过本地 Vite 5291 连接隔离 E 的真实 Convex API 3250，并使用正式 MinIO 存储完成界面操作。按已完成 S3 验收报告中的精确 archive ID 选择该次运行的合成 v2 原件（4 条消息、2 个数据部分），未凭重复时间标签猜选，也未操作居民聊天、身份或模型配置。

- 应用服务器配置成功，目标恢复为未经验证，创建副本按钮禁用；真实上传/读回验证成功后，目标显示已验证，允许创建。
- 新建任务逐次显示 0/3、1/3、2/3；数据部分完成后按钮改为上传并验证归档根文件。第三次推进后显示已完成 3/3、4086 已验证字节及本地原件保留提示，推进和取消按钮禁用。
- 另建新任务，推进到 1/3、1671 已验证字节后取消成功，显示已取消，推进和取消按钮禁用。未删除本地原件或远端对象。
- 操作前后 API 对比：原有两条 COMPLETE/CANCELLED 任务逐字段完全不变；已验证归档分页元数据完全不变。新增两条任务分别为 COMPLETE、CANCELLED。
- 中英文标签、状态及操作按钮可切换；操作人输入上限 100 字符。1440px 面板与 390px 窄屏对话框均无横向溢出，沿用现有像素字体、边框和颜色。
- 浏览器控制台为 0 errors、22 条预存 warnings，来源为 Pixi 纹理缓存/弃用提示和 Plausible 的 localhost 排除；此次冷存储操作未增加错误或修改地图。

语言边界：已完成的成功提示保留执行操作时的语言，切换语言不会重新翻译该段已缓存提示；即时切换后也曾观察到日期保留上一语言格式。重新打开数据页后，日期、终态状态和控件按当前语言显示。本次记录该边界，未修改冻结业务代码。

本地证据位于工作区 `output/playwright/`（无令牌、私有凭据或消息正文）：

- `cold-archive-browser-mutation-proof.json`：新任务状态、字节数及原有任务/归档元数据不变的摘要。
- `cold-archive-zh-root-next.png`、`cold-archive-zh-complete.png`、`cold-archive-zh-cancelled.png`：中文根文件待上传、完成及取消终态。
- `cold-archive-en-cancelled.png`：重新打开后的英文取消终态。
- `cold-archive-readonly-proof.json`、`cold-archive-en-readonly.png`、`cold-archive-zh-readonly.png`、`cold-archive-zh-narrow-top.png`、`cold-archive-zh-narrow-bottom.png`：只读门禁、双语及窄屏证据。

这是实际浏览器、Convex action/mutation 与 MinIO 的界面验收，未用模拟 S3 响应替代此次上传。本次不覆盖 Convex 服务器重启续作；存储服务停机及恢复重试证据见正式 S3 验收记录。
