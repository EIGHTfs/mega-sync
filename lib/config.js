'use strict';

/**
 * lib/config.js —— 参数 / 环境变量 / 配置文件的合并解析与路径约定
 *
 * 优先级：命令行 > 环境变量 > 配置文件 > 内置默认
 *
 * 配置文件默认取「当前工作目录」下的 mega-sync.config.json（而不是包目录，
 * 因为 npm 全局安装后包目录是只读的，且不该把用户配置写进 node_modules）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_CONFIG_NAME = 'mega-sync.config.json';
const STATE_DIR_NAME = '.mega-sync';

const USAGE = `mega-sync —— MEGA 拉取式同步（断点续传 + 免费号配额退避）

用法：
  mega-sync --link "<分享链接>" [--dest <目录>]      下公开分享（file/folder，无需登录）
  mega-sync --remote "/路径" [--dest <目录>]         同步自己云盘（需登录）
  mega-sync --login                                  只登录并保存会话
  mega-sync --link "..." --dryrun                    只看计划（待下/已存在），不写文件

选项：
  --link <url>        公开分享链接
  --remote <path>     云盘路径，默认 /（整个云盘）
  --dest <dir>        目标目录，默认 ./MEGA
  --config <file>     配置文件，默认 ./${DEFAULT_CONFIG_NAME}
  --proxy <url>       代理（http:// 或 socks5://），也可用 MEGA_PROXY / 配置文件
  --state <dir>       状态目录（会话+日志），默认 ./.mega-sync
  --dryrun            只打印计划，不写任何文件
  --login             只登录并保存会话
  -h, --help          显示帮助
  -v, --version       显示版本

环境变量：MEGA_EMAIL / MEGA_PASSWORD / MEGA_PROXY / MEGA_DEST / MEGA_SYNC_STATE

退出码：0 完成 ｜ 1 出错 ｜ 2 配置问题 ｜ 3 撞配额（等窗口后重跑）｜ 4 账号被封锁（停止重试，需人工处理）
`;

/** 解析命令行参数 */
function parseArgv(argv) {
  const out = { _unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => argv[++i] || '';
    if (a === '--link') out.link = take();
    else if (a === '--remote') out.remote = take();
    else if (a === '--dest') out.dest = take();
    else if (a === '--config') out.config = take();
    else if (a === '--proxy') out.proxy = take();
    else if (a === '--state') out.state = take();
    else if (a === '--dryrun') out.dryrun = true;
    else if (a === '--login') out.loginOnly = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (a === '-v' || a === '--version') out.version = true;
    else if (a.startsWith('-')) out._unknown.push(a);
  }
  return out;
}

/** 读配置文件（不存在返回空对象） */
function readConfigFile(file) {
  if (!file || !fs.existsSync(file)) return {};
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    return json && typeof json === 'object' ? json : {};
  } catch (err) {
    throw new Error(`配置文件不是合法 JSON：${file}（${err.message}）`);
  }
}

/**
 * 合并出最终配置
 * @param {{argv:string[], cwd?:string, env?:object}} params
 */
function loadConfig({ argv = [], cwd = process.cwd(), env = process.env } = {}) {
  const cli = parseArgv(argv);
  if (cli.help || cli.version) return { cli };

  const configFile = path.resolve(cwd, cli.config || env.MEGA_SYNC_CONFIG || DEFAULT_CONFIG_NAME);
  const file = readConfigFile(configFile);

  const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '');
  const dest = path.resolve(cwd, pick(cli.dest, env.MEGA_DEST, file.dest) || 'MEGA');
  const stateDir = path.resolve(cwd, pick(cli.state, env.MEGA_SYNC_STATE, file.state) || STATE_DIR_NAME);

  const cfg = {
    cli,
    cwd,
    configFile,
    stateDir,
    sessionFile: path.join(stateDir, 'session.json'),
    logFile: path.join(stateDir, 'mega-sync.log'),
    dest,
    link: pick(cli.link, file.link) || '',
    remote: pick(cli.remote, file.remote) || '',
    proxy: pick(cli.proxy, env.MEGA_PROXY, file.proxy) || '',
    email: pick(env.MEGA_EMAIL, file.email) || '',
    password: pick(env.MEGA_PASSWORD, file.password) || '',
    dryrun: Boolean(cli.dryrun),
    loginOnly: Boolean(cli.loginOnly),
  };

  if (!cfg.link && !cfg.remote && !cfg.loginOnly) cfg.error = '请用 --link <分享链接> 或 --remote <云盘路径>（或 --login）';
  // 需要登录的场景：会话文件存在，或同时给了邮箱+密码（只给一半是无效凭据）
  const hasCreds = Boolean(cfg.email && cfg.password);
  const hasSession = fs.existsSync(cfg.sessionFile);
  if (cfg.remote && !hasCreds && !hasSession) {
    cfg.error = '--remote 需要登录：请设 MEGA_EMAIL + MEGA_PASSWORD（或写进配置文件），或先跑 --login 生成会话';
  }
  return cfg;
}

/** 建状态目录 */
function ensureStateDir(cfg) {
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  return cfg.stateDir;
}

module.exports = {
  USAGE,
  DEFAULT_CONFIG_NAME,
  STATE_DIR_NAME,
  parseArgv,
  loadConfig,
  ensureStateDir,
};
