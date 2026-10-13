#!/usr/bin/env node
'use strict';

/**
 * bin/mega-sync.js —— CLI 入口
 *
 * 只做编排：解析配置 → 起代理 → 拿远端根 → 生成计划 → dryrun 或下载。
 * 具体实现分别在 lib/config.js（配置）、lib/client.js（MEGA/代理）、lib/sync.js（计划与下载）。
 */

const fs = require('node:fs');
const path = require('node:path');

const pkg = require('../package.json');
const { USAGE, loadConfig, ensureStateDir } = require('../lib/config.js');
const { applyProxy, openLink, getStorage, walk, findNodeByPath } = require('../lib/client.js');
const { EXIT, isQuotaError, isBlockedError, quotaResetSeconds, planFor, fmt, downloadOne } = require('../lib/sync.js');

/** 配额恢复秒数的落盘路径（main() 里按配置设定；顶层 catch 也要用） */
let waitFile = null;

/** 记录平台给出的配额恢复秒数，供 sync-loop.sh 精确等待（写不了不影响主流程） */
function recordQuotaWait(err) {
  const secs = quotaResetSeconds(err);
  if (secs > 0 && waitFile) {
    try {
      fs.writeFileSync(waitFile, String(secs));
      return secs;
    } catch {
      /* 忽略 */
    }
  }
  return 0;
}

/** 打印 + 追加日志（日志写不了不影响主流程） */
function makeLogger(cfg) {
  return (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    try {
      fs.appendFileSync(cfg.logFile, `${line}\n`);
    } catch {
      /* 忽略日志写入失败 */
    }
  };
}

/** 取远端根节点（分享链接或云盘路径） */
async function resolveRoot(cfg, log) {
  if (cfg.link) {
    log(`打开分享链接：${cfg.link.slice(0, 80)}`);
    const node = await openLink(cfg.link);
    log(`链接内容：${node.name || '(根)'}${node.directory ? '（文件夹）' : '（单文件）'}`);
    return { node, storage: null };
  }
  const { storage, reused } = await getStorage(cfg);
  log(`${reused ? '已用会话文件恢复登录态' : '登录成功'}：账号 ${storage.name || '?'}（文件树 ${Object.keys(storage.files || {}).length} 项）`);
  const node = findNodeByPath(storage, cfg.remote || '/');
  if (!node) throw new Error(`云盘里找不到路径：${cfg.remote}`);
  log(`远端路径：${cfg.remote || '/'}（${node.directory ? '文件夹' : '文件'}）`);
  return { node, storage };
}

async function main() {
  const cfg = loadConfig({ argv: process.argv.slice(2) });
  if (cfg.cli.help) {
    process.stdout.write(USAGE);
    return EXIT.OK;
  }
  if (cfg.cli.version) {
    console.log(pkg.version);
    return EXIT.OK;
  }
  if (cfg.cli._unknown.length) {
    console.error(`未知参数：${cfg.cli._unknown.join(' ')}\n`);
    process.stdout.write(USAGE);
    return EXIT.CONFIG;
  }
  if (cfg.error) {
    console.error(cfg.error);
    return EXIT.CONFIG;
  }

  ensureStateDir(cfg);
  waitFile = path.join(cfg.stateDir, '.wait-seconds'); // 配额恢复秒数落盘，供 sync-loop.sh 精确等待
  const log = makeLogger(cfg);

  if (applyProxy(cfg.proxy)) log(`代理已启用：${cfg.proxy}`);
  else log('未配置代理（直连；若本机无法访问 MEGA，请用 --proxy 或 MEGA_PROXY）');

  if (cfg.loginOnly) {
    const { storage } = await getStorage(cfg);
    log(`登录成功，会话已保存：${cfg.sessionFile}（账号 ${storage.name || '?'}）`);
    return EXIT.OK;
  }

  const { node } = await resolveRoot(cfg, log);
  const items = node.directory
    ? await walk(node, '', [])
    : [{ rel: node.name || 'download.bin', size: Number(node.size) || 0, file: node }];

  const plan = planFor(items, cfg.dest);
  const pending = plan.filter((p) => p.state !== 'exists');
  const pendingBytes = pending.reduce((s, i) => s + i.size, 0);
  log(`远端 ${items.length} 个文件 / ${fmt(items.reduce((s, i) => s + i.size, 0))} → ${cfg.dest}`);
  log(`对比本地：待下 ${pending.length} 个（${fmt(pendingBytes)}）｜已存在 ${plan.length - pending.length} 个`);

  if (cfg.dryrun) {
    log('--- dryrun：只列计划，不写任何文件 ---');
    for (const p of pending.slice(0, 100)) log(`  [${p.state}] ${p.rel}（${fmt(p.size)}）`);
    if (pending.length > 100) log(`  …还有 ${pending.length - 100} 个待下`);
    log(`dryrun 结束：将下载 ${pending.length} 个 / ${fmt(pendingBytes)}`);
    return EXIT.OK;
  }

  let done = 0;
  let failed = 0;
  for (const item of pending) {
    try {
      const r = await downloadOne(item, {
        onProgress: (got, total) => log(`  ${item.rel}：${fmt(got)}/${fmt(total)}`),
      });
      if (r === 'done') done += 1;
    } catch (err) {
      if (isBlockedError(err)) {
        log(`账号被 MEGA 封锁/限制：${String(err.message).slice(0, 120)}`);
        log('这类错误重试无用（反复登录会加重限制），已停止本轮；请人工处理后再运行');
        return EXIT.BLOCKED;
      }
      if (isQuotaError(err)) {
        const secs = recordQuotaWait(err);
        log(`撞上 MEGA 配额/限流：${String(err.message).slice(0, 120)}${secs ? `（${secs} 秒后恢复，已记录供循环精确等待）` : ''}`);
        log(`本轮已下 ${done} 个；配额窗口恢复后重跑即可（进度保留在 .part）`);
        return EXIT.QUOTA;
      }
      failed += 1;
      log(`  失败：${item.rel} → ${String(err.message).slice(0, 140)}`);
    }
  }

  log(`本轮结束：新下载 ${done}｜已存在 ${plan.length - pending.length}｜失败 ${failed}`);
  return failed ? EXIT.ERROR : EXIT.OK;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    if (isBlockedError(err)) {
      console.error(`账号被 MEGA 封锁/限制：${String(err.message).slice(0, 120)}`);
      console.error('请人工处理（登录 mega.nz 看提示 / 查注册邮箱），解封前不要重复运行');
      process.exit(EXIT.BLOCKED);
    }
    if (isQuotaError(err)) {
      recordQuotaWait(err);
      console.error(`撞上 MEGA 配额/限流：${String(err.message).slice(0, 120)}`);
      process.exit(EXIT.QUOTA);
    }
    console.error(`[mega-sync] 异常：${(err && err.stack) || err}`);
    process.exit(EXIT.ERROR);
  });
