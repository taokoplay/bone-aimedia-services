"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function findDreaminaBinary(customPath) {
  if (customPath && customPath.trim()) {
    const trimmed = customPath.trim();
    if (fs.existsSync(trimmed)) return trimmed;
  }
  const home = os.homedir();
  const candidates = [
    path.join(home, ".local", "bin", "dreamina"),
    "/usr/local/bin/dreamina",
    "/opt/homebrew/bin/dreamina",
    "dreamina"
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return "dreamina";
}

function runCli(bin, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, env: process.env }, (error, stdout, stderr) => {
      resolve({
        error,
        exitCode: error ? (error.code ?? 1) : 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || "")
      });
    });
  });
}

async function getDreaminaStatus(customPath) {
  const bin = findDreaminaBinary(customPath);
  const res = await runCli(bin, ["user_credit"]);
  if (res.error) {
    if (res.error.code === "ENOENT") {
      return { state: "cliMissing", message: "未找到 dreamina CLI，请确认已安装或在下方指定路径", bin };
    }
    const raw = (res.stdout + "\n" + res.stderr).trim();
    if (raw.includes("未登录") || raw.includes("login") || raw.includes("unauthorized") || res.exitCode !== 0) {
      return { state: "loggedOut", message: "尚未登录即梦 CLI", bin };
    }
    return { state: "error", message: raw || res.error.message, bin };
  }
  try {
    const data = JSON.parse(res.stdout);
    if (typeof data.total_credit === "number" || data.user_id) {
      return {
        state: "loggedIn",
        userId: String(data.user_id || ""),
        credit: Number(data.total_credit ?? 0),
        userName: data.user_name || "",
        vipLevel: data.vip_level || "",
        bin
      };
    }
  } catch {}
  return { state: "unknown", message: "已执行但未返回有效状态", bin };
}

async function startDreaminaLogin(customPath) {
  const bin = findDreaminaBinary(customPath);
  const res = await runCli(bin, ["login", "--headless"], 20000);
  const text = res.stdout + "\n" + res.stderr;
  const uriMatch = /https:\/\/[\w.-]+\/[^\s]+/i.exec(text);
  const userCodeMatch = /user_code[:=\s]+([A-Za-z0-9_-]+)/i.exec(text) || /[A-Z0-9]{4,8}-[A-Z0-9]{4,8}/.exec(text);
  const deviceCodeMatch = /device_code[:=\s]+([A-Za-z0-9_-]+)/i.exec(text);

  return {
    ok: !res.error && Boolean(uriMatch),
    verificationUri: uriMatch ? uriMatch[0] : null,
    userCode: userCodeMatch ? userCodeMatch[1] || userCodeMatch[0] : null,
    deviceCode: deviceCodeMatch ? deviceCodeMatch[1] : null,
    raw: text,
    bin
  };
}

async function checkDreaminaLogin(customPath, deviceCode) {
  const bin = findDreaminaBinary(customPath);
  const args = ["login", "checklogin", `--device_code=${deviceCode}`, "--poll=8"];
  const res = await runCli(bin, args, 15000);
  const text = res.stdout + "\n" + res.stderr;
  const success = text.includes("登录成功") || text.includes("OAuth 登录成功") || text.includes("success");
  return { success, raw: text };
}

async function logoutDreamina(customPath) {
  const bin = findDreaminaBinary(customPath);
  const res = await runCli(bin, ["logout"]);
  return { ok: !res.error, raw: res.stdout + "\n" + res.stderr };
}

function getDreaminaCloudModels() {
  return [
    { id: "5.0Pro", name: "5.0Pro", kind: "image" },
    { id: "5.0", name: "5.0", kind: "image" },
    { id: "4.7", name: "4.7", kind: "image" },
    { id: "4.6", name: "4.6", kind: "image" },
    { id: "4.5", name: "4.5", kind: "image" },
    { id: "4.1", name: "4.1", kind: "image" },
    { id: "4.0", name: "4.0", kind: "image" },
    { id: "3.1", name: "3.1", kind: "image" },
    { id: "3.0", name: "3.0", kind: "image" },
    { id: "seedance2.5", name: "seedance2.5", kind: "video" },
    { id: "seedance2.0", name: "seedance2.0", kind: "video" },
    { id: "seedance2.0fast", name: "seedance2.0fast", kind: "video" },
    { id: "seedance2.0_vip", name: "seedance2.0_vip", kind: "video" },
    { id: "seedance2.0fast_vip", name: "seedance2.0fast_vip", kind: "video" },
    { id: "seedance2.0mini", name: "seedance2.0mini", kind: "video" }
  ];
}

module.exports = {
  findDreaminaBinary,
  getDreaminaStatus,
  startDreaminaLogin,
  checkDreaminaLogin,
  logoutDreamina,
  getDreaminaCloudModels
};
