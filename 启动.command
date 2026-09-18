#!/bin/zsh
# ============================================================
# AgentMate 一键启动（双击运行）
# ------------------------------------------------------------
# 原理：双击 .command 由 Finder 启动，会打开真实 Terminal 窗口，
#       进程不受任何 AI 会话/沙箱限制，可长期常驻。
#
# 本脚本启动的是 release 自包含版：前端页面已嵌进二进制，
# **不需要 Vite**，关掉窗口才会退出。
# ============================================================
cd "$(dirname "$0")" || exit 1

APP="./src-tauri/target/release/AgentMate"
DEBUG_APP="./src-tauri/target/debug/AgentMate"

if [ ! -x "$APP" ]; then
  echo "✗ 找不到 release 可执行文件：$APP"
  echo
  echo "  请先构建（终端里执行）："
  echo "    export PATH=\"\$HOME/.cargo/bin:\$HOME/.nvm/versions/node/v22.23.2/bin:\$PATH\""
  echo "    cd $(pwd) && pnpm tauri build --no-bundle"
  echo
  echo "  按回车键退出..."
  read -r _
  exit 1
fi

# --- 清理残留实例 ---
# 应用自带单实例锁；但残留进程 + 立刻重启会撞上 SQLite journal 回滚，
# 报 "disk I/O error"。必须等旧进程真正消失再启动。
if pgrep -x AgentMate >/dev/null 2>&1; then
  echo "==> 发现已在运行的 AgentMate，正在退出旧实例..."
  pkill -TERM -x AgentMate 2>/dev/null
  for _ in $(seq 1 20); do
    pgrep -x AgentMate >/dev/null 2>&1 || break
    sleep 1
  done
  if pgrep -x AgentMate >/dev/null 2>&1; then
    echo "==> 仍未退出，强制结束"
    pkill -KILL -x AgentMate 2>/dev/null
    sleep 2
  fi
  echo "==> 旧实例已清理"
fi

echo "==> 启动 AgentMate（自包含模式，无需 Vite）"
echo "    可执行文件: $APP"
echo
echo "    ⚠ 请保持本终端窗口打开；关闭它应用会一起退出。"
echo

exec "$APP"
