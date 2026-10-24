#!/bin/zsh
# 双击停止「XiaoMao 互传」
PIDS=$(lsof -ti tcp:6767 2>/dev/null)
if [ -z "$PIDS" ]; then
  echo "服务没有在运行。"
else
  echo "$PIDS" | xargs kill 2>/dev/null
  echo "已停止。"
fi
sleep 1
