#!/usr/bin/env bash
# 启动 dsh 多用户门户（gateway）。
# 门户负责：登录/注册认证 + 为每个用户启动独立 dsh 实例 + 反向代理路由。
set -e
export PATH=/opt/node-22.19.0/bin:$PATH
export npm_config_registry=https://mirrors.tencent.com/npm/
exec node /workspace/dsh-auth/gateway.mjs
