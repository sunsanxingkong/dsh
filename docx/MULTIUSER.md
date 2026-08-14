# dsh 多用户部署说明（认证门户 + 每用户独立实例）

## 架构

```
浏览器 ──▶ [多用户门户 gateway.mjs] ──▶ 用户 A 的 dsh 实例 (DSH_HOME=~/.dsh/users/<A>, 端口 3081)
          (登录/注册 + 反向代理)        ──▶ 用户 B 的 dsh 实例 (DSH_HOME=~/.dsh/users/<B>, 端口 3082)
                                        ──▶ ...
```

- **门户**（`gateway.mjs`，端口 3000）：用户名+密码登录、会话 cookie、为每个用户懒启动独立 dsh 实例、反向代理路由。
- **每用户独立 dsh 进程**：独立 `DSH_HOME`（`~/.dsh/users/<userId>`）+ 独立端口（3081 起递增），
  聊天记录、API key、工作区、设置在各自的 DSH_HOME 下，**天然完全隔离**。
- dsh 实例绑定 `127.0.0.1`，只被门户（loopback）访问，**不对外暴露**。

