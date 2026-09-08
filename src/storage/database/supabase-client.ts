import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { execSync } from 'child_process';
import { getReportBuffer, createWrappedFetch } from 'coze-coding-dev-sdk';
import dotenv from 'dotenv';

let envLoaded = false;

// 模块级客户端缓存：按 url+key 复用 service-role 客户端实例，
// 避免 216 处调用点每请求重建 createClient 与重复 env 探测。
// 仅缓存无 token 的 service-role 客户端（带 token 的请求按用户变化，不缓存）。
const clientCache = new Map<string, SupabaseClient>();

interface SupabaseCredentials {
  url: string;
  anonKey: string;
}

function loadEnv(): void {
  if (envLoaded || (process.env.COZE_SUPABASE_URL && process.env.COZE_SUPABASE_ANON_KEY)) {
    return;
  }

  try {
    try {
      dotenv.config();
      if (process.env.COZE_SUPABASE_URL && process.env.COZE_SUPABASE_ANON_KEY) {
        envLoaded = true;
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

    envLoaded = true;
  } catch {
    // Silently fail
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
  const globalOptions: Record<string, unknown> = {};
  if (token) {
    globalOptions.headers = { Authorization: `Bearer ${token}` };
  }
  try {
    const buffer = getReportBuffer();
    if (buffer) {
      globalOptions.fetch = createWrappedFetch(buffer, 'supabase');
    }
  } catch {
    // Silent — reporting setup failure should not block client creation
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
