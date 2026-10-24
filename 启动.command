#!/bin/zsh
# 双击启动「XiaoMao 互传」。关闭这个终端窗口即停止服务。
# Windows 请用同目录下的「启动.bat」。
cd "$(dirname "$0")" || exit 1

NODE_BIN=""
for c in \
  "$(command -v node 2>/dev/null)" \
  "$HOME/.workbuddy/binaries/node/versions/22.22.2-6/bin/node" \
  /usr/local/bin/node \
  /opt/homebrew/bin/node
do
  if [ -n "$c" ] && [ -x "$c" ]; then NODE_BIN="$c"; break; fi
done

if [ -z "$NODE_BIN" ]; then
  echo "没找到 Node.js，请先安装：https://nodejs.org"
  read -r "?按回车关闭…"
  exit 1
fi

exec "$NODE_BIN" server.js --open
