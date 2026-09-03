/**
 * Sprint 6 — AI Coding Agent
 * proposal-store.ts
 *
 * In-memory ring buffer for CodingProposals (max 200).
 * Supports retrieval by id, task id, and status filtering.
 * No Supabase dependency — works before migration is applied.
 */

import { CodingProposal, ProposalStatus } from './types';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

const MAX_PROPOSALS = 200;
const _store: CodingProposal[] = [];

// 演示模式（RF_E2E_DEMO=1 且非生产）：内存库以 JSON 文件为后备。
// 原因：dev 模式下每个路由冷编译持有独立模块实例，纯内存状态在
// 图之间不可共享；文件后备让 demo 在所有图之间看到同一份数据。
// 生产环境永不启用。
const DEMO_MODE =
  process.env.RF_E2E_DEMO === '1' && process.env.COZE_PROJECT_ENV !== 'PROD';
const DEMO_FILE = path.join(process.cwd(), '.demo', 'coding-proposals.json');

function _loadFromDisk(): void {
  if (!DEMO_MODE) return;
  // 重试 3 次：容忍并发写入造成的瞬时读取失败；绝不把"读失败"当"空库"，
  // 否则种子判重会误判并覆盖真实状态（演练中实际踩到）
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (!existsSync(DEMO_FILE)) return;
      const rows = JSON.parse(readFileSync(DEMO_FILE, 'utf8')) as CodingProposal[];
      _store.length = 0;
      _store.push(...rows);
      return;
    } catch {
      // torn read — 保留当前内存态并重试
    }
  }
}

function _persistToDisk(): void {
  if (!DEMO_MODE) return;
  try {
    mkdirSync(path.dirname(DEMO_FILE), { recursive: true });
    // 原子写：先写临时文件再 rename，读者永远不会读到写了一半的 JSON
    const tmp = `${DEMO_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(_store), 'utf8');
    renameSync(tmp, DEMO_FILE);
  } catch {
    // 演示持久化失败不阻断
  }
}

function _trim(): void {
  if (_store.length > MAX_PROPOSALS) {
    _store.splice(0, _store.length - MAX_PROPOSALS);
  }
}

/** Persist a new proposal. */
export function saveProposal(proposal: CodingProposal): void {
  _loadFromDisk();
  _store.push(proposal);
  _trim();
  _persistToDisk();
}

/** Retrieve all proposals, newest first. */
export function listProposals(limit = 50): CodingProposal[] {
  _loadFromDisk();
  return [..._store].reverse().slice(0, limit);
}

/** Find by id. */
export function getProposalById(id: string): CodingProposal | undefined {
  _loadFromDisk();
  return _store.find((p) => p.id === id);
}

/** Find by taskId. */
export function getProposalsByTaskId(taskId: string): CodingProposal[] {
  _loadFromDisk();
  return _store.filter((p) => p.taskId === taskId);
}

/** Update proposal status (approve / reject). */
export function updateProposalStatus(
  id: string,
  status: ProposalStatus
): CodingProposal | undefined {
  _loadFromDisk();
  const proposal = _store.find((p) => p.id === id);
  if (proposal) {
    proposal.status = status;
    _persistToDisk();
  }
  return proposal;
}

/** Clear store (used by tests). */
export function clearProposalStore(): void {
  _store.length = 0;
  _persistToDisk();
}

/**
 * 演示模式落盘（仅供 persistent-store 在合并 patch/meta 后调用）。
 * 非演示模式为空操作。
 */
export function persistDemoIfNeeded(): void {
  _persistToDisk();
}

/** 演示用：后备文件是否已存在（存在即视为已播种，防止跨模块图重复播种覆盖状态） */
export function demoStoreFileExists(): boolean {
  return DEMO_MODE && existsSync(DEMO_FILE);
}

/** Total stored proposals count. */
export function proposalStoreSize(): number {
  return _store.length;
}
