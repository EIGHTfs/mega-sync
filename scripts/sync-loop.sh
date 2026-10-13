#!/bin/bash
# ============================================================
# sync-loop.sh —— 反复跑 mega-sync，直到同步完成
#
# 为什么需要它：MEGA 免费号按 IP 每 6 小时限一次传输量。撞限额时 mega-sync 以
# 退出码 3 结束（已下进度保留在 .part），本脚本等一个窗口后自动接着下。
# 这样「每次只能下一部分」的大目录，挂着就能自己下完，不用人守着。
#
# 用法：
#   ./sync-loop.sh --link "https://mega.nz/folder/xxxx#key" --dest /path/to/dir
#   ./sync-loop.sh --remote "/某文件夹" --dest /path/to/dir
#   ./sync-loop.sh --link "..." --dryrun        # 只看计划，看完直接退出
#
# 环境变量：
#   MEGA_SYNC_BIN    mega-sync 命令（默认找 PATH 里的 mega-sync，否则用本仓库的 bin）
#   MEGA_QUOTA_WAIT  撞配额后的等待秒数（默认 1800 = 30 分钟）
#   MEGA_ERR_WAIT    其它错误的退避秒数（默认 300）
#
# 常驻后台（关掉终端也不停）：
#   setsid nohup ./sync-loop.sh --remote / --dest /path/to/dir >> loop.log 2>&1 < /dev/null &
# ============================================================
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
QUOTA_WAIT="${MEGA_QUOTA_WAIT:-1800}"
ERR_WAIT="${MEGA_ERR_WAIT:-300}"

if [ -z "${MEGA_SYNC_BIN:-}" ]; then
  if command -v mega-sync >/dev/null 2>&1; then
    MEGA_SYNC_BIN="mega-sync"
  else
    MEGA_SYNC_BIN="node ${DIR}/../bin/mega-sync.js"
  fi
fi

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
      echo "[loop] 撞 MEGA 配额，等 $((QUOTA_WAIT / 60)) 分钟后继续（进度已保留在 .part）"
      sleep "$QUOTA_WAIT"
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
