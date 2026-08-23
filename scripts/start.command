#!/bin/zsh
set -e

PROJECT_DIR="${0:A:h:h}"
cd "$PROJECT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "需要先安装 Node.js 22 或更高版本。"
  read -k 1 "?按任意键关闭…"
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "首次启动，正在安装本地依赖…"
  npm install
fi

echo "JobDeck 正在启动，关闭本窗口即可停止服务。"
npm start &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT INT TERM

for attempt in {1..40}; do
  if curl -fsS "http://127.0.0.1:43120/api/health" >/dev/null 2>&1; then
    open "http://127.0.0.1:43120"
    break
  fi
  sleep 0.1
done

wait $SERVER_PID
