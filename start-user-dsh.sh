#!/usr/bin/env bash
# 启动单个用户的 dsh 实例（独立 DSH_HOME + 端口，绑定 127.0.0.1）。
# 由 gateway.mjs 通过 spawn 调用：DSH_HOME 和 PORT 由环境变量传入。
# 数据天然隔离：每个用户的 settings/session/workspace 都在自己的 DSH_HOME 下。
set -e

export PATH=/opt/node-22.19.0/bin:$PATH
export npm_config_nodedir=/opt/node-22.19.0
export NODEJS_ORG_MIRROR=https://mirrors.tencent.com/nodejs-release/
export npm_config_registry=https://mirrors.tencent.com/npm/

# DSH_HOME / PORT 由调用方（gateway）通过环境变量注入
PORT="${PORT:-3081}"

DEPLOY_DIR=/root/.codebuddy/artifact/dsh-deploy
cd "$DEPLOY_DIR"

exec ./node_modules/.bin/dsh web --host 127.0.0.1 --port "$PORT"
