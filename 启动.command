#!/bin/zsh
# 双击启动「局域网互传」。关闭这个终端窗口即停止服务。
cd "$(dirname "$0")" || exit 1

NODE_BIN=""
for c in \
  "$HOME/.workbuddy/binaries/node/versions/22.22.2-6/bin/node" \
  "$(command -v node 2>/dev/null)" \
  /usr/local/bin/node \
  /opt/homebrew/bin/node
do
  if [ -n "$c" ] && [ -x "$c" ]; then NODE_BIN="$c"; break; fi
done

if [ -z "$NODE_BIN" ]; then
  echo "没找到 Node.js，请先安装 Node：https://nodejs.org"
  read -r "?按回车关闭…"
  exit 1
fi

( sleep 1; open "http://localhost:${PORT:-8788}" ) >/dev/null 2>&1 &
exec "$NODE_BIN" server.js
