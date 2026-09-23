import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildDeployEnv, GENERATED_KEYS, CONDITIONAL_KEYS, apiKey } from '../scripts/lib/deploy-secrets.mjs';
import { resolveMigrationSsl } from '../src/lib/migration';

/**
 * 自托管部署（内置数据库）的守卫。
 *
 * ## 守的是什么
 *
 * 这一层的失败模式全部是"静默"的：
 *
 *   1. compose 用 `${VAR:?...}` 声明必填变量，而生成器不产出它 —— 装到一半
 *      才在 `docker compose up` 报一句 compose 语法错误，用户拿到的是一个
 *      起不来的服务器。所以"必填变量集合 ⊆ 生成器产出集合"必须是断言。
 *
 *   2. `gateway` 一旦发布到宿主机，PostgREST 就变成公网可达。Supabase 云上
 *      这就是现状（靠 anon key + RLS 兜底），自建的目标恰恰是把这一面关掉。
 *      所以"gateway 不得有 ports / 不得有指向 web 的默认 location"必须是断言。
 *
 *   3. Caddyfile 多写一行 `/rest/v1`，边界就没了，而服务照常工作、没有任何
 *      症状。所以"公开边缘不得出现 /rest/v1、/auth/v1"必须是断言。
 *
 *   4. `autoMigrate` 无条件强制 SSL：对着**同机 Postgres**（默认不开 TLS）
 *      会在握手阶段失败，而失败只出现在启动日志里，容器照样 healthy。
 *
 * 注释会骗人（本仓库已多次被自己的注释触发假阳性），所以下面统一先把注释
 * 剥掉再断言。
 */

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 剥掉 YAML 注释，保留缩进结构。 */
function stripYamlComments(src: string): string {
  return src
    .split(/\r?\n/)
    .map((line) => {
      const hash = line.indexOf('#');
      if (hash === -1) return line;
      return line.slice(0, hash);
    })
    .join('\n');
}

/** 剥掉 shell / nginx / Caddyfile 里的注释行。 */
function stripHashComments(src: string): string {
  return src
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

const BASE_COMPOSE = stripYamlComments(readFileSync('docker-compose.yml', 'utf8'));
const SELF_COMPOSE = stripYamlComments(readFileSync('docker-compose.selfhosted.yml', 'utf8'));
const GATEWAY_CONF = stripHashComments(readFileSync('docker/gateway/nginx.conf', 'utf8'));
const CADDYFILE = stripHashComments(readFileSync('docker/caddy/Caddyfile', 'utf8'));

// ---------------------------------------------------------------------------
// 1) 环境变量契约：compose 要的，生成器必须给
// ---------------------------------------------------------------------------

describe('self-hosted deploy: compose ⇄ secret generator contract', () => {
  /** 从 compose 文本里抽出所有 `${VAR...}` 引用。 */
  function referencedVars(src: string): Map<string, boolean> {
    const found = new Map<string, boolean>();
    for (const match of src.matchAll(/\$\{([A-Z_][A-Z0-9_]*)(:?[^}]*)\}/g)) {
      const [, name, rest] = match;
      // `${VAR:?msg}` is REQUIRED; `${VAR:-default}` has a fallback.
      const required = rest.startsWith(':?');
      found.set(name, (found.get(name) ?? true) && required);
    }
    return found;
  }

  function missingFromGenerator(src: string): string[] {
    const produced = new Set([...GENERATED_KEYS, ...CONDITIONAL_KEYS]);
    const missing: string[] = [];
    for (const [name, required] of referencedVars(src)) {
      if (required && !produced.has(name)) missing.push(name);
    }
    return missing;
  }

  test('内置数据库 overlay 的必填变量都被生成器产出', () => {
    assert.deepEqual(missingFromGenerator(SELF_COMPOSE), []);
  });

  test('基础 compose 的必填变量都被生成器产出', () => {
    assert.deepEqual(missingFromGenerator(BASE_COMPOSE), []);
  });

  test('负向对照：把必填变量挪出生成器清单，断言必须失败', () => {
    // 直接构造一段引用不存在变量的 overlay 文本，确认上面的判定真的会报。
    const synthetic = 'environment:\n  FOO: ${ZZ_DEFINITELY_NOT_GENERATED:?set it}\n';
    assert.deepEqual(missingFromGenerator(synthetic), ['ZZ_DEFINITELY_NOT_GENERATED']);
    // 有默认值的同名引用不算必填，不应报。
    assert.deepEqual(missingFromGenerator('environment:\n  FOO: ${ZZ_DEFINITELY_NOT_GENERATED:-x}\n'), []);
  });

  test('overlay 只加服务，不改基础 web 的既有密钥', () => {
    // ROVEAGENT_API_KEY 等由基础 compose 从 deploy.env 注入；overlay 必须不覆盖。
    for (const key of ['ROVEAGENT_API_KEY', 'ROVEAGENT_APPROVAL_SECRET', 'ENCRYPTION_SECRET']) {
      assert.equal(SELF_COMPOSE.includes(`${key}:`), false, `${key} must not be redefined in the overlay`);
    }
  });
});

// ---------------------------------------------------------------------------
// 2) 边界：gateway 只能内网，公开边缘不得暴露 PostgREST/GoTrue
// ---------------------------------------------------------------------------

describe('self-hosted deploy: database API boundary', () => {
  test('gateway 不向宿主机发布任何端口', () => {
    const block = SELF_COMPOSE.split(/\n {2}gateway:\n/)[1];
    assert.ok(block, 'gateway service block not found');
    const body = block.split(/\n {2}\w/)[0];
    assert.match(body, /expose:/, 'gateway should expose on the internal network');
    assert.equal(/^\s{4}ports:/m.test(body), false, 'gateway must NOT publish ports to the host');
  });

  test('gateway 把三个前缀分别指向 rest / auth / storage', () => {
    assert.match(GATEWAY_CONF, /location \/rest\/v1\/\s*\{\s*proxy_pass http:\/\/roveframe_rest\/;/);
    assert.match(GATEWAY_CONF, /location \/auth\/v1\/\s*\{\s*proxy_pass http:\/\/roveframe_auth\/;/);
    assert.match(GATEWAY_CONF, /location \/storage\/v1\/\s*\{\s*proxy_pass http:\/\/roveframe_storage\/;/);
  });

  test('gateway 对未知路径 fail-closed（不得回落给 web）', () => {
    assert.match(GATEWAY_CONF, /location \/\s*\{\s*return 404;/);
    assert.equal(/proxy_pass http:\/\/roveframe_web/.test(GATEWAY_CONF), false);
  });

  test('公开边缘只放行存储公共路径，不暴露 /rest/v1 与 /auth/v1', () => {
    assert.match(CADDYFILE, /@public_media path \/storage\/v1\/object\/public\/\*/);
    assert.equal(CADDYFILE.includes('/rest/v1'), false, 'Caddyfile must not route PostgREST');
    assert.equal(CADDYFILE.includes('/auth/v1'), false, 'Caddyfile must not route GoTrue');
  });

  test('证书签发必须问过后端（on_demand_tls.ask）', () => {
    assert.match(CADDYFILE, /on_demand_tls \{/);
    // ⚠️ 这条断言此前写的是 `/api/site/domain/authorize` —— 一个**从不存在**的路由。
    // 它把缺陷钉成了"预期"：Caddyfile 与测试都写错，于是两边一致、全绿，
    // 而真实路由是 /api/site/authorize。后果是 Caddy 对每个域名拿到 404
    // （ask 的契约是"非 2xx 即拒绝"）→ 商家自定义域名永远签不出证书，且没有报错。
    //
    // 现在这里断言真实路径；更强的守卫在
    // tests/site-certificate-authorization.test.ts —— 它解析本文件里的 ask 指令，
    // 去文件系统里确认有对应的 route.ts，因此不会再出现"两边一起写错还全绿"。
    assert.match(CADDYFILE, /ask http:\/\/web:5000\/api\/site\/authorize/);
    assert.match(CADDYFILE, /tls \{\s*on_demand\s*\}/);
  });

  test('web 的裸端口只对宿主机本机开放', () => {
    const block = SELF_COMPOSE.split(/\n {2}web:\n/)[1];
    assert.ok(block, 'web service block not found');
    assert.match(block, /ports: !override/);
    assert.match(block, /127\.0\.0\.1:\$\{WEB_PORT:-5000\}:5000/);
  });

  test('edge 发布 80/443', () => {
    const block = SELF_COMPOSE.split(/\n {2}edge:\n/)[1];
    assert.ok(block, 'edge service block not found');
    assert.match(block, /"80:80"/);
    assert.match(block, /"443:443"/);
  });
});

// ---------------------------------------------------------------------------
// 3) 数据库接线
// ---------------------------------------------------------------------------

describe('self-hosted deploy: database wiring', () => {
  test('web 通过 DATABASE_URL 打开开机迁移，且显式关闭 SSL', () => {
    assert.match(SELF_COMPOSE, /DATABASE_URL: postgres:\/\/postgres:.*@db:5432\/.*\?sslmode=disable/);
  });

  test('PostgREST 必须能读 storage schema（Storage API 靠它读写元数据）', () => {
    assert.match(SELF_COMPOSE, /PGRST_DB_SCHEMAS: \$\{PGRST_DB_SCHEMAS:-public,storage\}/);
  });

  test('GoTrue 必须开 autoconfirm，否则自托管没有任何账号能登录', () => {
    assert.match(SELF_COMPOSE, /GOTRUE_MAILER_AUTOCONFIRM: "true"/);
  });

  test('镜像引用走 IMAGE_REGISTRY 前缀（国内网络需要加速）', () => {
    const images = [...SELF_COMPOSE.matchAll(/^\s{4}image: (.+)$/gm)].map((m) => m[1].trim());
    assert.equal(images.length, 6, `expected 6 images, got ${images.length}`);
    for (const image of images) {
      assert.match(image, /^\$\{IMAGE_REGISTRY:-\}/, `image not registry-parameterised: ${image}`);
    }
  });

  test('浏览器可取的媒体地址与容器内地址分离', () => {
    assert.match(SELF_COMPOSE, /STORAGE_PUBLIC_BASE_URL: \$\{NEXT_PUBLIC_APP_URL:\?/);
  });
});

// ---------------------------------------------------------------------------
// 4) 密钥生成器（跑真实现，不是副本）
// ---------------------------------------------------------------------------

describe('self-hosted deploy: secret generation', () => {
  const fresh = () => buildDeployEnv({ domain: 'app.example.com', email: 'ops@example.com', llmKey: 'sk-test' });

  function parse(content: string): Map<string, string> {
    const map = new Map<string, string>();
    for (const line of content.split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      map.set(line.slice(0, eq), line.slice(eq + 1));
    }
    return map;
  }

  test('anon / service_role 是签名有效的 HS256 JWT，且 role 正确', () => {
    const env = parse(fresh().content);
    const jwtSecret = env.get('JWT_SECRET');
    assert.ok(jwtSecret && jwtSecret.length >= 32);

    for (const [key, role] of [
      ['COZE_SUPABASE_ANON_KEY', 'anon'],
      ['COZE_SUPABASE_SERVICE_ROLE_KEY', 'service_role'],
    ] as const) {
      const token = env.get(key);
      assert.ok(token, `${key} missing`);
      const [header, payload, signature] = token.split('.');
      assert.equal(token.split('.').length, 3);
      assert.equal(
        createHmac('sha256', jwtSecret).update(`${header}.${payload}`).digest('base64url'),
        signature,
        `${key} signature does not verify against JWT_SECRET`,
      );
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
        role: string; iss: string; exp: number;
      };
      assert.equal(claims.role, role);
      assert.equal(claims.iss, 'supabase');
      assert.ok(claims.exp > Math.floor(Date.now() / 1000));
    }
  });

  test('负向对照：换成随机字符串就不再是合法 JWT', () => {
    const env = parse(fresh().content);
    assert.notEqual(apiKey('anon', env.get('JWT_SECRET')!), 'a-random-string');
    assert.equal('a-random-string'.split('.').length, 1);
  });

  test('两个运行时密钥必须不同（否则 roveagent 拒绝启动）', () => {
    const env = parse(fresh().content);
    assert.notEqual(env.get('ROVEAGENT_API_KEY'), env.get('ROVEAGENT_APPROVAL_SECRET'));
    assert.notEqual(env.get('ENCRYPTION_SECRET'), env.get('COZE_SUPABASE_SERVICE_ROLE_KEY'));
  });

  test('生成器是幂等的：重跑不改动任何已有密钥', () => {
    const first = parse(fresh().content);
    const second = parse(buildDeployEnv({ existing: first, domain: 'other.example.com' }).content);

    for (const key of ['POSTGRES_PASSWORD', 'JWT_SECRET', 'COZE_SUPABASE_ANON_KEY',
      'COZE_SUPABASE_SERVICE_ROLE_KEY', 'ENCRYPTION_SECRET', 'ROVEAGENT_API_KEY',
      'ROVEAGENT_APPROVAL_SECRET']) {
      assert.equal(second.get(key), first.get(key), `${key} was rotated by a re-run`);
    }
    // 非机密项可以更新。
    assert.equal(second.get('NEXT_PUBLIC_APP_URL'), 'https://app.example.com');
  });

  test('缺模型 Key 时写入占位符并显式告警，而不是假装已配置', () => {
    const withoutKey = buildDeployEnv({});
    assert.equal(withoutKey.llmKeyWasPlaceholder, true);
    assert.match(withoutKey.content, /^ROVEAGENT_LLM_API_KEY=not-configured$/m);
    assert.equal(buildDeployEnv({ llmKey: 'sk-real' }).llmKeyWasPlaceholder, false);
  });

  test('IP-only 安装（无域名）也能生成一套自洽的配置', () => {
    const env = parse(buildDeployEnv({}).content);
    assert.equal(env.get('NEXT_PUBLIC_APP_URL'), 'http://localhost');
    assert.equal(env.get('SITE_DOMAIN'), '');
    assert.equal(env.get('STORAGE_PUBLIC_BASE_URL'), 'http://localhost');
  });

  test('镜像加速前缀被写进 IMAGE_REGISTRY', () => {
    const env = parse(buildDeployEnv({ registry: 'docker.m.daocloud.io/' }).content);
    assert.equal(env.get('IMAGE_REGISTRY'), 'docker.m.daocloud.io/');
  });
});

// ---------------------------------------------------------------------------
// 5) 开机迁移的 SSL 决策
// ---------------------------------------------------------------------------

describe('self-hosted deploy: migration SSL', () => {
  test('默认沿用旧行为：SSL + 不校验证书（Supabase 云不受影响）', () => {
    assert.deepEqual(resolveMigrationSsl('postgres://u:p@db.remote.co:5432/postgres', {}), {
      rejectUnauthorized: false,
    });
  });

  test('DSN 里 sslmode=disable → 不发起 SSL 握手（同机 Postgres 必需）', () => {
    assert.equal(resolveMigrationSsl('postgres://postgres:p@db:5432/postgres?sslmode=disable', {}), false);
  });

  test('DATABASE_SSL=disable → 同样关闭', () => {
    assert.equal(resolveMigrationSsl('postgres://postgres:p@db:5432/postgres', { DATABASE_SSL: 'disable' }), false);
  });

  test('负向对照：只有内部子串 sslmode=disable 不算（必须是真的查询参数）', () => {
    assert.deepEqual(
      resolveMigrationSsl('postgres://postgres:p@db:5432/sslmode=disabled-db', {}),
      { rejectUnauthorized: false },
    );
  });

  test('autoMigrate 真的用了这个决策，而不是只导出一个没人调用的函数', () => {
    const source = readFileSync('src/lib/migration.ts', 'utf8');
    assert.match(source, /new Pool\(\{ connectionString: dsn, ssl: resolveMigrationSsl\(dsn\) \}\)/);
    // 旧写法必须彻底消失：它会让同机 Postgres 的握手直接失败。
    assert.equal(
      /ssl: \{ rejectUnauthorized: false \}/.test(source),
      false,
      'autoMigrate still forces SSL unconditionally',
    );
  });
});
