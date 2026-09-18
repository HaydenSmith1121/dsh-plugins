/**
 * dsh-plugins-market —— 服务器半：已装状态判定 + 用户数据（点赞 / 收藏）
 *
 * 这个模块回答两个界面最常问、而 dsh 自己回答不了的问题：
 *
 *   ① 「这个插件我装了吗？装的是不是最新版？」
 *      dsh 的 profile 只知道「声明了什么」，不知道「仓库里现在有什么」。
 *      照搬「bundles 里有包名 → 显示已安装」会得出一个**错的结论**：
 *      dsh-opencode-go-plus 在 0.2.1 时就真实发生过这种情况 ——
 *      包在、bundles 在、界面显示「已安装」，但仓库里已经有 0.3.0，
 *      而 GUI 里那个蓝色的「安装」按钮点下去只是把 0.2.1 又装了一遍。
 *
 *   ② 「哪些是我点过赞 / 收藏过的？」
 *      这两件事纯属本机偏好，不该进目录、也不该进 profile，
 *      所以落在 $DSH_HOME/storages/dsh-plugins-market/user-data.json。
 *
 * ★ 判定原则：**不确定就不下结论**。
 *   面向公共索引的条目（github: / npm:）永远拿不到「仓库里是什么版本」，
 *   这时一律返回 unknown，界面既不显示「更新」也不置灰按钮 ——
 *   宁可少一个提示，也不能把「无法判断」说成「已是最新」。
 */

import path from 'node:path';
import fs from 'node:fs';
import { readJsonSafe, writeJsonAtomic, resolveDataDir, compareVersions } from './util.js';
import { scanInstalled, extractVersionFromSpec, resolveLocalSpecPath } from './profile.js';

// ─────────────────────────────────────────────────────────────
// 最新版本解析
// ─────────────────────────────────────────────────────────────

/**
 * 解析某个条目的「安装规格里现在指向什么版本」。
 *
 * 三种来源，优先级从高到低：
 *   1. file: 规格里的 tarball 文件名（`…-0.3.0.tgz`）—— 最可靠，就是它要装的东西
 *   2. 目录条目的 version 字段（已验证 / 已审核层由仓库生成，可信）
 *   3. 目录声明了显式 spec 版本（npm 层 `dsh-memory@0.1.0`）
 *
 * @returns {{version:string|null, source:string|null, reason:string|null}}
 */
export function resolveTargetVersion(entry) {
  const spec = entry?.install?.spec ?? null;
  if (typeof spec === 'string' && spec.trim() !== '') {
    const fromSpec = extractVersionFromSpec(spec);
    if (fromSpec) return { version: fromSpec, source: 'spec', reason: null };
  }
  // spec 是 file:/link: 却取不出版本 → 这条规格本身指向别处，别硬猜
  if (typeof spec === 'string' && /^(file|link):/i.test(spec.trim())) {
    return { version: null, source: null, reason: 'file: 规格里没有版本号，无法判断仓库里是哪个版本' };
  }

  if (entry?.version) return { version: String(entry.version), source: 'catalog', reason: null };

  const kind = entry?.install?.kind ?? null;
  return {
    version: null,
    source: null,
    reason: kind === 'github' || kind === 'npm'
      ? '公共索引条目拿不到「仓库里现在是哪个版本」，无法比较'
      : null,
  };
}

/** 已安装版本：优先 node_modules 里真实存在的那个，其次按 file: 文件名反推 */
function installedVersionOf(inst) {
  if (inst.installedVersion) return inst.installedVersion;
  return extractVersionFromSpec(inst.spec);
}

/**
 * 给一个目录条目算出它的安装状态。
 *
 * status 取值：
 *   not-installed  没装 → 「安装」可用
 *   current        装的就是仓库里这一版 → 「安装」置灰，显示「已是最新」
 *   upgradable     装了、但仓库里有更新的版本 → 主按钮变成「更新到 x.y.z」
 *   older          装了、但装的是**比仓库更新**的版本（很少见，降级场景）→ 不置灰，交给用户
 *   unknown        装了，但版本无法比较 → 不置灰（不能因为「算不出来」就拦住用户）
 *
 * @param {object} entry 归一化条目
 * @param {object} inst  scanInstalled() 里对应的一项（可为 null）
 */
export function describeInstallState(entry, inst) {
  const target = resolveTargetVersion(entry);

  if (!inst) {
    return {
      status: 'not-installed',
      installed: false,
      installedVersion: null,
      target: target.version,
      latest: target.version,
      source: target.source,
      reason: null,
      inBundles: false,
      mismatch: false,
      canInstall: true,
      canUpgrade: false,
      action: 'install',
      // 界面上要显示「已是最新」时用得上
      isLatest: false,
    };
  }

  const installedVersion = installedVersionOf(inst);
  const base = {
    installed: true,
    installedVersion,
    target: target.version,
    latest: target.version,
    source: target.source,
    inBundles: Boolean(inst.inBundles),
    mismatch: Boolean(inst.mismatch),
  };

  if (!inst.installed) {
    // 声明在 dependencies 里、node_modules 里却没有 —— 这是坏状态，不该被当成「已装」
    return {
      ...base,
      status: 'not-installed',
      reason: 'dependencies 里有它，但 node_modules 里没有（上次安装没完成？）',
      canInstall: true,
      canUpgrade: false,
      action: 'install',
      isLatest: false,
    };
  }

  if (!target.version) {
    return {
      ...base,
      status: 'unknown',
      reason: target.reason ?? '无法判断仓库里的最新版本',
      canInstall: true,
      canUpgrade: false,
      action: 'install',
      isLatest: false,
    };
  }

  const cmp = installedVersion ? compareVersions(installedVersion, target.version) : null;

  if (cmp === null) {
    return {
      ...base,
      status: 'unknown',
      reason: installedVersion
        ? `已装 ${installedVersion}，目录里是 ${target.version}，但版本号无法比较`
        : 'node_modules 里读不到版本号，无法比较',
      canInstall: true,
      canUpgrade: false,
      action: 'install',
      isLatest: false,
    };
  }

  if (cmp === 0) {
    return {
      ...base,
      status: 'current',
      reason: null,
      canInstall: false, // ★ 已经是这一版了，安装按钮置灰
      canUpgrade: false,
      action: 'current',
      isLatest: true,
    };
  }

  if (cmp < 0) {
    return {
      ...base,
      status: 'upgradable',
      reason: `已装 ${installedVersion}，仓库里是 ${target.version}`,
      canInstall: true,
      canUpgrade: true,
      action: 'update',
      isLatest: false,
    };
  }

  return {
    ...base,
    status: 'older',
    reason: `已装 ${installedVersion}，比目录里的 ${target.version} 更新`,
    canInstall: true,
    canUpgrade: false,
    action: 'install',
    isLatest: false,
  };
}

/** 把已装清单做成「包名 → 状态」的查找表，避免每个条目都线性扫一遍 */
export function installStateIndex(profile, env = process.env, entries = []) {
  const installed = scanInstalled(profile, env);
  const byName = new Map(installed.map((i) => [i.name, i]));
  const out = new Map();
  for (const entry of entries) {
    const name = entry.package ?? entry.id;
    out.set(entry.id, describeInstallState(entry, byName.get(name) ?? null));
  }
  return { index: out, installed };
}

/** 「已安装插件列表」页要用的汇总：每个依赖 + 它能不能升级 */
export function installedOverview(profile, env = process.env, entries = []) {
  const { index, installed } = installStateIndex(profile, env, entries);
  const byPackage = new Map();
  for (const entry of entries) {
    const name = entry.package ?? entry.id;
    const st = index.get(entry.id);
    // 同名的多条（公共索引里常见）取「最能说明问题」的那条
    const prev = byPackage.get(name);
    if (!prev || rankState(st) > rankState(prev)) {
      byPackage.set(name, { ...st, entryId: entry.id });
    }
  }
  return installed.map((i) => {
    const st = byPackage.get(i.name) ?? null;
    return {
      name: i.name,
      spec: i.spec,
      specVersion: i.specVersion,
      installed: i.installed,
      installedVersion: i.installedVersion,
      isBundle: i.isBundle,
      inBundles: i.inBundles,
      mismatch: Boolean(i.mismatch),
      hasClient: i.hasClient,
      // 目录里有没有它 —— 没有就说明是手工/别处装的，市场管不到
      inCatalog: Boolean(st),
      targetVersion: st?.target ?? null,
      upgrade: st?.status === 'upgradable',
      state: st?.status ?? 'unknown',
      stateReason: st?.reason ?? (i.inBundles ? null : '不在 dsh.profile.bundles 中，装了也不会加载'),
    };
  });
}

function rankState(st) {
  if (!st) return 0;
  if (st.status === 'upgradable') return 4;
  if (st.status === 'current') return 3;
  if (st.status === 'unknown') return 2;
  return 1;
}

/** file: 规格指向的 tarball 还在不在 —— 「更新」按钮要不要禁用的前置判断 */
export function localSpecStatus(inst, profileDir) {
  if (!inst) return { local: false, exists: true, path: null };
  const p = resolveLocalSpecPath(inst.spec, profileDir);
  if (!p) return { local: false, exists: true, path: null };
  return { local: true, exists: fs.existsSync(p), path: p };
}

// ─────────────────────────────────────────────────────────────
// 用户数据：点赞 / 收藏
// ─────────────────────────────────────────────────────────────

const USER_DATA_FILE = 'user-data.json';
const SCHEMA_VERSION = 1;

export function userDataFile(env = process.env) {
  return path.join(resolveDataDir(env), USER_DATA_FILE);
}

function emptyStore() {
  return { schemaVersion: SCHEMA_VERSION, updatedAt: null, items: {} };
}

/**
 * 读取用户数据。
 *
 * 刻意**不做迁移**也不做 schema 校验失败时的兜底写回 —— 文件坏了就当空的读，
 * 但绝不覆盖它：里面是用户自己点出来的东西，宁可丢一次显示，也不能丢数据。
 */
export function readUserData(env = process.env) {
  const data = readJsonSafe(userDataFile(env));
  if (!data || typeof data !== 'object' || typeof data.items !== 'object' || data.items === null) {
    return emptyStore();
  }
  return {
    schemaVersion: data.schemaVersion ?? SCHEMA_VERSION,
    updatedAt: data.updatedAt ?? null,
    items: data.items ?? {},
  };
}

function writeUserData(store, env = process.env) {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    items: store.items,
  };
  writeJsonAtomic(userDataFile(env), payload);
  return payload;
}

const MAX_KEY = 200;

function normalizeKey(id) {
  const key = String(id ?? '').trim();
  if (key === '' || key.length > MAX_KEY) return null;
  return key;
}

/**
 * 切换收藏。
 *
 * ★ 0.5.0 删掉了点赞。它和收藏在数据形状上一模一样，区别只是「一个数字大一点好看」
 *   —— 而这个数字**只统计你自己点过的**（本插件没有后端，没有别人的赞可看）。
 *   一个只有自己看得见、含义又与收藏重复的按钮，纯粹是界面噪音。
 *   收藏留着：它有实际用处（「我收藏的」筛选，找得回装过/想装的插件）。
 *
 * ★ 历史数据不删：老用户落盘过 `liked: true` 的条目原样留在文件里，
 *   只是不再读它、也不再展示。主动删用户的数据文件比留着一个没用的键更糟。
 *
 * @param {'favorite'} action
 * @param {string} id
 * @param {boolean|undefined} desired 给定值则设为该值（幂等），不给则反转
 */
export function toggleUserMark(action, id, desired, env = process.env) {
  if (action !== 'favorite') throw new Error(`未知的用户标记：${action}（只支持 favorite）`);
  const key = normalizeKey(id);
  if (!key) throw new Error('缺少插件 id');

  const store = readUserData(env);
  const prev = store.items[key] ?? {};
  const next = desired === undefined ? !prev.favorited : Boolean(desired);

  // 取消收藏时把这一条删掉（历史遗留的 liked 一并带走），文件不会随浏览历史无限膨胀
  if (!next) delete store.items[key];
  else store.items[key] = { ...prev, favorited: true, updatedAt: new Date().toISOString() };

  const saved = writeUserData(store, env);
  return { id: key, favorited: Boolean(store.items[key]?.favorited), updatedAt: saved.updatedAt };
}

/** 汇总：{ [id]: { favorited, updatedAt } } */
export function userMarks(env = process.env) {
  return readUserData(env).items;
}

/** 给一批条目附上用户标记（列表接口用） */
export function attachMarks(entries, env = process.env) {
  const marks = userMarks(env);
  return entries.map((e) => {
    const m = marks[e.id] ?? null;
    return { ...e, favorited: Boolean(m?.favorited) };
  });
}

export function userDataStats(env = process.env) {
  const store = readUserData(env);
  const items = Object.values(store.items);
  return {
    file: userDataFile(env),
    favorited: items.filter((i) => i.favorited).length,
    updatedAt: store.updatedAt,
  };
}
