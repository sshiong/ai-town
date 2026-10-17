# 同身份恢复前的离线预检

普通 RAW 数据备份不含私钥。同身份恢复或迁移需要另行通过管理面板导出加密身份包，并保存其口令。

```sh
node scripts/federation-recovery-preflight.mjs \
  --identity /private/path/encrypted-identity.json \
  --passphrase-file /private/path/passphrase.txt \
  --archive /private/path/town-archive.json
```

`--archive` 接受原始 RAW 分块 manifest 包或完整的 v1 单文件 bundle。口令文件必须属于当前用户，且不允许组或其他用户访问（例如 `chmod 600`）。不要把口令放在命令参数、仓库或日志里；身份包和口令应分开保管。

预检验证身份包及原始 manifest 的签名、townId/公钥/指纹/源 epoch 的一致性、AES-GCM 解密和私钥签名挑战。输出只有计数、时间及检查结果，不输出私钥、口令、密文或聊天内容；错误也不回显输入。输入文件有大小限制，口令文件不允许符号链接。

成功结果不代表数据块内容完整、备份包含最新数据、源实例已停止或目标已经可激活。工具不校验每块内容、不修改小镇、不创建目标身份、不签署交接。正式导入仍须执行其完整预检、审阅和应用流程。

同身份迁移必须保留源实例并通过正式流程完成：冻结源端及清理旅行，暂停模拟并取得一致的新数据备份，停止源端后在空目标恢复加密身份，再以 `migrate` 导入匹配数据；目标 `prepareTarget` 后，由冻结源端 `signHandoff`，再目标 `activateTarget`、逐邻居 `notifyPeer` 及双向探针。为签署交接临时启动源后端时，必须保持 `MIGRATING_OUT` 且模拟停止。

冻结前可以保留原运行环境；冻结或签署交接后不能把旧实例直接恢复为 ACTIVE 作为回滚。尤其不能在新目标已接受交接后启动旧副本承担同一身份的权威。失败目标保持禁用，保留源库、备份及回执，按所处阶段恢复操作；不要手改 mode、epoch 或复制通信凭证绕过正式交接。独立 clone 拥有新身份，不能用作原身份迁移的空目标。
