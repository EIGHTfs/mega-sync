'use strict';

/**
 * lib/client.js —— MEGA 客户端封装：代理、登录/会话、远端遍历
 *
 * 两个关键坑（都实测踩过）：
 *  1) megajs 在 Node 18+ 走**全局 fetch（undici）**，不认 httpAgent/httpsAgent。
 *     只传 agent 会表现为 `TypeError: fetch failed`（其实是直连、被墙）。
 *     正确做法：`setGlobalDispatcher(new ProxyAgent(proxy))`。因此本包只依赖 undici。
 *  2) `await storage.ready` 只代表登录完成，**文件树要再 `await storage.reload()`**
 *     才会填充（否则 storage.root / files / mounts 是空的）。
 */

const fs = require('node:fs');

const { isBlockedError } = require('./sync.js');

/** 让全局 fetch 走代理（含 socks5：undici 的 ProxyAgent 支持 http(s)/socks） */
function applyProxy(proxy) {
  if (!proxy) return false;
  const { setGlobalDispatcher, ProxyAgent } = require('undici');
  setGlobalDispatcher(new ProxyAgent(proxy));
  return true;
}

/** 打开分享链接（file 或 folder），无需登录 */
async function openLink(link) {
  const { File } = require('megajs');
  const node = File.fromURL(link);
  await node.loadAttributes();
  return node;
}

/**
 * 取登录后的 Storage（优先复用会 话文件；失效才用账号密码并回写会话）
 * @returns {Promise<object>} megajs Storage
 */
async function getStorage({ email, password, sessionFile }) {
  const { Storage } = require('megajs');
  const load = async (storage) => {
    await storage.ready;
    await storage.reload(); // 关键：加载文件树
    return storage;
  };

  if (sessionFile && fs.existsSync(sessionFile)) {
    try {
      const storage = await load(Storage.fromJSON(JSON.parse(fs.readFileSync(sessionFile, 'utf8'))));
      return { storage, reused: true };
    } catch (err) {
      // 关键：会话加载失败 ≠ 会话过期。
      // 若失败原因是「账号被平台封锁」，再走账号密码登录只会加重风控
      // （实测事故：一次封锁被这个 fallback 放大成 220 次密码登录尝试）。
      if (isBlockedError(err)) throw err; // 抛给上层 → 退出码 4 → 循环停止
      /* 真正的会话失效 → 退回账号密码登录 */
    }
  }
  if (!email || !password) throw new Error('需要登录但未提供账号密码（MEGA_EMAIL / MEGA_PASSWORD 或配置文件）');

  const storage = await load(new Storage({ email, password }));
  if (sessionFile) {
    fs.mkdirSync(require('node:path').dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, JSON.stringify(storage.toJSON(), null, 2), { mode: 0o600 });
  }
  return { storage, reused: false };
}

/** 递归收集远端文件：[{ rel, size, file }] */
async function walk(node, prefix, acc, depth = 0) {
  if (depth > 16) return acc; // 防御异常深递归
  if (!node.children) {
    try {
      await node.loadAttributes();
    } catch {
      return acc; // 单个目录读不动就跳过，不让整轮失败
    }
  }
  for (const child of node.children || []) {
    const rel = prefix ? `${prefix}/${child.name}` : child.name;
    if (child.directory) await walk(child, rel, acc, depth + 1);
    else acc.push({ rel, size: Number(child.size) || 0, file: child });
  }
  return acc;
}

/** 按名字逐级找云盘节点（remotePath 形如 /a/b） */
function findNodeByPath(storage, remotePath) {
  const parts = String(remotePath).split('/').filter(Boolean);
  let node = storage.root;
  for (const part of parts) {
    const next = (node && node.children || []).find((c) => c.name === part);
    if (!next) return null;
    node = next;
  }
  return node || null;
}

module.exports = { applyProxy, openLink, getStorage, walk, findNodeByPath };
