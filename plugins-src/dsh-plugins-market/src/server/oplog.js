/**
 * dsh-plugins-market —— 服务器半：操作日志
 *
 * 每一次装前检查 / 安装 / 回滚都落一行 JSONL。装坏过之后最需要的就是
 * 「当时到底做了什么、用的哪个 tarball、pnpm 退出了多少」。
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir, ensureDir } from './util.js';

const MAX_BYTES = 4 * 1024 * 1024;

export function oplogFile() {
  return path.join(ensureDir(resolveDataDir()), 'operations.jsonl');
}

export function appendOp(record) {
  try {
    const line = `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...record })}\n`;
    const file = oplogFile();
    fs.appendFileSync(file, line, 'utf8');
    trimIfNeeded(file);
    return true;
  } catch {
    return false;
  }
}

function trimIfNeeded(file) {
  try {
    const st = fs.statSync(file);
    if (st.size <= MAX_BYTES) return;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    fs.writeFileSync(file, lines.slice(-2000).join('\n'), 'utf8');
  } catch { /* 忽略 */ }
}

export function readOpTail(n = 200) {
  try {
    const file = oplogFile();
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines
      .slice(-Math.max(1, Math.min(2000, n)))
      .map((l) => {
        try { return JSON.parse(l); } catch { return { at: null, raw: l }; }
      })
      .reverse();
  } catch {
    return [];
  }
}

export function clearOpLog() {
  try {
    fs.writeFileSync(oplogFile(), '', 'utf8');
    return true;
  } catch {
    return false;
  }
}
