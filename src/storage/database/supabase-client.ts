import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import dotenv from 'dotenv';

let envLoaded = false;
let deployEnvLogged = false;
let deployEnvLoads = 0;

// scripts/deploy.env 承载部署实例凭据。部署平台的进程环境可能注入指向平台默认库的
// COZE_SUPABASE_*，必须在读取前 override，否则服务静默连错库。
//
// 调用时机：**模块加载时恰好一次**（见文件末尾的模块级调用）。
// 为什么不放在 loadEnv() 里按 envLoaded 守卫：原实现在早返回分支上从未把
// envLoaded 置位，导致本函数在【每次 getSupabaseClient()】都被调用 ——
// 同步文件读 + dotenv 解析落在数据库热路径上，且 override:true 会反复覆盖
// 进程环境，使环境变量注入、密钥轮换与单元测试全部失效（曾使 15 个测试变红，
// 其中 2 个是生产 fail-closed 安全契约）。
function loadDeployEnvFile(): void {
  try {
    const deployEnvPath = path.resolve(process.cwd(), 'scripts/deploy.env');
    if (!existsSync(deployEnvPath)) return;
    deployEnvLoads += 1;
    dotenv.config({ override: true, path: deployEnvPath });
    if (!deployEnvLogged && process.env.COZE_SUPABASE_URL) {
      deployEnvLogged = true;
      try {
        console.log(
          `[supabase-client] credentials loaded from scripts/deploy.env -> ${new URL(process.env.COZE_SUPABASE_URL).host}`,
        );
      } catch {
        // malformed URL: let downstream credential check surface it
      }
    }
  } catch {
    // optional file
  }
}

/** 测试用：deploy.env 实际被读取的次数。生产代码不应调用。 */
export function _deployEnvLoadCount(): number {
  return deployEnvLoads;
}

// ── 模块加载时应用一次部署凭据 ────────────────────────────────────────────────
// 契约：本调用是整个进程内唯一一次读取 scripts/deploy.env。
// 位置必须在模块作用域（而非任何函数内），原因见 loadDeployEnvFile 的注释：
// 函数内调用会随调用点频率重复执行，破坏环境变量优先级与密钥轮换。
// 保留 override:true 语义 —— 部署平台注入的 COZE_SUPABASE_* 指向平台默认库，
// 必须被 deploy.env 覆盖（这是 AGENTS.md「连接真相」记录的事故修复）。
loadDeployEnvFile();

// 模块级客户端缓存：按 url+key 复用 service-role 客户端实例，
// 避免 216 处调用点每请求重建 createClient 与重复 env 探测。
// 仅缓存无 token 的 service-role 客户端（带 token 的请求按用户变化，不缓存）。
const clientCache = new Map<string, SupabaseClient>();

interface SupabaseCredentials {
  url: string;
  anonKey: string;
}

function loadEnv(): void {
  if (envLoaded) return;

  // scripts/deploy.env 已在模块加载时应用一次（override:true），
  // 这里只判断凭据是否齐备，不再重复读文件。
  if (process.env.COZE_SUPABASE_URL && process.env.COZE_SUPABASE_ANON_KEY) {
    envLoaded = true;
    return;
  }

  try {
    try {
      dotenv.config();
      if (process.env.COZE_SUPABASE_URL && process.env.COZE_SUPABASE_ANON_KEY) {
        return;
      }
    } catch {
      // dotenv not available
    }

    const pythonCode = `
import os
import sys
try:
    from coze_workload_identity import Client
    client = Client()
    env_vars = client.get_project_env_vars()
    client.close()
    for env_var in env_vars:
        print(f"{env_var.key}={env_var.value}")
except Exception as e:
    print(f"# Error: {e}", file=sys.stderr)
`;

    const output = execSync(`python3 -c '${pythonCode.replace(/'/g, "'\"'\"'")}'`, {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const lines = output.trim().split('\n');
    for (const line of lines) {
      if (line.startsWith('#')) continue;
      const eqIndex = line.indexOf('=');
      if (eqIndex > 0) {
        const key = line.substring(0, eqIndex);
        let value = line.substring(eqIndex + 1);
        if ((value.startsWith("'") && value.endsWith("'")) ||
            (value.startsWith('"') && value.endsWith('"'))) {
          value = value.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  } catch {
    // Silently fail
  } finally {
    // 无论成功或失败都只探测一次：该路径依赖外部进程（python3 / 平台身份服务），
    // 重复探测既昂贵又不确定，且会让每次数据库调用都支付一次 spawn 成本。
    envLoaded = true;
  }
}

function getSupabaseCredentials(): SupabaseCredentials {
  loadEnv();

  const url = process.env.COZE_SUPABASE_URL;
  const anonKey = process.env.COZE_SUPABASE_ANON_KEY;

  if (!url) {
    throw new Error('COZE_SUPABASE_URL is not set');
  }
  if (!anonKey) {
    throw new Error('COZE_SUPABASE_ANON_KEY is not set');
  }

  return { url, anonKey };
}

function getSupabaseServiceRoleKey(): string | undefined {
  loadEnv();
  return process.env.COZE_SUPABASE_SERVICE_ROLE_KEY;
}

function buildSupabaseClient(
  url: string,
  key: string,
  token?: string,
): SupabaseClient {
  // 不用 SDK 的 createWrappedFetch 包装请求：它会在托管环境缓存/代理 PostgREST 响应，
  // 导致新建行对已构建 client 不可见，数据正确性优先于遥测。
  const globalOptions: Record<string, unknown> = {};
  if (token) {
    globalOptions.headers = { Authorization: `Bearer ${token}` };
  }
  return createClient(url, key, {
    global: globalOptions,
    db: {
      timeout: 60000,
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

export function getFreshServiceClient(): SupabaseClient {
  const { url } = getSupabaseCredentials();
  const serviceRoleKey = getSupabaseServiceRoleKey();
  if (!serviceRoleKey) {
    throw new Error(
      'COZE_SUPABASE_SERVICE_ROLE_KEY is not set — refusing to fall back to the anon key in production (COZE_PROJECT_ENV=PROD).',
    );
  }
  // 每次返回全新实例：signInWithPassword 等调用会把用户 session 存进 client
  // 内存态（persistSession:false 只跳过 storage，不跳过内存），共享单例会被
  // 污染——后续请求 Authorization 被用户 JWT 覆盖（role=authenticated），触发 RLS。
  return buildSupabaseClient(url, serviceRoleKey);
}

function getSupabaseClient(token?: string): SupabaseClient {
  const { url, anonKey } = getSupabaseCredentials();

  let key: string;
  if (token) {
    key = anonKey;
  } else {
    const serviceRoleKey = getSupabaseServiceRoleKey();
    if (!serviceRoleKey) {
      if (process.env.COZE_PROJECT_ENV === 'PROD') {
        // 生产 fail-closed：缺失 service role key 直接抛错，
        // 绝不静默回落 anon（否则漏配 env 会退化成 anon 全表读写）。
        throw new Error(
          'COZE_SUPABASE_SERVICE_ROLE_KEY is not set — refusing to fall back to the anon key in production (COZE_PROJECT_ENV=PROD).',
        );
      }
      // 非生产（本地/preview）保留 anon 回落以支持无 service key 的演示环境。
      console.warn(
        '[supabase-client] COZE_SUPABASE_SERVICE_ROLE_KEY is not set; falling back to anon key (non-production only).',
      );
      key = anonKey;
    } else {
      key = serviceRoleKey;
    }
  }

  if (!token) {
    const cacheKey = `${url}|${key}`;
    const cached = clientCache.get(cacheKey);
    if (cached) return cached;
    const client = buildSupabaseClient(url, key);
    clientCache.set(cacheKey, client);
    return client;
  }

  return buildSupabaseClient(url, key, token);
}

export { loadEnv, getSupabaseCredentials, getSupabaseServiceRoleKey, getSupabaseClient };

// 独立干净实例：专供"auth 调用 + 同 client 数据查询"混用的场景（如 resolveUserByToken）。
// supabase-js 会在 auth.getUser(token) 后把用户 JWT 写回共享 headers，让同 client 的
// PostgREST 查询降级为 authenticated 角色 → 命中 RLS（users 表自引用策略 → 0 行）。
// 此 client 从不调用 auth API，始终以 service_role 身份查询。
export function getCleanServiceClient(): SupabaseClient {
  loadEnv();
  const url = process.env.COZE_SUPABASE_URL;
  const key = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY || process.env.COZE_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('supabase credentials missing');
  return createClient(url, key, {
    db: { timeout: 60000 },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
