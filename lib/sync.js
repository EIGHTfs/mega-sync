'use strict';

/**
 * lib/sync.js —— 计划（对比本地）与单文件下载（.part 断点续传 + 配额判定）
 *
 * 断点续传依据：MEGA 支持按字节区间下载，megajs 的 `file.download({ start })`
 * 即从该偏移返回解密后的流（内部按 16 字节块对齐并跳过多余字节）。
 *
 * 注意：续传时 megajs 会关闭整文件 MAC 校验（start>0 时 disableVerification），
 * 因此这里用「最终大小严格比对」兜底：不符则保留 .part，下次继续。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');

/** 退出码约定 */
const EXIT = { OK: 0, ERROR: 1, CONFIG: 2, QUOTA: 3 };

/** 配额/限流判定（MEGA 常见：EOVERQUOTA / -17 / 509 / ETOOMANY） */
const QUOTA_RE = /EOVERQUOTA|over\s?quota|-17\b|ETOOMANY|509/i;

/** 该错误是否属于「配额/限流」（应退避重跑，而不是记为失败） */
function isQuotaError(err) {
  return QUOTA_RE.test(String((err && err.message) || err));
}

/** 本地文件是否已完整（按名字 + 大小） */
function isDone(localPath, size) {
  try {
    return fs.statSync(localPath).size === size;
  } catch {
    return false;
  }
}

/**
 * 生成计划：远端条目 → 带本地状态的任务
 * state: exists（已完整）/ partial（有 .part）/ missing（没有）
 */
function planFor(items, dest) {
  return items.map((it) => {
    const localPath = path.join(dest, it.rel);
    const partPath = `${localPath}.part`;
    const partSize = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;
    let state = 'missing';
    if (isDone(localPath, it.size)) state = 'exists';
    else if (partSize > 0) state = 'partial';
    return { ...it, localPath, partPath, partSize, state };
  });
}

/** 人类可读大小 */
function fmt(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)}GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

/**
 * 下载单个文件（支持从 .part 续传）
 * @returns {Promise<'done'|'exists'>}
 */
async function downloadOne(item, { onProgress } = {}) {
  await fsp.mkdir(path.dirname(item.localPath), { recursive: true });

  let start = fs.existsSync(item.partPath) ? fs.statSync(item.partPath).size : 0;
  if (start > item.size) {
    await fsp.rm(item.partPath, { force: true }); // .part 比目标大 → 作废重下
    start = 0;
  }
  if (item.size > 0 && start === item.size) {
    await fsp.rename(item.partPath, item.localPath);
    return 'exists';
  }

  const stream = item.file.download({ start });
  const ws = fs.createWriteStream(item.partPath, { flags: start > 0 ? 'a' : 'w' });
  stream.pipe(ws);
  if (typeof onProgress === 'function') {
    const timer = setInterval(() => {
      try {
        onProgress(fs.statSync(item.partPath).size, item.size);
      } catch {
        /* 文件可能刚被重命名，忽略 */
      }
    }, 2000);
    timer.unref?.();
    ws.on('finish', () => clearInterval(timer));
  }

  await Promise.race([
    once(ws, 'finish'),
    once(stream, 'error').then(([err]) => {
      throw err;
    }),
  ]);

  const got = fs.statSync(item.partPath).size;
  if (item.size && got !== item.size) {
    throw new Error(`大小不符（得到 ${got} / 期望 ${item.size}）——保留 .part 供下次续传`);
  }
  await fsp.rename(item.partPath, item.localPath);
  return 'done';
}

module.exports = { EXIT, QUOTA_RE, isQuotaError, isDone, planFor, fmt, downloadOne };
