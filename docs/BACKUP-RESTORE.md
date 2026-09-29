# 备份、校验与隔离恢复

备份包含数据库、作品、素材、任务恢复副本、会话、模型和 `.env` 主密钥，属于敏感文件。只保存在私密目录，不上传公开仓库或附到问题报告。工具不输出主密钥或连接凭据。

## 创建一致性备份

工具用于文档约定的 Linux Docker Compose bind-mount 布局：`data/`、`models/`、`postgres/`、`.env`、`compose.yaml`。使用 Node 和 GNU tar；不支持替代卷布局时会拒绝执行，不生成不完整备份。

先在维护窗口完成或停止执行任务，停止 studio 和 speech，保留 postgres 运行，同时暂停所有外部编辑器/同步脚本。工具不会替用户停止任何服务，也不会自动恢复服务。即使 studio 已停止，任务容器仍可能运行，工具会再次检查并拒绝热备份。

```sh
# 在部署目录操作，确认运行任务已经处理完毕后：
docker compose stop studio speech
# 在平台代码目录执行；out 的父目录须已存在，目标目录必须不存在：
pnpm backup create --stack /opt/stacks/frame --out /private-backups/frame-before-upgrade
pnpm backup verify --backup /private-backups/frame-before-upgrade
```

数据库使用 `pg_dump -Fc`，不会直接复制在线 PostgreSQL 物理目录。源码、素材、模型和密钥放入 `files.tar.gz`；`manifest.json` 保存时间、镜像标签、大小和 SHA-256。只有所有步骤完成且再次确认写入端已停止才生成清单。失败留下的半成品没有有效清单，不算成功备份。备份源含符号链接目录、目标实际落在源数据内、已有同名目标时均拒绝。

校验命令只证明备份文件与清单一致，不证明数据库能恢复，也不证明主密钥与加密凭据匹配。镜像标签也不是不可变镜像摘要；发布时仍应保留已核对的镜像 digest。

## 恢复演练

仅对自己创建且校验通过的备份操作。使用新的私密目录和全新的测试容器，不向现有生产目录解包，不在生产数据库执行 `pg_restore`。不要直接启动复制出来的 Compose：其中域名、项目名和宿主机路径可能仍指向生产。

```sh
BACKUP=/private-backups/frame-before-upgrade
RESTORE=/private-restore/frame-review
umask 077
mkdir -m 700 "$RESTORE"  # 已存在时停止，换一个全新目录。
tar --extract --gzip --file "$BACKUP/files.tar.gz" --directory "$RESTORE"
chmod 600 "$RESTORE/.env"

# 使用仅供本次恢复演练的 URL-safe 密码，不复用生产密码。
read -rsp '恢复测试数据库密码: ' POSTGRES_PASSWORD; echo
export POSTGRES_PASSWORD
DRILL=frame-restore-$(node -p "require('node:crypto').randomUUID()")
docker run -d --name "$DRILL" -p 127.0.0.1:55439:5432 \
  -e POSTGRES_USER=frame -e POSTGRES_DB=frame_test_restore -e POSTGRES_PASSWORD \
  -v "$DRILL:/var/lib/postgresql" postgres:18-alpine
# 等 pg_isready 确认就绪；端口冲突时使用另一空闲端口，不结束其他服务。
docker exec "$DRILL" pg_isready -U frame -d frame_test_restore
docker exec -i "$DRILL" pg_restore --exit-on-error --single-transaction --no-owner \
  -U frame -d frame_test_restore < "$BACKUP/database.dump"

# 以下命令从平台代码目录执行，地址中的端口与上方一致：
export FRAME_RESTORE_DATABASE_URL="postgres://frame:$POSTGRES_PASSWORD@127.0.0.1:55439/frame_test_restore"
pnpm restore:check --data "$RESTORE/data" --env "$RESTORE/.env"
```

`restore:check` 只允许名称包含 `frame_test_restore` 的恢复库，事务强制只读。它检查每份素材的内容哈希和大小、作品入口、迁移版本，以及恢复出来的主密钥能否解密模型/GitHub/语音配置。没有版本表的旧备份也可只读检查，会明确返回 `schemaVersioned:false`，不会偷偷执行迁移。它不会连接外部模型、合成语音、调用收费 API、写入作品或启动调度器。

完成后还需在不影响生产的环境实际打开作品、生成预览、播放音轨并导出；官方登录凭据的有效性另行人工确认。文件和数据库检查不能代替这些操作。清理仅针对本次生成的 `$DRILL` 容器、同名卷和新恢复目录；先确认保留诊断资料，不删除原备份或生产目录。

## 正式恢复与回退

正式切换前停止全部写入，保留当前状态，校验备份；在新栈目录恢复数据，并同步恢复原主密钥及对应版本镜像。修改恢复栈 `.env` 的 `FRAME_HOST_DATA` 为新 data 目录的宿主机绝对路径，容器内仍保持 `/data`，避免破坏 Git worktree 引用。先完成隔离验收，再切换反向代理。数据库不兼容回退须连同数据库与文件备份回退，不能仅换旧镜像。

备份创建、数据库恢复、凭据解密及恢复后播放/导出演练必须实际执行后才能记录为通过，不能以工具存在或语法检查代替。
