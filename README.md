# mega-sync

把 **MEGA 网盘**或**公开分享链接**的内容做**拉取式同步**到本地目录。

为「MEGA 免费号按 IP 每 6 小时限一次传输量」的现实设计：**断点续传 + 撞配额自动等窗口续下**，
挂着一个循环就能自己把大目录下完，不用人守着。

## 特性

- 三种入口：公开分享链接（`--link`，免登录）/ 自己云盘路径（`--remote`，需登录）/ 只登录（`--login`）
- `--dryrun` 先看计划：**待下几个 / 已存在几个**，不写任何文件
- **断点续传**：下载写入 `<文件>.part`，中断后从已下字节继续（MEGA 支持按字节区间下载）
- **配额退避**：撞限额时以退出码 `3` 结束，`scripts/sync-loop.sh` 等一个窗口后自动接着下
- **拉取式**：只下缺的，**不删除本地文件**（安全，可反复跑）
- 支持代理（`http://` / `socks5://`），并可持久化登录会话

## 安装

```bash
npm install -g mega-sync
# 或免安装直接用
npx mega-sync --help
```

要求 Node.js ≥ 20。

## 快速开始

```bash
# ① 只登录一次（会话存 ./.mega-sync/session.json，权限 0600；之后不用再输密码）
mega-sync --login

# ② 先看计划（不写文件）
mega-sync --remote / --dest ./MEGA --dryrun
mega-sync --link "https://mega.nz/folder/xxxxxxxx#xxxxxxxx" --dest ./MEGA --dryrun

# ③ 正式同步
mega-sync --remote / --dest ./MEGA

# ④ 推荐：挂着循环跑（撞配额自动等窗口续下；关掉终端也不停）
setsid nohup ./scripts/sync-loop.sh --remote / --dest ./MEGA >> loop.log 2>&1 < /dev/null &
```

## 命令行选项

| 选项 | 说明 |
|---|---|
| `--link <url>` | 公开分享链接（文件或文件夹），**不需要登录** |
| `--remote <path>` | 云盘路径，默认 `/`（整个云盘），需要登录 |
| `--dest <dir>` | 目标目录，默认 `./MEGA` |
| `--dryrun` | 只打印计划，不写任何文件 |
| `--login` | 只登录并保存会话 |
| `--proxy <url>` | 代理，如 `http://127.0.0.1:7890` / `socks5://127.0.0.1:1080` |
| `--state <dir>` | 状态目录（会话 + 日志），默认 `./.mega-sync` |
| `--config <file>` | 配置文件，默认 `./mega-sync.config.json` |
| `-h, --help` / `-v, --version` | 帮助 / 版本 |

## 配置

优先级：**命令行 > 环境变量 > 配置文件**。

配置文件（默认当前目录的 `mega-sync.config.json`，含密码时建议 `chmod 600`）：

```json
{
  "email": "you@example.com",
  "password": "your-password",
  "proxy": "http://127.0.0.1:7890",
  "dest": "/path/to/MEGA",
  "remote": "/",
  "link": ""
}
```

环境变量：`MEGA_EMAIL`、`MEGA_PASSWORD`、`MEGA_PROXY`、`MEGA_DEST`、`MEGA_SYNC_STATE`、`MEGA_SYNC_CONFIG`。

## 断点续传与配额

- 每个文件下载到 `<文件>.part`；中断（Ctrl-C、断网、关机、撞配额）后重跑会**从已下字节继续**
- 已存在的文件按**名字 + 大小**判定，命中即跳过（不重下、不覆盖）
- 撞限额 → 退出码 `3` → `sync-loop.sh` 等待（默认 30 分钟）后重跑
- 其它错误 → 退避（默认 5 分钟）重试；配置错误（退出码 `2`）不重试

MEGA 官方对**非付费账号**的说明（[help.mega.io](https://help.mega.io/plans-storage/space-storage/transfer-quota)）：
传输额度按 **IP** 每 6 小时滚动计算，撞上后只能等窗口恢复或升级账号。
因此大目录用免费号同步，天然需要「下一部分 → 等窗口 → 接着下」——这正是本工具 + 循环脚本做的事。

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 完成 |
| 1 | 有文件失败 |
| 2 | 配置问题（不重试） |
| 3 | 撞配额/限流（等窗口后重跑） |

## 代理

若所在网络无法直连 MEGA：

```bash
mega-sync --remote / --proxy http://127.0.0.1:7890
```

注意：走代理时**配额按代理出口 IP 计算**；共享代理的额度可能被同一出口的其他人消耗。

## 已知限制

- 续传时 megajs 会关闭整文件 MAC 校验（分块续传的固有限制），本项目以「最终大小严格比对」兜底：
  大小不符则保留 `.part`，下次继续
- **单向拉取**（远端 → 本地）：不做双向同步，也不会删除本地文件
- 单文件串行下载（不并发），避免触发风控

## 开发

```bash
npm install
npm test        # 离线自检：参数解析/配置优先级/计划判定/配额识别（不联网）
```

## 许可证

[MIT](LICENSE)
