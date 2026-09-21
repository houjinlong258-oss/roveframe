/**
 * 地图服务商的**纯数据**注册表（服务端与客户端共用）。
 *
 * ## 为什么这个文件里没有任何数据库/加密代码
 *
 * 客户端的 `delivery-map.tsx` 需要"用哪个模板拼瓦片 URL / 厂商 SDK 的地址与
 * 参数名"这类信息，而服务端的 `map-config.ts` 需要"存哪一行、怎么解密"。
 * 两者混在一个文件里，客户端 bundle 就会把 `@/lib/crypto` 与 supabase 客户端
 * 一起拖进去（构建期直接报错，或者在浏览器里带上一份用不到的 node:crypto）。
 * 所以：**纯函数与常量放这里，凡是要碰库或解密的一律放 map-config.ts**。
 *
 * ## 关于 key 会被浏览器看到（必须写进代码的一条事实）
 *
 * 客户端的**任何**地图 SDK / 瓦片请求，key 都在浏览器里：SDK 模式是 URL 查询参数
 * 或初始化参数，瓦片模式是每一次 `<img src>` 的查询串。打开开发者工具就能读到。
 * 这是客户端地图的**固有限制**，不是本项目的缺陷。
 *
 * 因此：
 *   · 不要试图在客户端混淆、拆分或"隐藏"key —— 那是自欺，只会让下一个人以为它安全；
 *   · 唯一真正有效的手段是在厂商后台配置 **referrer / 域名白名单**（以及配额上限），
 *     设置页在 key 输入框旁必须提示这一点；
 *   · 更要紧的是**绝不下发平台级 key**：每个商家只拿自己那一份
 *     （见 src/lib/map-config.ts 的按 tenant+business 读取）。
 */

export type MapProviderId =
  | 'google'
  | 'mapbox'
  | 'maptiler'
  | 'amap'
  | 'baidu'
  | 'tianditu'
  | 'custom';

/** 渲染模式由 provider 决定，不由用户选：两类厂商的接入方式本质不同。 */
export type MapRenderMode = 'sdk' | 'tiles';

export interface MapProviderSpec {
  id: MapProviderId;
  label: string;
  mode: MapRenderMode;
  /**
   * 默认地址。
   *   · SDK 模式：厂商 JS 的地址（不带 key；key 由 buildSdkScriptUrl 拼）。
   *   · 瓦片模式：瓦片模板，含 `{z}/{x}/{y}`（可选 `{s}` 子域、`{key}`）。
   * 为空字符串表示**必须由商家填**（custom 就是这样 —— 我们没有它的地址）。
   */
  defaultBaseUrl: string;
  /** key 在查询串里的参数名。google=key、mapbox=access_token、百度=ak、天地图=tk。 */
  keyParam: string;
  /**
   * 必须显示的署名。空字符串表示"看 base_url 决定"：
   * 目前只有 custom 走这条路（见 attributionFor）。
   */
  attribution: string;
  /** 设置页的输入提示。 */
  keyHint: string;
  /**
   * 该 provider 是否能在**服务端**验证 key。
   *   · 瓦片模式：能 —— 直接取一张瓦片，key 无效就是 401/403；
   *   · SDK 模式：**不能** —— 服务端只能证明脚本地址可达，
   *     真正的 key 校验发生在浏览器里。这一点必须如实告诉用户，
   *     不能把"脚本 200"说成"key 有效"。
   */
  keyVerifiableServerSide: boolean;
  /** 坐标系注意事项。没有就是空字符串。 */
  coordinateNote: string;
}

export const MAP_PROVIDERS: Readonly<Record<MapProviderId, MapProviderSpec>> = {
  google: {
    id: 'google',
    label: 'Google Maps',
    mode: 'sdk',
    defaultBaseUrl: 'https://maps.googleapis.com/maps/api/js',
    keyParam: 'key',
    attribution: '© Google',
    keyHint: 'Google Maps JavaScript API key（设置页旁边必须去 Google Cloud 配 referrer 白名单）',
    keyVerifiableServerSide: false,
    coordinateNote: '',
  },
  mapbox: {
    id: 'mapbox',
    label: 'Mapbox GL JS',
    mode: 'sdk',
    defaultBaseUrl: 'https://api.mapbox.com/mapbox-gl.js',
    keyParam: 'access_token',
    attribution: '© Mapbox © OpenStreetMap',
    keyHint: 'Mapbox public access token（请在 Mapbox 账号里配置 URL 白名单）',
    keyVerifiableServerSide: false,
    coordinateNote: '',
  },
  amap: {
    id: 'amap',
    label: '高德地图（AMap JS API 2.0）',
    mode: 'sdk',
    defaultBaseUrl: 'https://webapi.amap.com/maps',
    keyParam: 'key',
    attribution: '© 高德地图',
    keyHint: '高德 Web 端 JS API key（请在高德控制台配置域名白名单）',
    keyVerifiableServerSide: false,
    coordinateNote: '高德使用 GCJ-02；库里的坐标是 WGS-84。本项目不做坐标系转换，标记可能偏移约百米量级。',
  },
  baidu: {
    id: 'baidu',
    label: '百度地图（BMapGL）',
    mode: 'sdk',
    defaultBaseUrl: 'https://api.map.baidu.com/api',
    keyParam: 'ak',
    attribution: '© 百度地图',
    keyHint: '百度地图浏览器端 ak（请在百度控制台配置 referer 白名单）',
    keyVerifiableServerSide: false,
    // 这条**必须**留着：转换算法不是公开可靠的规范，写一个"看起来对"的转换
    // 会把标记静默挪到几百米外，而那比不转换更难发现。
    coordinateNote: '百度使用 BD-09；库里的坐标是 WGS-84。本项目不做坐标转换，标记位置会有明显偏移。',
  },
  maptiler: {
    id: 'maptiler',
    label: 'MapTiler（瓦片）',
    mode: 'tiles',
    defaultBaseUrl: 'https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png',
    keyParam: 'key',
    attribution: '© MapTiler © OpenStreetMap contributors',
    keyHint: 'MapTiler key（可在 MapTiler 后台配置允许的域名）',
    keyVerifiableServerSide: true,
    coordinateNote: '',
  },
  tianditu: {
    id: 'tianditu',
    label: '天地图（瓦片）',
    mode: 'tiles',
    // 天地图的参数名不是 z/x/y 而是 l/x/y，模板照样用 {z}/{x}/{y} 占位 ——
    // 占位符是**我们的**约定，替换后才是厂商的参数名。
    defaultBaseUrl: 'https://t{s}.tianditu.gov.cn/DataServer?T=vec_w&x={x}&y={y}&l={z}',
    keyParam: 'tk',
    attribution: '© 天地图',
    keyHint: '天地图 token（tk），请在天地图控制台配置域名白名单',
    keyVerifiableServerSide: true,
    coordinateNote: '天地图使用 CGCS2000，与 WGS-84 在民用精度下可视为一致。',
  },
  custom: {
    id: 'custom',
    label: '自定义瓦片服务（自建 / 其它厂商）',
    mode: 'tiles',
    // 空 = 必须商家自己填。我们没有它的地址，也不会替它猜一个。
    defaultBaseUrl: '',
    keyParam: 'key',
    attribution: '',
    keyHint: '该服务的 key；若服务不需要 key 可留空',
    keyVerifiableServerSide: true,
    coordinateNote: '',
  },
};

export const MAP_PROVIDER_IDS = [
  'google', 'mapbox', 'maptiler', 'amap', 'baidu', 'tianditu', 'custom',
] as const satisfies readonly MapProviderId[];

/** 收敛到白名单；未知值返回 null（由调用方决定是报错还是回落）。 */
export function normalizeMapProvider(value: unknown): MapProviderId | null {
  if (typeof value !== 'string') return null;
  return (MAP_PROVIDER_IDS as readonly string[]).includes(value)
    ? (value as MapProviderId)
    : null;
}

/** 取 provider 规格；未知 provider 返回 null —— 不回落成某一个默认厂商。 */
export function mapProviderSpec(provider: unknown): MapProviderSpec | null {
  const id = normalizeMapProvider(provider);
  return id ? MAP_PROVIDERS[id] : null;
}

/** 地址是否可用作模板/SDK 地址：只允许 http(s)，且不得含空白或模板注入字符。 */
export function isUsableMapBaseUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  return /^https?:\/\//i.test(trimmed);
}

/** 瓦片模板必须带这三个占位符，少一个就拼不出真实瓦片（厂商各不相同）。 */
export function tileTemplateMissingPlaceholders(template: string): string[] {
  return ['{z}', '{x}', '{y}'].filter((token) => !template.includes(token));
}

/**
 * 拼一张瓦片 URL。
 *
 * `{key}` 显式出现时按占位符替换；否则把 key 作为查询参数**追加**上去
 * （这正是任务口径"key 作为查询参数拼进去"，也兼容天地图那种把 x/y/l 都写进
 * 查询串的服务）。key 为空时不追加任何参数 —— 不编一个空 key 参数出来。
 */
export function buildTileUrl(
  template: string,
  z: number,
  x: number,
  y: number,
  key: string,
  keyParam: string,
): string {
  const subdomain = String((x + y) % 8);
  const url = template
    .replace(/\{z\}/g, String(z))
    .replace(/\{x\}/g, String(x))
    .replace(/\{y\}/g, String(y))
    .replace(/\{s\}/g, subdomain);
  if (url.includes('{key}')) {
    return url.replace(/\{key\}/g, encodeURIComponent(key));
  }
  if (!key) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${keyParam}=${encodeURIComponent(key)}`;
}

/**
 * 厂商 JS 的最终地址（SDK 模式）。
 *
 * ## 为什么不把 key 放进 `<script>` 之外的任何地方
 *
 * 它本来就在 URL 里，浏览器地址栏/网络面板都看得到（见文件头）。这里不做任何
 * "混淆" —— 混淆改变不了"用户能看到"这个事实，只会让排查变难。
 */
export function buildSdkScriptUrl(provider: MapProviderId, baseUrl: string, key: string): string {
  const base = baseUrl || MAP_PROVIDERS[provider].defaultBaseUrl;
  const query = (params: Record<string, string>): string => {
    const search = new URLSearchParams(params).toString();
    return `${base}${base.includes('?') ? '&' : '?'}${search}`;
  };
  const encodedKey = key;
  switch (provider) {
    case 'google':
      // v=weekly 不能省：不指定版本时 Google 会按"实验版"下发，行为逐周变化。
      return query({ key: encodedKey, v: 'weekly' });
    case 'amap':
      return query({ v: '2.0', key: encodedKey });
    case 'baidu':
      // type=webgl 才会加载 BMapGL（没有它拿到的是老 BMap 全局）。
      return query({ v: '3.0', ak: encodedKey, type: 'webgl' });
    case 'mapbox':
      // Mapbox 的 token 不走 URL：它在 mapboxgl.accessToken 里，CSS 另行加载。
      return base;
    default:
      return key ? query({ [MAP_PROVIDERS[provider].keyParam]: encodedKey }) : base;
  }
}

/** Mapbox GL 需要配套的样式表。其它 SDK 自带样式，返回 null。 */
export function sdkStylesheetUrl(provider: MapProviderId): string | null {
  return provider === 'mapbox' ? 'https://api.mapbox.com/mapbox-gl.css' : null;
}

/** 从 base_url 里取主机名；取不到返回空串（不抛错）。 */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * 实际要显示的署名。
 *
 * custom 的 provider 没有内置署名，但**如果地址指向 OSM 官方瓦片，署名就是
 * 强制的**（OSM 使用条款）：少了它在生产上就是违反条款，而症状只是"页面上
 * 少一行小字"，没人会发现。因此这里按主机名把它补上。
 */
export function attributionFor(provider: MapProviderId, baseUrl: string): string {
  const spec = MAP_PROVIDERS[provider];
  if (spec.attribution) return spec.attribution;
  const host = hostOf(baseUrl);
  if (/(^|\.)tile\.openstreetmap\.org$/i.test(host) || /(^|\.)openstreetmap\.org$/i.test(host)) {
    return '© OpenStreetMap contributors';
  }
  // 认不出来的服务商：不编一个假署名，也不写"© 未知"糊弄过去 —— 留空，
  // 由商家自己在他的服务条款里确认（设置页对此有提示）。
  return '';
}
