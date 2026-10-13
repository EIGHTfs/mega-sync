#!/usr/bin/env node
'use strict';

/**
 * test/smoke.js —— 离线自检（不联网、不需要 MEGA 账号）
 *
 * 覆盖：参数解析、配置优先级、计划状态判定、配额错误识别、大小格式化、退出码常量。
 * 用法：node test/smoke.js   （或 npm test）
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseArgv, loadConfig } = require('../lib/config.js');
const { planFor, isQuotaError, isBlockedError, quotaResetSeconds, fmt, EXIT } = require('../lib/sync.js');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`PASS  ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`FAIL  ${name} :: ${err.message}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-sync-test-'));
try {
  // ── 参数解析 ──────────────────────────────────────────────
  check('① 解析 --link/--dest/--dryrun', () => {
    const a = parseArgv(['--link', 'https://mega.nz/file/x#y', '--dest', '/tmp/d', '--dryrun']);
    assert.strictEqual(a.link, 'https://mega.nz/file/x#y');
    assert.strictEqual(a.dest, '/tmp/d');
    assert.strictEqual(a.dryrun, true);
  });
  check('② 解析 --remote/--proxy/--login', () => {
    const a = parseArgv(['--remote', '/a/b', '--proxy', 'http://127.0.0.1:7890', '--login']);
    assert.strictEqual(a.remote, '/a/b');
    assert.strictEqual(a.proxy, 'http://127.0.0.1:7890');
    assert.strictEqual(a.loginOnly, true);
  });
  check('③ 未知识别为 _unknown', () => {
    assert.deepStrictEqual(parseArgv(['--nope'])._unknown, ['--nope']);
  });

  // ── 配置优先级：CLI > env > 文件 ─────────────────────────
  const cfgFile = path.join(tmp, 'mega-sync.config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ dest: '/from-file', proxy: 'http://file:1', email: 'f@x' }));
  check('④ 文件值生效', () => {
    const c = loadConfig({ argv: ['--link', 'u'], cwd: tmp, env: {} });
    assert.strictEqual(c.dest, '/from-file');
    assert.strictEqual(c.proxy, 'http://file:1');
  });
  check('⑤ env 覆盖文件', () => {
    const c = loadConfig({ argv: ['--link', 'u'], cwd: tmp, env: { MEGA_PROXY: 'http://env:1', MEGA_DEST: '/from-env' } });
    assert.strictEqual(c.proxy, 'http://env:1');
    assert.strictEqual(c.dest, '/from-env');
  });
  check('⑥ CLI 覆盖 env 与文件', () => {
    const c = loadConfig({ argv: ['--link', 'u', '--proxy', 'http://cli:1'], cwd: tmp, env: { MEGA_PROXY: 'http://env:1' } });
    assert.strictEqual(c.proxy, 'http://cli:1');
  });
  check('⑦ 缺 link/remote/login 时给出错误', () => {
    const c = loadConfig({ argv: [], cwd: tmp, env: {} });
    assert.ok(c.error && /--link/.test(c.error), 'err=' + c.error);
  });
  check('⑧ --remote 无凭据且无会话时给出错误', () => {
    const c = loadConfig({ argv: ['--remote', '/'], cwd: tmp, env: {} });
    assert.ok(c.error && /登录/.test(c.error), 'err=' + c.error);
  });
  check('⑨ 状态目录可自定义', () => {
    const c = loadConfig({ argv: ['--link', 'u', '--state', '/tmp/st'], cwd: tmp, env: {} });
    assert.strictEqual(c.sessionFile, '/tmp/st/session.json');
  });

  // ── 计划状态判定 ─────────────────────────────────────────
  const dest = path.join(tmp, 'out');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'done.bin'), Buffer.alloc(100));
  fs.writeFileSync(path.join(dest, 'half.bin.part'), Buffer.alloc(30));
  check('⑩ 计划识别 exists / partial / missing', () => {
    const plan = planFor(
      [
        { rel: 'done.bin', size: 100, file: {} },
        { rel: 'half.bin', size: 200, file: {} },
        { rel: 'new.bin', size: 50, file: {} },
      ],
      dest
    );
    assert.deepStrictEqual(plan.map((p) => p.state), ['exists', 'partial', 'missing']);
    assert.strictEqual(plan[1].partSize, 30);
  });
  check('⑪ 大小不符的完整文件不算已完成', () => {
    fs.writeFileSync(path.join(dest, 'wrong.bin'), Buffer.alloc(10));
    const plan = planFor([{ rel: 'wrong.bin', size: 999, file: {} }], dest);
    assert.strictEqual(plan[0].state, 'missing');
  });

  // ── 配额错误识别 ─────────────────────────────────────────
  check('⑫ 配额类错误被识别', () => {
    for (const m of ['EOVERQUOTA: over quota', 'Request failed with -17', 'Error 509: bandwidth exceeded', 'ETOOMANY connections']) {
      assert.strictEqual(isQuotaError(new Error(m)), true, m);
    }
  });
  check('⑬ 普通错误不被误判为配额', () => {
    for (const m of ['ENOENT (-9): Object not found', 'connection reset by peer', '大小不符']) {
      assert.strictEqual(isQuotaError(new Error(m)), false, m);
    }
  });

  // ── 其它 ────────────────────────────────────────────────
  check('⑭ fmt 大小格式化', () => {
    assert.strictEqual(fmt(512), '512B');
    assert.strictEqual(fmt(2048), '2.0KB');
    assert.strictEqual(fmt(5 * 1048576), '5.0MB');
    assert.strictEqual(fmt(3 * 1073741824), '3.00GB');
  });
  check('⑮ 退出码约定稳定（循环脚本依赖）', () => {
    assert.deepStrictEqual(EXIT, { OK: 0, ERROR: 1, CONFIG: 2, QUOTA: 3, BLOCKED: 4 });
  });
  check('⑯ 账号封锁错误被识别（此类必须停止重试）', () => {
    for (const m of ['EBLOCKED (-16): User blocked', 'User blocked', 'Account has been blocked']) {
      assert.strictEqual(isBlockedError(new Error(m)), true, m);
    }
    for (const m of ['ENOENT (-9): Object not found', 'Bandwidth limit reached: 10 seconds until it resets']) {
      assert.strictEqual(isBlockedError(new Error(m)), false, m);
    }
  });
  check('⑰ 配额恢复秒数提取（用于精确等待）', () => {
    assert.strictEqual(quotaResetSeconds(new Error('Bandwidth limit reached: 5095 seconds until it resets')), 5095);
    assert.strictEqual(quotaResetSeconds(new Error('Bandwidth limit reached: 1 second until it resets')), 1);
    assert.strictEqual(quotaResetSeconds(new Error('EOVERQUOTA')), 0);
  });
  check('⑱ 封锁与配额互不误判', () => {
    assert.strictEqual(isQuotaError(new Error('EBLOCKED (-16): User blocked')), false);
    assert.strictEqual(isBlockedError(new Error('EOVERQUOTA: over quota')), false);
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
