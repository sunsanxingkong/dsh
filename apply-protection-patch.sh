#!/usr/bin/env bash
# 应用 dsh 的「敏感目录保护」补丁（幂等）：
#   1. workspace 黑名单：禁止把敏感目录（dsh 数据/安装目录）加为工作区
#   2. fs 工具读黑名单：禁止 fs 工具读取敏感目录
#   3. bwrap 沙箱遮蔽：让 agent 的 bash 命令看不到敏感目录（需主机支持 bwrap）
#
# 敏感目录默认：/root/.dsh 与 dsh 安装目录；可用环境变量 DSH_PROTECTED_ROOTS 追加（冒号分隔）。
set -e
BASE=/root/.codebuddy/artifact/dsh-deploy/node_modules/@deepseek-ai
MARKER='/* PROTECTED-PATHS: do not remove */'

# 1) workspace 黑名单
F1="$BASE/dsh-workspace/lib/index.js"
if ! grep -qF "$MARKER" "$F1" 2>/dev/null; then
  cp -p "$F1" "${F1}.bak"
  python3 - "$F1" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1]); s = p.read_text()
a = 'import { basename } from "node:path";'
b = 'import { basename, resolve, sep } from "node:path";'
s = s.replace(a, b, 1)
a = '''	async create(path, title) {
		const canonical = await realpathNormalize(path);
		if (!(await stat(canonical)).isDirectory()) throw new Error(`cannot create a workspace at '${canonical}': path is not a directory`);
		return await this.enqueueOperation(() => this.createCanonical(canonical, title));
	}'''
b = '''	async create(path, title) {
		const canonical = await realpathNormalize(path);
		if (isForbiddenWorkspacePath(canonical)) throw new Error(`cannot create a workspace at '${canonical}': this directory is protected (dsh 配置/用户数据目录不允许作为工作区)`);
		if (!(await stat(canonical)).isDirectory()) throw new Error(`cannot create a workspace at '${canonical}': path is not a directory`);
		return await this.enqueueOperation(() => this.createCanonical(canonical, title));
	} /* PROTECTED-PATHS: do not remove */'''
s = s.replace(a, b, 1)
a = '''async function realpathNormalize(path) {
	return await realpath(path);
}'''
b = '''async function realpathNormalize(path) {
	return await realpath(path);
}
const FORBIDDEN_WORKSPACE_ROOTS = [
	resolve("/root/.dsh"),
	resolve("/root/.codebuddy/artifact/dsh-deploy"),
	...(process.env.DSH_PROTECTED_ROOTS ?? "").split(":").filter(Boolean).map((x) => resolve(x))
];
function isForbiddenWorkspacePath(c) {
	return FORBIDDEN_WORKSPACE_ROOTS.some((r) => c === r || c.startsWith(r + sep));
}'''
s = s.replace(a, b, 1)
p.write_text(s); print("[protect] workspace 黑名单已应用")
PY
else
  echo "[protect] workspace 黑名单已存在"
fi

# 2) fs 工具读黑名单
F2="$BASE/dsh-fs-sandbox/lib/index.js"
if ! grep -qF "$MARKER" "$F2" 2>/dev/null; then
  cp -p "$F2" "${F2}.bak"
  python3 - "$F2" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1]); s = p.read_text()
a = 'import { dirname, sep } from "node:path";'
b = 'import { dirname, resolve, sep } from "node:path";'
s = s.replace(a, b, 1)
a = '''	async editText(target, edit, expected, signal, sandboxPolicy) {
		return super.editText(await this.checkedTarget(target, sandboxPolicy), edit, expected, signal);
	}'''
b = '''	async editText(target, edit, expected, signal, sandboxPolicy) {
		return super.editText(await this.checkedTarget(target, sandboxPolicy), edit, expected, signal);
	} /* PROTECTED-PATHS: do not remove */
	assertNotProtected(target) {
		const pp = target.targetKey ?? target.displayPath;
		if (pp !== void 0 && isForbiddenFsPath(pp)) throw new FsError(`cannot read "${target.displayPath}": file access denied (protected path)`, "FS_SANDBOX_DENIED");
	}
	async readText(target, signal) { this.assertNotProtected(target); return super.readText(target, signal); }
	async readBytes(target, signal, maxBytes) { this.assertNotProtected(target); return super.readBytes(target, signal, maxBytes); }
	streamText(target, signal) { this.assertNotProtected(target); return super.streamText(target, signal); }
	async listDir(target, signal) { this.assertNotProtected(target); return super.listDir(target, signal); }'''
s = s.replace(a, b, 1)
a = '''function comparablePath(path, caseSensitive) {
	return caseSensitive ? path : path.toLowerCase();
}'''
b = '''function comparablePath(path, caseSensitive) {
	return caseSensitive ? path : path.toLowerCase();
}
const FORBIDDEN_FS_ROOTS = [
	resolve("/root/.dsh"),
	resolve("/root/.codebuddy/artifact/dsh-deploy"),
	...(process.env.DSH_PROTECTED_ROOTS ?? "").split(":").filter(Boolean).map((x) => resolve(x))
];
function isForbiddenFsPath(c) {
	return FORBIDDEN_FS_ROOTS.some((r) => c === r || c.startsWith(r + sep));
}'''
s = s.replace(a, b, 1)
p.write_text(s); print("[protect] fs 读黑名单已应用")
PY
else
  echo "[protect] fs 读黑名单已存在"
fi

# 3) bwrap 遮蔽（需主机支持 bwrap）
F3="$BASE/dsh-sandbox-local/lib/index.js"
if ! grep -qF "$MARKER" "$F3" 2>/dev/null; then
  cp -p "$F3" "${F3}.bak"
  python3 - "$F3" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1]); s = p.read_text()
a = '''	if (policy.mode === "workspace-write") {
		args.push("--tmpfs", "/tmp");
		args.push("--bind", policy.workspaceRoot, policy.workspaceRoot);
	}
	return args;
}'''
b = '''	for (const pth of forbiddenSensitivePaths()) {
		args.push("--tmpfs", pth);
	}
	if (policy.mode === "workspace-write") {
		args.push("--tmpfs", "/tmp");
		args.push("--bind", policy.workspaceRoot, policy.workspaceRoot);
	}
	return args;
} /* PROTECTED-PATHS: do not remove */
function forbiddenSensitivePaths() {
	return [
		"/root/.dsh",
		"/root/.codebuddy/artifact/dsh-deploy",
		...(process.env.DSH_PROTECTED_ROOTS ?? "").split(":").filter(Boolean)
	];
}'''
s = s.replace(a, b, 1)
p.write_text(s); print("[protect] bwrap 遮蔽已应用")
PY
else
  echo "[protect] bwrap 遮蔽已存在"
fi

echo "[protect] 全部完成"
