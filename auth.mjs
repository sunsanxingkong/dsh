// dsh 多用户认证模块（auth.mjs）
//
// 为 DeepSeek Harness (dsh) 单进程 web 部署增加「用户名+密码」认证层。
// 采用最小依赖设计：
//   - 密码哈希：Node 内置 crypto.scrypt（无原生依赖）
//   - 用户存储：JSON 文件（20+ 人规模足够）
//   - 会话：内存 Map（重启失效，MVP 可接受）
//   - 用户上下文：AsyncLocalStorage（供 per-user 数据隔离层读取）
//
// 认证 API 通过 /api/auth.* 暴露，由 dsh-client-connection 的 /api handler 调用本模块。

import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userContext } from "@deepseek-ai/dsh-home-paths";

// 会话表：token -> { userId, username, createdAt }
const sessions = new Map();

const SESSION_COOKIE = "dsh_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
const AUTH_METHODS = new Set(["auth.login", "auth.logout", "auth.me", "auth.register"]);

let usersFile = null; // 用户 JSON 文件路径
let users = new Map(); // username -> user record
let allowRegister = true; // 是否允许自助注册（管理员可关闭）
let bootstrapped = false;

// ---------------- 工具函数 ----------------

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (raw.length === 0) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid json body"));
      }
    });
    req.on("error", reject);
  });
}

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

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
  if (test.length !== expected.length) return false;
  return timingSafeEqual(test, expected);
}

function loadUsers() {
  users = new Map();
  if (existsSync(usersFile)) {
    try {
      const data = JSON.parse(readFileSync(usersFile, "utf-8"));
      for (const u of data.users ?? []) users.set(u.username, u);
    } catch {
      // 损坏文件从空开始，避免崩溃
    }
  }
}

function saveUsers() {
  mkdirSync(join(usersFile, ".."), { recursive: true });
  const data = { users: [...users.values()] };
  writeFileSync(usersFile, JSON.stringify(data, null, 2), "utf-8");
}

function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role ?? "user", createdAt: u.createdAt };
}

function serverResponse(rpcId, ok, valueOrError) {
  return ok
    ? { type: "server-response", rpcId, result: { ok: true, value: valueOrError } }
    : { type: "server-response", rpcId, result: { ok: false, error: valueOrError } };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(body);
}

function setSessionCookie(res, token) {
  res.setHeader(
    "set-cookie",
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  );
}

function clearSessionCookie(res) {
  res.setHeader("set-cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function currentUserId() {
  const store = userContext.getStore();
  return store?.userId ?? null;
}

// ---------------- 初始化 ----------------

export function initAuth({ dataDir, register = true } = {}) {
  if (bootstrapped) return;
  const dir = dataDir ?? join(process.env.HOME ?? "/root", ".dsh", "auth");
  usersFile = join(dir, "users.json");
  allowRegister = register;
  mkdirSync(dir, { recursive: true });
  loadUsers();

  // 首次启动创建默认管理员 admin（密码 admin123，需尽快修改）
  if (!users.has("admin")) {
    const admin = {
      id: randomUUID(),
      username: "admin",
      password: hashPassword("admin123"),
      role: "admin",
      createdAt: Date.now(),
    };
    users.set("admin", admin);
    saveUsers();
    console.log("[dsh-auth] 已创建默认管理员 admin / admin123（请尽快修改密码）");
  }
  bootstrapped = true;
}

// ---------------- 认证 API 处理 ----------------

async function handleRegister(rpcId, payload, res) {
  if (!allowRegister) {
    return sendJson(res, 200, serverResponse(rpcId, false, { code: "registration-disabled", message: "注册已关闭" }));
  }
  const username = String(payload?.username ?? "").trim();
  const password = String(payload?.password ?? "");
  if (!/^[a-zA-Z0-9_.-]{2,32}$/.test(username)) {
    return sendJson(res, 200, serverResponse(rpcId, false, { code: "invalid-username", message: "用户名需为 2-32 位字母/数字/_.-" }));
  }
  if (password.length < 6) {
    return sendJson(res, 200, serverResponse(rpcId, false, { code: "weak-password", message: "密码至少 6 位" }));
  }
  if (users.has(username)) {
    return sendJson(res, 200, serverResponse(rpcId, false, { code: "username-taken", message: "用户名已存在" }));
  }
  const user = {
    id: randomUUID(),
    username,
    password: hashPassword(password),
    role: "user",
    createdAt: Date.now(),
  };
  users.set(username, user);
  saveUsers();
  return sendJson(res, 200, serverResponse(rpcId, true, publicUser(user)));
}

async function handleLogin(rpcId, payload, res) {
  const username = String(payload?.username ?? "").trim();
  const password = String(payload?.password ?? "");
  const user = users.get(username);
  if (!user || !verifyPassword(password, user.password)) {
    return sendJson(res, 200, serverResponse(rpcId, false, { code: "bad-credentials", message: "用户名或密码错误" }));
  }
  const token = randomUUID();
  sessions.set(token, { userId: user.id, username: user.username, createdAt: Date.now() });
  setSessionCookie(res, token);
  return sendJson(res, 200, serverResponse(rpcId, true, publicUser(user)));
}

async function handleLogout(rpcId, req, res) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (token) sessions.delete(token);
  clearSessionCookie(res);
  return sendJson(res, 200, serverResponse(rpcId, true, { loggedOut: true }));
}

async function handleMe(rpcId, req, res) {
  const userId = currentUserId();
  if (!userId) {
    return sendJson(res, 200, serverResponse(rpcId, false, { code: "unauthenticated", message: "未登录" }));
  }
  const user = [...users.values()].find((u) => u.id === userId);
  return sendJson(res, 200, serverResponse(rpcId, true, user ? publicUser(user) : null));
}

// ---------------- 主入口（供 dsh-client-connection /api handler 调用） ----------------

/**
 * 处理一次 /api 请求的认证环节。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<{handled:boolean, ok?:boolean, userId?:string|null}>}
 *   - handled:true  表示这是 auth.* 请求，已写入响应，调用方应直接 return
 *   - handled:false 表示普通 API，ok 表示是否已登录；ok 时 userId 已进入 AsyncLocalStorage
 */
export async function handleApiRequest(req, res) {
  const rawPath = new URL(req.url ?? "/", "http://x").pathname;

  // 从 /api/<method> 提取 method（如 /api/auth.login）
  if (!rawPath.startsWith("/api/")) {
    // 非 /api 路径（静态资源等）由 webserver 其他路由处理，这里不干预
    return { handled: false, ok: true, userId: null };
  }

  const method = rawPath.slice(5); // 去掉 "/api/"

  // 认证 API 白名单：这些方法由本模块处理，不经过 apiproxy
  if (AUTH_METHODS.has(method)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { type: "server-response", rpcId: body?.rpcId ?? "auth", result: { ok: false, error: { code: "bad-request", message: "无效请求体" } } });
      return { handled: true };
    }
    const rpcId = body?.rpcId ?? "auth";
    const payload = body?.payload ?? {};

    if (method === "auth.login") {
      await handleLogin(rpcId, payload, res);
    } else if (method === "auth.logout") {
      await handleLogout(rpcId, req, res);
    } else if (method === "auth.me") {
      // auth.me 需要已登录的上下文；先解析 cookie 注入再处理
      const userId = resolveSession(req);
      return userContext.run({ userId }, async () => {
        await handleMe(rpcId, req, res);
        return { handled: true };
      });
    } else if (method === "auth.register") {
      await handleRegister(rpcId, payload, res);
    }
    return { handled: true };
  }

  // 普通 API：解析会话，注入 userId
  const userId = resolveSession(req);
  return { handled: false, ok: userId !== null, userId };
}

// 从 cookie 解析会话，返回 userId 或 null
function resolveSession(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return null;
  }
  return session.userId;
}

/**
 * 用指定 userId 包裹一段异步执行（供 dsh-client-connection 在 bridge 前调用，
 * 让 apiproxy 内部存储层能通过 getCurrentUser 读到当前用户）。
 */
export function runWithUser(userId, fn) {
  return userContext.run({ userId }, fn);
}

/**
 * 返回当前请求的用户 ID（供数据隔离存储层调用）。未认证返回 null。
 */
export function getCurrentUserId() {
  return currentUserId();
}

export { userContext };
