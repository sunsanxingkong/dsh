# dsh-multiuser

让 [DeepSeek Harness (dsh)](https://github.com/sunsanxingkong/deepseek-harness) 支持多用户的轻量二次开发方案。

dsh 本身是单租户、无认证的 agent harness。本项目通过「认证门户 + 每用户独立 dsh 进程」实现多用户隔离：

```
浏览器 ──▶ [多用户门户 gateway.mjs] ──▶ 用户 A 的 dsh 实例 (DSH_HOME=~/.dsh/users/<A>)
          (登录/注册 + 反向代理)         ──▶ 用户 B 的 dsh 实例 (DSH_HOME=~/.dsh/users/<B>)
                                        ──▶ ...
```

## 特性

- **用户名 + 密码认证**：scrypt 密码哈希、httpOnly cookie 会话（7 天）。
- **每用户独立实例**：每人独立 `DSH_HOME`，聊天记录 / API key / 工作区 / 设置天然隔离。
- **懒启动**：用户首次访问时才启动其 dsh 实例，端口映射持久化复用。
- **反向代理**：HTTP + WebSocket 全转发，清掉 Origin/Sec-Fetch-* 等宿主头，避免 dsh 同源校验误拒。
- **修改密码**：登录页入口 + `auth.changePassword` API。

## 快速开始

### 前置

- Node.js >= 22.19.0（依赖 `@earendil-works/pi-ai` 的要求）
- 已安装 `@deepseek-ai/dsh`（`npm i @deepseek-ai/dsh@0.1.0-rc.6`）

### 1. 启动门户

```bash
bash start-gateway.sh
# 默认监听 127.0.0.1:3000，可用 GATEWAY_PORT 覆盖
```

首次启动自动创建默认管理员 `admin / admin123`（**请立即通过登录页「修改密码」更换**）。

### 2. 访问

- 本地：`http://127.0.0.1:3000`（未登录会跳到 `/login.html`）
- 对外：用任意反向代理 / 隧道把 3000 端口暴露出去（如平台的「发布为应用」）

### 3. 用户实例

- 实例由门户自动懒启动，无需手动管理。
- 启动命令：`DSH_HOME=~/.dsh/users/<userId> PORT=<port> bash start-user-dsh.sh`
- 端口映射持久化在 `~/.dsh/gateway/instances.json`。

## 关键文件

| 文件 | 说明 |
|---|---|
| `gateway.mjs` | 门户核心（认证 + 用户管理 + 实例懒启动 + 反向代理 + WebSocket） |
| `auth.mjs` | 认证模块（用户存储、scrypt 哈希、会话、AsyncLocalStorage 用户上下文） |
| `login.html` / `change-password.html` | 登录页 / 修改密码页 |
| `start-gateway.sh` / `start-user-dsh.sh` | 门户 / 单用户实例启动脚本 |
| `docs/MULTIUSER.md` | 详细架构与使用说明 |

## 文件访问限制（安全边界）

dsh 自身的沙箱**限制写、不限制读**：

- **写限制（默认已生效）**：`workspace-write` 模式下，agent 的 bash/文件操作只能写「会话工作区 + /tmp」，
  无法修改 dsh 配置、其他用户数据等敏感文件。
- **读限制（默认不限制）**：dsh 沙箱源码明确 "Reads pass through untouched"，agent 仍能 `cat`
  任意路径（包括 `~/.dsh/users/<其他用户>/settings.yaml` 里的 key）。

因此本项目适用于**可信用户之间**的多租户（防误改、防串数据）。
