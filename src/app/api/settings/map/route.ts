import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';
import { protectBusinessMutation } from '@/lib/mutation-guard';
import { MAP_PROVIDERS, MAP_PROVIDER_IDS } from '@/lib/map-providers';
import { readMapConfig, saveMapConfig, testMapConnection } from '@/lib/map-config';

/**
 * 地图服务商配置（老板端）。
 *
 *   GET  /api/settings/map  —— 读当前配置（**不回显 key**，只回 key_state）
 *   PUT  /api/settings/map  —— 保存 provider / key / base_url / style / enabled
 *   POST /api/settings/map  —— 测试连接（能测什么测什么，结论写在响应里）
 *
 * ## 权限
 *
 *   · 读：`settings:read`（店长本来就有）
 *   · 写 / 测试：`customization:write` —— 这是"配置这家店怎么运转"的权限，
 *     与 src/lib/rbac.ts 里 customization:write 的定位一致；owner 有 '*' 通吃。
 *     刻意不用 `settings:write`：那会把"能改经营设置"的人一并放进来，
 *     而 key 的读写是凭据操作。
 *
 * ## 关于 key 的三条硬规则
 *
 *   1. **浏览器端地图 key 一定会被用户看到**（开发者工具里就能读到），这是客户端
 *      地图的固有限制。所以这里不假装能藏住它 —— 但设置页必须提示去厂商后台配
 *      referrer / 域名白名单，那是唯一有效的限制手段。
 *   2. 本路由**禁止回显 key**：响应里只有 `key_state`（unset/set/unreadable）。
 *      明文只在服务端内存与"下发给顾客端渲染"的那一份里出现。
 *   3. 明文绝不落库：`config_encrypted` 存的是 AES-256-GCM 密文
 *      （src/lib/crypto.ts，与 model_configs.credentials 同一套）。
 */

/** 给设置页用的 provider 目录：默认地址、key 提示、能不能在服务端验证。 */
function providerCatalog() {
  return MAP_PROVIDER_IDS.map((id) => {
    const spec = MAP_PROVIDERS[id];
    return {
      id: spec.id,
      label: spec.label,
      mode: spec.mode,
      default_base_url: spec.defaultBaseUrl,
      key_param: spec.keyParam,
      key_hint: spec.keyHint,
      attribution: spec.attribution,
      key_verifiable_server_side: spec.keyVerifiableServerSide,
      coordinate_note: spec.coordinateNote,
    };
  });
}

export async function GET(request: NextRequest) {
  let context;
  try {
    context = requireBusinessContext(await getTenantContext(request));
    requirePermission(context, 'settings:read');
  } catch (error) {
    const status = (error as { status?: number }).status === 403 ? 403 : 401;
    return NextResponse.json({ error: status === 403 ? 'forbidden' : 'unauthorized' }, { status });
  }

  let state;
  try {
    state = await readMapConfig(context.tenantId, context.businessId);
  } catch (error) {
    console.error(
      '[settings/map] read failed:',
      error instanceof Error ? error.message : error,
    );
    return NextResponse.json({ error: 'could not read the map configuration' }, { status: 500 });
  }

  return NextResponse.json({
    // 没有 map 字段时：provider 为 null、key_state 为 unset —— 界面显示"未配置"，
    // 而不是给一个默认厂商的名字（那会让老板以为已经配好了）。
    map: {
      provider: state.config?.provider ?? null,
      base_url: state.config?.baseUrl ?? '',
      style: state.config?.style ?? '',
      enabled: state.config?.enabled ?? false,
      attribution: state.config?.attribution ?? '',
      // key 本身绝不出现在这里。
      key_state: state.keyState,
      configured: state.config !== null,
    },
    providers: providerCatalog(),
    // 这条事实必须由界面转达给用户，因此在响应里也带上（前端不必自己写死文案）。
    key_visibility_note:
      '浏览器端地图 key 一定会被访问者看到（开发者工具即可读取），这是客户端地图的固有限制。'
      + '请到地图厂商后台配置 referrer / 域名白名单与用量上限 —— 那是唯一有效的限制手段。',
  });
}

async function saveMap(request: NextRequest) {
  const context = requireBusinessContext(await getTenantContext(request));

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  // 白名单取值：多余的键不进保存路径，避免"顺手把 enabled 之外的东西写进密文"。
  const result = await saveMapConfig(context.tenantId, context.businessId, {
    provider: body.provider,
    api_key: body.api_key,
    base_url: body.base_url,
    style: body.style,
    enabled: body.enabled,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error, code: result.code }, { status: 400 });
  }

  return NextResponse.json({ ok: true, provider: result.provider, key_state: result.keyState });
}

async function testMap(request: NextRequest) {
  const context = requireBusinessContext(await getTenantContext(request));

  let state;
  try {
    state = await readMapConfig(context.tenantId, context.businessId);
  } catch (error) {
    console.error('[settings/map] read before test failed:', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'could not read the map configuration' }, { status: 500 });
  }

  if (!state.config) {
    return NextResponse.json(
      {
        error: 'the map is not configured yet',
        code: 'map_not_configured',
        key_state: state.keyState,
      },
      { status: 400 },
    );
  }
  if (!state.config.enabled) {
    return NextResponse.json(
      { error: 'the map is disabled for this store', code: 'map_disabled' },
      { status: 400 },
    );
  }

  // 测试结果里带上实际请求的地址（key 已抹成 ***）：老板要能核对"打的是哪个地址"，
  // 否则一个失败结论无从排查。
  const outcome = await testMapConnection(state.config);
  return NextResponse.json({ ok: outcome.ok, provider: state.config.provider, result: outcome });
}

export const PUT = protectBusinessMutation(
  { permission: 'customization:write', action: 'settings.map.update', entity: 'integration_configs' },
  saveMap,
);

export const POST = protectBusinessMutation(
  { permission: 'customization:write', action: 'settings.map.test', entity: 'integration_configs' },
  testMap,
);
