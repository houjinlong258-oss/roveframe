import { decrypt, encrypt } from '@/lib/crypto';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import {
  MAP_PROVIDERS,
  attributionFor,
  buildSdkScriptUrl,
  buildTileUrl,
  isUsableMapBaseUrl,
  normalizeMapProvider,
  tileTemplateMissingPlaceholders,
  type MapProviderId,
  type MapRenderMode,
} from '@/lib/map-providers';

/**
 * 地图服务商配置的**服务端**读写（含 AES-256-GCM 加密）。
 *
 * ===========================================================================
 * 一、存哪里：integration_configs 里 provider = 'map' 的那一行
 * ===========================================================================
 *
 * 任务口径原本写的是"settings 单行 jsonb 的新键 map_config"。实测之后**做不到**，
 * 证据与结论都留在这里，免得下一个人再来一遍：
 *
 *   1. 只读探测 `settings?select=*`（PostgREST，本机 2026）返回的列是
 *      id / tenant_id / business_id / business / locale / ai_prefs /
 *      model_assign / delivery / wellbeing / updated_at —— **没有 map_config 列**。
 *   2. 加列需要 DDL，而本仓库当前的 DDL 通道不可用：`autoMigrate()`
 *      （src/lib/migration.ts）只有在 `DATABASE_URL` 一类 DSN 或
 *      `SUPABASE_ACCESS_TOKEN` 存在时才能执行，部署环境两者都没有；
 *      任务口径同时要求"不加迁移"。
 *   3. 就算能加，settings 现有的每一个 jsonb 列都会被各自的接口**整列覆盖**
 *      （/api/settings 的 PUT 覆盖 business/locale/ai_prefs/model_assign，
 *      /api/team/delivery 的 PATCH 覆盖 delivery）—— 把新键塞进去等于让一次
 *      "保存设置"静默抹掉地图配置。
 *
 * 因此改用 **integration_configs**：它本来就是"按 (tenant_id, business_id,
 * provider) 存一份加密凭据"的表（`credentials`/`config_encrypted` 是仓库既有做法，
 * 见 model_configs.credentials、email_accounts.credentials），唯一索引
 * `integration_configs_business_provider_idx` 正好保证"一家店一行"。
 * 明文 key 绝不落库：`config_encrypted` 里存的是 `encrypt(JSON.stringify({...}))`。
 *
 * provider 值用 `'map'`（不是 'google'/'mapbox'）：真正用哪家厂商是**配置内容**，
 * 不是行的身份。这样切换厂商不需要删旧行建新行。现有的集成页按显式 provider 键
 * 查找（erpnext/square/shopify/stripe/paypal），因此这一行不会出现在那个列表里。
 *
 * ===========================================================================
 * 二、key 的可见性（事实，不是免责声明）
 * ===========================================================================
 *
 * 浏览器端地图 key **一定会被用户看到**：SDK 模式在脚本 URL 或初始化参数里，
 * 瓦片模式在每一次 `<img src>` 的查询串里。因此本文件：
 *   · 读接口（老板端）**不回显 key**，只回 `key_state: 'set' | 'unset' | 'unreadable'`；
 *   · 下发接口（顾客端）**只下发本租户本门店**的那一份，绝不下发平台级 key；
 *   · 不做任何"混淆"—— 那改变不了事实，只会让下一个维护者以为它安全。
 *
 * ===========================================================================
 * 三、读失败与"没配置"必须分开
 * ===========================================================================
 *
 * 解密失败（例如 ENCRYPTION_SECRET 被轮换且没配 ENCRYPTION_SECRET_PREVIOUS）
 * 与"从未配置"是两件事：前者要老板看到"密钥读不出来了"，后者只是"还没配"。
 * 客户端的渲染结果是一样的（都不画地图），但老板端的 `key_state` 不同 ——
 * 把两者混成一种状态，就是在告诉商家"你没配过"，而真相是配置还在、只是读不出来。
 */

/** integration_configs 里存地图配置用的 provider 值。 */
export const MAP_CONFIG_PROVIDER = 'map';

/** `config_encrypted` 解密后的形状（**明文只在内存里**）。 */
export interface StoredMapConfig {
  /** 用哪家厂商。它存在密文里而不是行的 provider 列里 —— 那一列是 'map'（见文件头）。 */
  provider: MapProviderId | null;
  api_key: string;
  base_url: string;
  style: string;
}

export interface MapConfig {
  provider: MapProviderId;
  /** 明文 key。**只允许出现在服务端内存与浏览器渲染所需的那一份下发里**。 */
  apiKey: string;
  /** 最终生效的地址（空 base_url 已回落到该 provider 的默认值）。 */
  baseUrl: string;
  style: string;
  enabled: boolean;
  mode: MapRenderMode;
  attribution: string;
}

export type MapKeyState = 'unset' | 'set' | 'unreadable';

export interface MapConfigState {
  config: MapConfig | null;
  keyState: MapKeyState;
  rowId: string | null;
}

interface MapConfigRow {
  id: string;
  is_enabled: boolean | null;
  config_encrypted: string | null;
}

export type MapConfigRowLoader = (
  tenantId: string,
  businessId: string,
) => Promise<MapConfigRow | null>;

function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 解密后的 jsonb 一律按"任意东西"收窄，不做宽松解析。 */
export function normalizeStoredMapConfig(raw: unknown): StoredMapConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { provider: null, api_key: '', base_url: '', style: '' };
  }
  const record = raw as Record<string, unknown>;
  return {
    // 未知 provider 一律 null（= 没配置），不回落成某个默认厂商：
    // 回落会把"配置坏了"渲染成"用 Google 地图"，而那块地图永远不会加载成功。
    provider: normalizeMapProvider(record.provider),
    api_key: trimmedString(record.api_key),
    base_url: trimmedString(record.base_url),
    style: trimmedString(record.style),
  };
}

/** 真实实现：按 (tenant, business, provider='map') 取那一行。 */
export async function loadMapConfigRow(
  tenantId: string,
  businessId: string,
): Promise<MapConfigRow | null> {
  const { data, error } = await getSupabaseClient()
    .from('integration_configs')
    .select('id, is_enabled, config_encrypted')
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .eq('provider', MAP_CONFIG_PROVIDER)
    .maybeSingle();
  if (error) throw new Error(`map config read failed: ${error.message}`);
  return (data as MapConfigRow | null) ?? null;
}

function finalBaseUrl(provider: MapProviderId, stored: string): string {
  return stored || MAP_PROVIDERS[provider].defaultBaseUrl;
}

/**
 * 读**并按需解密**某门店的地图配置。
 *
 * 返回 `keyState` 而不是抛错：读不到/解不开都不是"服务器故障"，
 * 而是"这家店的地图还不能画"，UI 需要的是可展示的状态而不是 500。
 * 但**任何一条不回显 key 的路径都必须留下服务端日志**（no silent fallback）。
 */
export async function readMapConfig(
  tenantId: string,
  businessId: string,
  loadRow: MapConfigRowLoader = loadMapConfigRow,
): Promise<MapConfigState> {
  const row = await loadRow(tenantId, businessId);
  if (!row) return { config: null, keyState: 'unset', rowId: null };

  if (!row.config_encrypted) {
    // 有行但没密文：这是半配置状态（比如上一次保存被中断）。如实当成"没配置"，
    // 但仍然回 rowId，让上层能把它当成"可覆盖的一行"而不是"要新建一行"。
    return { config: null, keyState: 'unset', rowId: row.id };
  }

  let stored: StoredMapConfig;
  try {
    stored = normalizeStoredMapConfig(JSON.parse(decrypt(row.config_encrypted)) as unknown);
  } catch (error) {
    // 解不开就是解不开：不回落到"没配过"（那会让老板以为设置丢了），
    // 也不回落到空 key 继续请求（那只会拿到一堆 401）。
    console.error(
      '[map-config] stored credentials could not be decrypted:',
      error instanceof Error ? error.message : error,
    );
    return { config: null, keyState: 'unreadable', rowId: row.id };
  }

  const storedProvider = stored.provider;
  if (!storedProvider) {
    console.warn('[map-config] stored config has no known provider; treating as unconfigured');
    return { config: null, keyState: stored.api_key ? 'set' : 'unset', rowId: row.id };
  }

  const baseUrl = finalBaseUrl(storedProvider, stored.base_url);
  return {
    rowId: row.id,
    keyState: stored.api_key ? 'set' : 'unset',
    config: {
      provider: storedProvider,
      apiKey: stored.api_key,
      baseUrl,
      style: stored.style,
      enabled: row.is_enabled !== false,
      mode: MAP_PROVIDERS[storedProvider].mode,
      attribution: attributionFor(storedProvider, baseUrl),
    },
  };
}

/** 下发给浏览器的那一份形状（键名保持 snake_case，与后端其它 JSON 一致）。 */
export interface ClientMapConfig {
  provider: MapProviderId;
  mode: MapRenderMode;
  api_key: string;
  base_url: string;
  style: string;
  attribution: string;
  key_param: string;
}

/**
 * 服务端 → 浏览器的下发形态。
 *
 * `null` 的含义只有一个：**这家店没有可用的地图配置**（没配 / 被关掉 / 解不开）。
 * 调用方（顾客端追踪接口）拿到 null 时，界面必须显示"地图未配置"，
 * 而不是渲染一个空白框，更不是回落成任何编造的地图。
 */
export function toClientMapConfig(state: MapConfigState): ClientMapConfig | null {
  const { config } = state;
  if (!config || !config.enabled) return null;
  return {
    provider: config.provider,
    mode: config.mode,
    api_key: config.apiKey,
    base_url: config.baseUrl,
    style: config.style,
    attribution: config.attribution,
    key_param: MAP_PROVIDERS[config.provider].keyParam,
  };
}

export interface SaveMapConfigInput {
  provider?: unknown;
  /** undefined = 保持原 key；'' = 清除；其它字符串 = 覆盖。 */
  api_key?: unknown;
  base_url?: unknown;
  style?: unknown;
  enabled?: unknown;
}

export type SaveMapConfigResult =
  | { ok: true; keyState: MapKeyState; provider: MapProviderId }
  | { ok: false; error: string; code: string };

const MAX_KEY_LENGTH = 512;
const MAX_STYLE_LENGTH = 200;
const MAX_URL_LENGTH = 2048;

/**
 * 保存配置。校验全部在服务端做（前端校验只是体验，不是约束）。
 *
 * base_url 的三条硬规则，每条都对应一种会**静默失效**的写法：
 *   · 必须是 http(s)：`javascript:` / `data:` 会被 `<img src>` / `<script src>` 拒绝，
 *     但更糟的是它把一段可控字符串带进了 DOM 属性；
 *   · 瓦片模板必须带 {z}/{x}/{y}：少了任何一个，所有瓦片请求都会指向同一个地址，
 *     结果是"一张图铺满整个框"而没有任何报错；
 *   · custom 必须填地址：它没有默认值，空地址只会得到一片空白。
 */
export async function saveMapConfig(
  tenantId: string,
  businessId: string,
  input: SaveMapConfigInput,
  loadRow: MapConfigRowLoader = loadMapConfigRow,
): Promise<SaveMapConfigResult> {
  const provider = normalizeMapProvider(input.provider);
  if (!provider) {
    return { ok: false, error: 'unknown map provider', code: 'unknown_provider' };
  }
  const spec = MAP_PROVIDERS[provider];

  const row = await loadRow(tenantId, businessId);

  // 现有密文：本次没传 api_key 时要原样保留（PATCH 语义）。
  let existing: StoredMapConfig = { provider: null, api_key: '', base_url: '', style: '' };
  if (row?.config_encrypted) {
    try {
      existing = normalizeStoredMapConfig(
        JSON.parse(decrypt(row.config_encrypted)) as unknown,
      );
    } catch (error) {
      return {
        ok: false,
        code: 'credentials_unreadable',
        error: `stored map credentials cannot be decrypted: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      };
    }
  }

  let apiKey = existing.api_key;
  if (input.api_key !== undefined) {
    if (typeof input.api_key !== 'string') {
      return { ok: false, error: 'api_key must be a string', code: 'invalid_api_key' };
    }
    apiKey = input.api_key.trim();
    if (apiKey.length > MAX_KEY_LENGTH) {
      return { ok: false, error: `api_key must be at most ${MAX_KEY_LENGTH} characters`, code: 'invalid_api_key' };
    }
  }

  let baseUrl = existing.base_url;
  if (input.base_url !== undefined) {
    if (typeof input.base_url !== 'string') {
      return { ok: false, error: 'base_url must be a string', code: 'invalid_base_url' };
    }
    baseUrl = input.base_url.trim();
    if (baseUrl.length > MAX_URL_LENGTH) {
      return { ok: false, error: 'base_url is too long', code: 'invalid_base_url' };
    }
  }
  const effectiveBaseUrl = baseUrl || spec.defaultBaseUrl;
  if (!effectiveBaseUrl) {
    return {
      ok: false,
      code: 'base_url_required',
      error: 'this provider has no default endpoint; base_url is required',
    };
  }
  if (!isUsableMapBaseUrl(effectiveBaseUrl)) {
    return { ok: false, code: 'invalid_base_url', error: 'base_url must be an http(s) URL without spaces' };
  }
  if (spec.mode === 'tiles') {
    const missing = tileTemplateMissingPlaceholders(effectiveBaseUrl);
    if (missing.length > 0) {
      return {
        ok: false,
        code: 'invalid_tile_template',
        error: `tile template must contain ${missing.join(', ')}`,
      };
    }
  }

  let style = existing.style;
  if (input.style !== undefined) {
    if (typeof input.style !== 'string') {
      return { ok: false, error: 'style must be a string', code: 'invalid_style' };
    }
    style = input.style.trim();
    if (style.length > MAX_STYLE_LENGTH) {
      return { ok: false, error: 'style is too long', code: 'invalid_style' };
    }
  }
  // Mapbox 没有 style 就没有底图（它不接受空 style 的默认值），因此在保存时就挡住，
  // 而不是让顾客端渲染出一张灰底图。
  if (provider === 'mapbox' && !style) {
    return {
      ok: false,
      code: 'style_required',
      error: 'mapbox requires a style id (for example mapbox://styles/mapbox/streets-v12)',
    };
  }

  let enabled = row?.is_enabled !== false;
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') {
      return { ok: false, error: 'enabled must be a boolean', code: 'invalid_enabled' };
    }
    enabled = input.enabled;
  }

  const record = {
    provider: MAP_CONFIG_PROVIDER,
    // 明文只在这一行存在：encrypt() 之后落库的是密文。
    // 厂商 id 也进密文：切换厂商只改这一份内容，不需要删行建行。
    config_encrypted: encrypt(JSON.stringify({
      provider,
      api_key: apiKey,
      base_url: baseUrl,
      style,
    })),
    is_enabled: enabled,
    // status 沿用集成表的口径（见 src/lib/connectors/capabilities.ts）：
    // 保存本身**不**等于"已验证"，因此写 connectivity_only；
    // 只有测试连接真的通过时，路由才把它升成 connected。
    status: 'connectivity_only',
  };

  const client = getSupabaseClient();
  if (row?.id) {
    const { error } = await client
      .from('integration_configs')
      .update(record)
      .eq('id', row.id)
      // 双条件不是冗余：唯一键是 (tenant_id, business_id, provider)，
      // 带上它们可以保证这条 update 绝不可能写到别的门店那一行。
      .eq('tenant_id', tenantId)
      .eq('business_id', businessId);
    if (error) return { ok: false, error: `save failed: ${error.message}`, code: 'save_failed' };
  } else {
    const { error } = await client
      .from('integration_configs')
      .insert({ ...record, tenant_id: tenantId, business_id: businessId });
    if (error) return { ok: false, error: `save failed: ${error.message}`, code: 'save_failed' };
  }

  return { ok: true, keyState: apiKey ? 'set' : 'unset', provider };
}

export interface MapConnectionTest {
  ok: boolean;
  status: number | null;
  /** 这次究竟验了什么 —— 措辞必须与实际动作一致。 */
  checked: 'tile' | 'script';
  /** SDK 模式下 key 无法在服务端验证，这里如实体现在响应里。 */
  key_verified: boolean;
  /** 已把 key 替换成 *** 的地址，供老板核对"打的是哪个地址"。 */
  target: string;
  detail: string;
}

/** 把 URL 里的 key 抹掉再回显，避免测试结果把密钥带回浏览器/日志。 */
function redactKey(url: string, key: string): string {
  if (!key) return url;
  return url.split(encodeURIComponent(key)).join('***').split(key).join('***');
}

/**
 * 测试连接。**能测什么就说什么**。
 *
 *   · 瓦片模式：取一张真实瓦片（z=1/x=0/y=0）。key 无效时厂商返回 401/403，
 *     因此这是**真的**验证了 key 与地址；`key_verified: true`。
 *   · SDK 模式：只能取厂商的 JS。脚本 200 不代表 key 有效（Google 对无效 key
 *     照样返回 200，把错误留到浏览器初始化时才抛）。所以这里诚实地回
 *     `key_verified: false` —— 把"脚本可达"说成"key 有效"是虚假结论。
 */
export async function testMapConnection(
  config: MapConfig,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<MapConnectionTest> {
  const doFetch = options.fetchImpl ?? fetch;
  const spec = MAP_PROVIDERS[config.provider];

  if (spec.mode === 'tiles') {
    const url = buildTileUrl(config.baseUrl, 1, 0, 0, config.apiKey, spec.keyParam);
    return probe(url, config.apiKey, 'tile', true, doFetch);
  }

  const url = buildSdkScriptUrl(config.provider, config.baseUrl, config.apiKey);
  return probe(url, config.apiKey, 'script', false, doFetch);
}

async function probe(
  url: string,
  key: string,
  checked: 'tile' | 'script',
  keyVerified: boolean,
  doFetch: typeof fetch,
): Promise<MapConnectionTest> {
  const target = redactKey(url, key);
  try {
    const response = await doFetch(url, {
      method: 'GET',
      // 只看状态码与头部：瓦片是几十 KB 的图片，脚本是几百 KB 的 JS。
      headers: { Accept: checked === 'tile' ? 'image/*' : '*/*' },
      signal: AbortSignal.timeout(8000),
    });
    return {
      ok: response.ok,
      status: response.status,
      checked,
      key_verified: keyVerified && response.ok,
      target,
      detail: response.ok
        ? (keyVerified
          ? '瓦片服务返回成功，key 与地址可用。'
          : '厂商脚本可以取到。客户端 key 是否有效只能在浏览器里初始化时才知道。')
        : `请求返回 HTTP ${response.status}；请核对 key、地址与厂商侧的域名白名单。`,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      checked,
      key_verified: false,
      target,
      detail: `请求失败：${error instanceof Error ? error.message : 'unknown error'}`,
    };
  }
}
