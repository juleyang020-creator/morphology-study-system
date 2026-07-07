#!/bin/bash
# Mac 启动器：启动本地静态服务器（让 Service Worker 生效），再打开浏览器。
# 之前直接 `open index.html` 走 file:// 协议，SW 在 file:// 下不注册，离线缓存完全失效。
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR" || exit 1

# 找一个可用端口（8000 起，避开常用端口）
PORT=8765
while lsof -i :$PORT >/dev/null 2>&1; do
  PORT=$((PORT + 1))
done

# 优先用 Python（macOS 自带），回退到 Node
if command -v python3 >/dev/null 2>&1; then
  SERVER="python3 -m http.server $PORT --bind 127.0.0.1"
elif command -v python >/dev/null 2>&1; then
  SERVER="python -m SimpleHTTPServer $PORT"
elif command -v npx >/dev/null 2>&1; then
  SERVER="npx -y serve -l $PORT"
else
  echo "未找到 python3 / python / npx，回退为直接打开 file://（离线缓存将不可用）。"
  open "$DIR/index.html"
  exit 0
fi

echo "启动本地服务器：http://127.0.0.1:$PORT/"
echo "（按 Ctrl+C 关闭）"
( sleep 1.2 && open "http://127.0.0.1:$PORT/index.html" ) &
exec $SERVER
