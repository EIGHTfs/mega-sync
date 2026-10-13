#!/bin/bash
# ============================================================
# sync-loop.sh —— 反复跑 mega-sync，直到同步完成
#
# 为什么需要它：MEGA 免费号按 IP 每 6 小时限一次传输量。撞限额时 mega-sync 以
# 退出码 3 结束（已下进度保留在 .part），本脚本按平台给出的恢复时间等待后接着下。
#
# 退出码约定（与 mega-sync 对齐）：
#   0 = 全部完成      → 结束
#   3 = 撞配额/限流   → 读 .wait-seconds（平台给的恢复秒数）等待后重试
#   4 = 账号被封锁    → **停止重试**（反复登录会加重限制，必须人工处理）
#   2 = 配置问题      → 不重试
#   其它              → 退避后重试
#
# 用法：
#   ./sync-loop.sh --link "https://mega.nz/folder/xxxx#key" --dest /path/to/dir
#   ./sync-loop.sh --remote "/某文件夹" --dest /path/to/dir
#   ./sync-loop.sh --link "..." --dryrun        # 只看计划，看完直接退出
#
# 环境变量：
#   MEGA_SYNC_BIN     mega-sync 命令（默认找 PATH 里的 mega-sync，否则用本仓库的 bin）
#   MEGA_SYNC_STATE   状态目录（与 mega-sync 一致，默认 ./.mega-sync；用于读 .wait-seconds）
#   MEGA_QUOTA_WAIT   撞配额后的兜底等待秒数（默认 1800；平台给了恢复时间则优先用它）
#   MEGA_ERR_WAIT     其它错误的退避秒数（默认 300）
#
# 常驻后台（关掉终端也不停）：
#   setsid nohup ./sync-loop.sh --remote / --dest /path/to/dir >> loop.log 2>&1 < /dev/null &
# ============================================================
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
QUOTA_WAIT="${MEGA_QUOTA_WAIT:-1800}"
ERR_WAIT="${MEGA_ERR_WAIT:-300}"
STATE_DIR="${MEGA_SYNC_STATE:-.mega-sync}"
LOCK="$DIR/.sync-loop.pid"

if [ -z "${MEGA_SYNC_BIN:-}" ]; then
  if command -v mega-sync >/dev/null 2>&1; then
    MEGA_SYNC_BIN="mega-sync"
  else
    MEGA_SYNC_BIN="node ${DIR}/../bin/mega-sync.js"
  fi
fi

# 防重复实例：同时跑两个 loop 会把登录/请求次数成倍放大（实测发生过）
if [ -f "$LOCK" ]; then
  old="$(cat "$LOCK" 2>/dev/null || echo "")"
  if [ -n "$old" ] && [ -d "/proc/$old" ] && tr '\0' ' ' < "/proc/$old/cmdline" 2>/dev/null | grep -q "sync-loop"; then
    echo "[loop] 已有实例在运行（PID $old），本次退出"
    exit 0
  fi
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

round=0
while true; do
  round=$((round + 1))
  echo "[loop] === 第 $round 轮 $(date '+%F %T') ==="
  # 故意不加引号：MEGA_SYNC_BIN 可能是 "node /path/bin.js" 这种形式
  # shellcheck disable=SC2086
  $MEGA_SYNC_BIN "$@"
  code=$?
  case "$code" in
    0)
      echo "[loop] 全部完成（第 $round 轮）"
      exit 0
      ;;
    3)
      # 优先用平台自己给出的恢复时间（mega-sync 写进 <状态目录>/.wait-seconds）
      wait="$QUOTA_WAIT"
      if [ -f "$STATE_DIR/.wait-seconds" ]; then
        got="$(cat "$STATE_DIR/.wait-seconds" 2>/dev/null || echo "")"
        case "$got" in ''|*[!0-9]*) ;; *) wait="$got" ;; esac
      fi
      echo "[loop] 撞配额，等 $((wait / 60)) 分钟后继续（进度已保留在 .part）"
      sleep "$wait"
      ;;
    4)
      echo "[loop] 账号被平台封锁/限制 —— 停止重试（反复登录会加重限制）"
      echo "[loop] 请人工处理：登录平台网页看提示、查注册邮箱通知、必要时申诉；解封后再重跑本脚本"
      exit 4
      ;;
    2)
      echo "[loop] 配置问题（退出码 2），不重试"
      exit 2
      ;;
    *)
      echo "[loop] 出错（退出码 $code），等 $((ERR_WAIT / 60)) 分钟后重试"
      sleep "$ERR_WAIT"
      ;;
  esac
done
