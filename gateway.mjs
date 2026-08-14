// dsh 多用户门户（gateway.mjs）
//
// 架构：一个门户进程（认证 + 路由）+ 每用户一个独立 dsh 进程（独立 DSH_HOME + 端口）。
// 每个用户的聊天记录、API key、工作区、设置都在各自的 DSH_HOME 下，天然完全隔离。
//
// 门户职责：
//   1. 登录/注册/登出（用户名+密码，scrypt 哈希，httpOnly cookie 会话）
//   2. 为每个用户 lazily 启动独立 dsh 实例（DSH_HOME=~/.dsh/users/<userId>，端口 3081+）
//   3. 反向代理：登录后把请求转发到对应用户的 dsh 实例；未登录 401
//
// 运行：node gateway.mjs  （默认监听 127.0.0.1:3000）

import http from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { readFile } from "node:fs/promises";

// ---------------- 配置 ----------------
const GATEWAY_HOST = "127.0.0.1";
const GATEWAY_PORT = Number(process.env.GATEWAY_PORT ?? 3000);
const GATEWAY_HOME = process.env.GATEWAY_HOME ?? join(process.env.HOME ?? "/root", ".dsh", "gateway");
const DSH_BASE_HOME = process.env.DSH_BASE_HOME ?? join(process.env.HOME ?? "/root", ".dsh", "users");
const DSH_PORT_BASE = Number(process.env.DSH_PORT_BASE ?? 3081);
const DEPLOY_DIR = "/root/.codebuddy/artifact/dsh-deploy";
const SESSION_COOKIE = "dsh_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------- 用户存储 ----------------
const usersFile = join(GATEWAY_HOME, "users.json");
const instancesFile = join(GATEWAY_HOME, "instances.json");
const users = new Map(); // username -> { id, username, password, role, createdAt }
const sessions = new Map(); // token -> { userId, username, createdAt }
const instances = new Map(); // userId -> { port } （持久化端口映射）

mkdirSync(GATEWAY_HOME, { recursive: true });

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(password, stored) {
  const parts = String(stored).split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, hashHex] = parts;
  const test = scryptSync(password, salt, 64);
  const expected = Buffer.from(hashHex, "hex");
  return test.length === expected.length && timingSafeEqual(test, expected);
}
function loadUsers() {
  if (existsSync(usersFile)) {
    try {
      for (const u of JSON.parse(readFileSync(usersFile, "utf-8")).users ?? []) users.set(u.username, u);
    } catch {}
  }
}
function saveUsers() {
  writeFileSync(usersFile, JSON.stringify({ users: [...users.values()] }, null, 2));
}
function loadInstances() {
  if (existsSync(instancesFile)) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(readFileSync(instancesFile, "utf-8")))) instances.set(k, v);
    } catch {}
  }
}
function saveInstances() {
  writeFileSync(instancesFile, JSON.stringify(Object.fromEntries(instances)), null, 2);
}
function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role ?? "user", createdAt: u.createdAt };
}
function resolveSession(req) {
  const c = req.headers.cookie;
  if (!c) return null;
  const token = c.split(";").map((s) => s.trim()).find((s) => s.startsWith(SESSION_COOKIE + "="))?.slice(SESSION_COOKIE.length + 1);
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) { sessions.delete(token); return null; }
  return s;
}
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(body);
}
function rpc(res, rpcId, ok, valueOrError) {
  return ok
    ? { type: "server-response", rpcId, result: { ok: true, value: valueOrError } }
    : { type: "server-response", rpcId, result: { ok: false, error: valueOrError } };
}

// ---------------- dsh 实例管理 ----------------
function allocatePort(userId) {
  if (instances.has(userId)) return instances.get(userId).port;
  const used = new Set([...instances.values()].map((v) => v.port));
  let port = DSH_PORT_BASE;
  while (used.has(port)) port++;
  instances.set(userId, { port });
  saveInstances();
  return port;
}
function dshHomeFor(userId) {
  return join(DSH_BASE_HOME, userId);
}
async function ensureInstance(userId) {
  const port = allocatePort(userId);
  const home = dshHomeFor(userId);
  mkdirSync(home, { recursive: true });
  // 检查是否已监听该端口（实例已启动）
  const alive = await isPortListening(port);
  if (alive) return { port, home };
  // 启动实例
  const logPath = join(GATEWAY_HOME, `dsh-${userId}.log`);
  const out = openLog(logPath);
  const child = spawn("bash", ["/workspace/start-user-dsh.sh", home, String(port)], {
    cwd: DEPLOY_DIR,
    env: { ...process.env, DSH_HOME: home, PORT: String(port) },
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  // 等待端口就绪
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isPortListening(port)) return { port, home };
  }
  throw new Error(`dsh 实例启动超时 (${userId}, port ${port})`);
}
function openLog(path) {
  try { return openSync(path, "a"); } catch { return "ignore"; }
}
function isPortListening(port) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/", method: "GET", timeout: 800 }, (res) => {
      res.resume(); resolve(true);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// ---------------- 反向代理 ----------------
// ---------------- 反向代理 ----------------
// 关键：透传浏览器请求时必须清掉 Origin / sec-fetch-site 等与宿主相关的头，
// 否则 dsh 实例的 isTrustedApiRequest 会因 Origin.host 与 Host:127.0.0.1 不一致而 403。
// （门户对外是平台域名，对内是 127.0.0.1，浏览器会自动加 Origin: <平台域名>。）
function proxy(req, res, targetPort) {
  const headers = { ...req.headers, host: `127.0.0.1:${targetPort}` };
  delete headers.origin;
  delete headers.referer;
  delete headers["sec-fetch-site"];
  delete headers["sec-fetch-mode"];
  delete headers["sec-fetch-dest"];
  const options = {
    host: "127.0.0.1",
    port: targetPort,
    method: req.method,
    path: req.url,
    headers,
  };
  const preq = http.request(options, (pres) => {
    res.writeHead(pres.statusCode, pres.headers);
    pres.pipe(res);
  });
  preq.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end("bad gateway");
  });
  req.pipe(preq);
}

// ---------------- 认证 API ----------------
async function handleAuth(req, res, method, body) {
  const rpcId = body?.rpcId ?? "auth";
  const payload = body?.payload ?? {};

  if (method === "auth.register") {
    const username = String(payload.username ?? "").trim();
    const password = String(payload.password ?? "");
    if (!/^[a-zA-Z0-9_.-]{2,32}$/.test(username)) return sendJson(res, 200, rpc(res, rpcId, false, { code: "invalid-username", message: "用户名需为 2-32 位字母/数字/_.-" }));
    if (password.length < 6) return sendJson(res, 200, rpc(res, rpcId, false, { code: "weak-password", message: "密码至少 6 位" }));
    if (users.has(username)) return sendJson(res, 200, rpc(res, rpcId, false, { code: "username-taken", message: "用户名已存在" }));
    const user = { id: randomUUID(), username, password: hashPassword(password), role: "user", createdAt: Date.now() };
    users.set(username, user); saveUsers();
    return sendJson(res, 200, rpc(res, rpcId, true, publicUser(user)));
  }

  if (method === "auth.login") {
    const username = String(payload.username ?? "").trim();
    const password = String(payload.password ?? "");
    const user = users.get(username);
    if (!user || !verifyPassword(password, user.password)) return sendJson(res, 200, rpc(res, rpcId, false, { code: "bad-credentials", message: "用户名或密码错误" }));
    const token = randomUUID();
    sessions.set(token, { userId: user.id, username, createdAt: Date.now() });
    res.setHeader("set-cookie", `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
    return sendJson(res, 200, rpc(res, rpcId, true, publicUser(user)));
  }

  if (method === "auth.logout") {
    const s = resolveSession(req);
    if (s) for (const [k, v] of sessions) if (v.userId === s.userId) sessions.delete(k);
    res.setHeader("set-cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return sendJson(res, 200, rpc(res, rpcId, true, { loggedOut: true }));
  }

  if (method === "auth.me") {
    const s = resolveSession(req);
    if (!s) return sendJson(res, 200, rpc(res, rpcId, false, { code: "unauthenticated", message: "未登录" }));
    const user = [...users.values()].find((u) => u.id === s.userId);
    return sendJson(res, 200, rpc(res, rpcId, true, user ? publicUser(user) : null));
  }

  if (method === "auth.changePassword") {
    const username = String(payload.username ?? "").trim();
    const oldPassword = String(payload.oldPassword ?? "");
    const newPassword = String(payload.newPassword ?? "");
    const user = users.get(username);
    if (!user || !verifyPassword(oldPassword, user.password)) {
      return sendJson(res, 200, rpc(res, rpcId, false, { code: "bad-credentials", message: "用户名或旧密码错误" }));
    }
    if (newPassword.length < 6) {
      return sendJson(res, 200, rpc(res, rpcId, false, { code: "weak-password", message: "新密码至少 6 位" }));
    }
    user.password = hashPassword(newPassword);
    saveUsers();
    // 让该用户的所有会话失效，强制重新登录
    for (const [k, v] of sessions) if (v.userId === user.id) sessions.delete(k);
    return sendJson(res, 200, rpc(res, rpcId, true, { changed: true }));
  }

  return sendJson(res, 200, rpc(res, rpcId, false, { code: "unknown-method", message: `未知方法 ${method}` }));
}

// ---------------- 主服务器 ----------------
const LOGIN_HTML = await readFile(join(dirname(new URL(import.meta.url).pathname), "login.html"), "utf-8");
const CHANGEPWD_HTML = await readFile(join(dirname(new URL(import.meta.url).pathname), "change-password.html"), "utf-8");

const server = http.createServer(async (req, res) => {
  const rawPath = new URL(req.url ?? "/", "http://x").pathname;

  // 登录页 / 改密码页（独立静态页）
  if (rawPath === "/login.html" || rawPath === "/login") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(LOGIN_HTML);
  }
  if (rawPath === "/change-password.html" || rawPath === "/change-password") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(CHANGEPWD_HTML);
  }

  // 认证 API
  if (rawPath.startsWith("/api/auth.")) {
    let body = {};
    if (req.method === "POST") {
      body = await new Promise((resolve) => {
        let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
      });
    }
    return handleAuth(req, res, rawPath.slice(5), body);
  }

  // 会话校验：未登录一律 401
  const session = resolveSession(req);
  if (!session) {
    if (rawPath.startsWith("/api/")) return sendJson(res, 401, { error: "unauthorized", message: "未登录" });
    // 非 API 的未登录请求（如访问 /），重定向到登录页
    res.writeHead(302, { location: "/login.html" });
    return res.end();
  }

  // 已登录：确保实例就绪并反向代理
  try {
    const { port } = await ensureInstance(session.userId);
    proxy(req, res, port);
  } catch (err) {
    sendJson(res, 500, { error: "instance-error", message: String(err?.message ?? err) });
  }
});

// 初始化
loadUsers();
loadInstances();
if (!users.has("admin")) {
  const admin = { id: randomUUID(), username: "admin", password: hashPassword("admin123"), role: "admin", createdAt: Date.now() };
  users.set("admin", admin); saveUsers();
  console.log("[gateway] 已创建默认管理员 admin / admin123（请尽快修改密码）");
}

// WebSocket 转发（dsh 前端靠 events.mux / events.host 接收实时事件）
server.on("upgrade", async (req, socket, head) => {
  const session = resolveSession(req);
  if (!session) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  try {
    const { port } = await ensureInstance(session.userId);
    const options = {
      host: "127.0.0.1",
      port,
      method: "GET",
      path: req.url,
      headers: { ...req.headers, host: `127.0.0.1:${port}` },
    };
    const preq = http.request(options);
    preq.on("upgrade", (pres, psocket, phead) => {
      const rawHeaders = [];
      for (let i = 0; i < pres.rawHeaders.length; i += 2) rawHeaders.push(`${pres.rawHeaders[i]}: ${pres.rawHeaders[i + 1]}`);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${rawHeaders.join("\r\n")}\r\n\r\n`);
      socket.write(phead);
      psocket.pipe(socket);
      socket.pipe(psocket);
    });
    preq.on("error", () => socket.destroy());
    preq.end();
    socket.on("error", () => preq.destroy());
  } catch {
    socket.destroy();
  }
});

server.listen(GATEWAY_PORT, GATEWAY_HOST, () => {
  console.log(`[gateway] 多用户门户已启动: http://${GATEWAY_HOST}:${GATEWAY_PORT}`);
  console.log(`[gateway] 用户数据目录: ${DSH_BASE_HOME}`);
});
