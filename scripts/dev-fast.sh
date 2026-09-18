#!/usr/bin/env bash
# 快速开发模式：前端改动即时热更新（HMR），无需重新 build。
#
# 原理：
#   - `vite` 起本地 dev server（localhost:3000），监听 src/ 下所有文件的变更并推 HMR
#   - `target/debug/ModelBoard` 在 debug 构建下把窗口指向 devUrl(http://localhost:3000)，
#     而不是打包进去的 dist/；因此前端改动保存即刷新，无需 cargo/tauri 重编。
#
# 何时仍然需要重新构建（只有改这些时才需要）：
#   - src-tauri/ 下的 Rust 代码 → 需 `pnpm tauri dev`（它会自动重编 Rust）
#   - 新增/删除前端入口文件（index.html / notify.html 等 rollup input）
#
# 用法：
#   ./scripts/dev-fast.sh        # 启动（幂等，重复执行只会补齐缺失的进程）
#   ./scripts/dev-fast.sh stop   # 停止 dev server 与 debug 应用

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VITE_LOG="/tmp/modelboard-vite.log"
APP_LOG="/tmp/modelboard-dev.log"
VITE_PATTERN="vite"
APP_BIN="src-tauri/target/debug/ModelBoard"

is_vite_up() {
  curl -s -o /dev/null --max-time 2 http://localhost:3000/
}

stop_all() {
  echo "→ 停止 debug 应用…"
  pkill -f "target/debug/ModelBoard" 2>/dev/null || true
  echo "→ 停止 vite dev server…"
  pkill -f "node.*vite" 2>/dev/null || true
  sleep 1
  echo "✓ 已停止"
}

if [[ "${1:-}" == "stop" ]]; then
  stop_all
  exit 0
fi

# ---- 1. 确保 debug 二进制存在 ----
if [[ ! -x "$APP_BIN" ]]; then
  echo "✗ 未找到 $APP_BIN"
  echo "  首次需要构建一次 debug 版（约几分钟，之后不再需要）："
  echo "    pnpm tauri build --debug --no-bundle"
  exit 1
fi

# ---- 2. 启动 vite dev server ----
if is_vite_up; then
  echo "✓ vite dev server 已在运行 (http://localhost:3000)"
else
  echo "→ 启动 vite dev server…"
  nohup pnpm dev:renderer > "$VITE_LOG" 2>&1 &
  for _ in $(seq 1 30); do
    is_vite_up && break
    sleep 0.5
  done
  if is_vite_up; then
    echo "✓ vite 就绪 (http://localhost:3000)，日志：$VITE_LOG"
  else
    echo "✗ vite 启动失败，请查看 $VITE_LOG"
    exit 1
  fi
fi

# ---- 3. 启动 debug 应用并连上 dev server ----
if pgrep -f "target/debug/ModelBoard" > /dev/null; then
  echo "✓ debug 应用已在运行"
else
  echo "→ 启动 debug 应用（连接 dev server）…"
  ( cd src-tauri && nohup ./target/debug/ModelBoard > "$APP_LOG" 2>&1 & )
  sleep 5
  if pgrep -f "target/debug/ModelBoard" > /dev/null; then
    echo "✓ debug 应用已启动，日志：$APP_LOG"
  else
    echo "✗ 应用启动失败，请查看 $APP_LOG"
    exit 1
  fi
fi

cat <<'EOF'

────────────── 快速开发模式就绪 ──────────────
改 src/ 下任意前端文件（tsx/ts/css/json）→ 保存即热更新，无需 build。

需要重新构建的情况：
  • 改了 src-tauri/ 的 Rust 代码 → 用 `pnpm tauri dev`
  • 改了前端入口 (index.html/notify.html) → 重新构建

停止：./scripts/dev-fast.sh stop
──────────────────────────────────────────────
EOF
