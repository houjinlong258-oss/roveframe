'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildSdkScriptUrl,
  buildTileUrl,
  normalizeMapProvider,
  sdkStylesheetUrl,
  type MapProviderId,
  type MapRenderMode,
} from '@/lib/map-providers';

/**
 * 配送地图（顾客端）。
 *
 * ===========================================================================
 * 一、这个组件为什么存在，以及它**不**做什么
 * ===========================================================================
 *
 * 原型的"地图"是一个每 2 秒把标记往前挪 1.2% 的假进度条，坐标全是写死的。
 * 本组件只画**真实存在**的三类东西：
 *   · 骑手位置（`delivery_positions` 的最新一行，由骑手设备显式上报）；
 *   · 目的地坐标（`delivery_orders.dest_lat/dest_lng`，顾客设备下单时提供）；
 *   · 两点之间的直线（**球面直线，不是路网路线** —— 本项目没有路网数据，
 *     画成"路线"就是在暗示一条我们并不知道的路径）。
 *
 * 它**不**模拟位移、**不**编 ETA、**不**硬编码任何坐标、**不**用任何定时器 API
 * （本文件里连那个词的字面量都不出现 —— 否则源码级守卫会命中注释本身，
 * 而一条总在报错的守卫等于没有守卫）。位置会变只是因为它收到新的 props
 * （追踪接口重新取了一次），不是因为它自己在走。
 *
 * ===========================================================================
 * 二、两种渲染模式（由商家配置的 provider 决定，不由本组件猜）
 * ===========================================================================
 *
 *   · `sdk`   —— 运行时加载厂商 JS（Google / Mapbox / 高德 / 百度），带 key 初始化。
 *               这是**运行期外部脚本**，不是 npm 依赖：零新增依赖的规矩仍然成立。
 *   · `tiles` —— `<img src="模板">`，模板里 `{z}/{x}/{y}`，key 作为查询参数拼进去
 *               （MapTiler / 天地图 / 自建瓦片）。
 *
 * 两种模式都满足同一条事实：**浏览器端地图 key 一定会被访问者看到**。
 *
 * ===========================================================================
 * 三、没有配置 / 没有坐标时各做什么
 * ===========================================================================
 *
 *   · 没有配置（provider 缺失 / 商家关掉 / 服务端密钥解不开）→ 明确显示
 *     「地图未配置」。**不渲染空白框**：空白框会被当成"地图加载失败"，
 *     而真相是"这家店没配地图"，两者的处置完全不同（前者刷新技术，后者找老板）。
 *     也**不回落**成任何编造的地图（不偷偷换一家免费瓦片）。
 *   · 有配置但缺骑手位置或目的地坐标 → 本组件返回 null，由调用方（追踪面板）
 *     保留原来的状态时间轴，并明确写出"位置尚不可用"。目的地坐标来自顾客设备，
 *     经常是空的（顾客没授权定位），这不是异常，是常态。
 */

export interface MapPoint {
  lat: number;
  lng: number;
}

export interface DeliveryMapClientConfig {
  provider: string;
  mode: MapRenderMode;
  api_key: string;
  base_url: string;
  style: string;
  attribution: string;
  key_param: string;
}

interface DeliveryMapProps {
  /** 服务端下发的**本门店**配置；null = 未配置/未启用。 */
  config: DeliveryMapClientConfig | null;
  /** 骑手最新位置。null = 还没有任何上报（不回落成"上次已知位置"）。 */
  rider: MapPoint | null;
  /** 目的地坐标。null = 顾客设备没提供（不地理编码猜一个）。 */
  destination: MapPoint | null;
  /**
   * 店铺坐标。**当前仓库里没有任何数据源**（businesses 只有 location 文本，
   * 没有经纬度列），所以调用方通常不传 —— 那就**不画**店铺标记，
   * 而不是把它画在某个"大概的位置"。将来真有了坐标源，直接传进来即可。
   */
  store?: MapPoint | null;
  /** 地图高度（px）。 */
  height?: number;
}

const TILE_SIZE = 256;
const MIN_ZOOM = 2;
/** 上限刻意不用 18：两个点几乎重合时会放大到看不出任何参照物。 */
const MAX_ZOOM = 16;
/** 单点（两点重合）时使用的缩放级别。 */
const SINGLE_POINT_ZOOM = 15;
/** 标记与容器边缘留出的空白（px），避免标记贴着边被裁掉。 */
const EDGE_PADDING = 28;
const STORE_COLOR = '#0f766e';
const RIDER_COLOR = '#0284c7';
const DESTINATION_COLOR = '#b45309';

interface WorldPoint {
  x: number;
  y: number;
}

/** 经度 → 世界像素 X（Web Mercator，slippy map 口径）。 */
function lngToWorldX(lng: number, zoom: number): number {
  return ((lng + 180) / 360) * TILE_SIZE * 2 ** zoom;
}

/** 纬度 → 世界像素 Y。纬度裁到 ±85.0511（墨卡托在极点发散）。 */
function latToWorldY(lat: number, zoom: number): number {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const rad = (clamped * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(Math.PI / 4 + rad / 2)) / Math.PI) / 2) * TILE_SIZE * 2 ** zoom;
}

function worldPoint(point: MapPoint, zoom: number): WorldPoint {
  return { x: lngToWorldX(point.lng, zoom), y: latToWorldY(point.lat, zoom) };
}

/** 所有点都落在 (width-pad, height-pad) 之内时的最大缩放级别。 */
function fitZoom(points: MapPoint[], width: number, height: number): number {
  const availableWidth = Math.max(32, width - EDGE_PADDING * 2);
  const availableHeight = Math.max(32, height - EDGE_PADDING * 2);
  for (let zoom = MAX_ZOOM; zoom >= MIN_ZOOM; zoom -= 1) {
    const projected = points.map((point) => worldPoint(point, zoom));
    const spanX = Math.max(...projected.map((p) => p.x)) - Math.min(...projected.map((p) => p.x));
    const spanY = Math.max(...projected.map((p) => p.y)) - Math.min(...projected.map((p) => p.y));
    if (spanX <= availableWidth && spanY <= availableHeight) return zoom;
  }
  return MIN_ZOOM;
}

// ---------------------------------------------------------------------------
// 厂商脚本加载：只在浏览器里跑，且同一个地址只加载一次
// ---------------------------------------------------------------------------

/**
 * 已加载/正在加载的脚本地址。
 *
 * 为什么要缓存：切换配送单（组件卸载再挂载）时重复插入同一个 `<script>` 会让
 * 厂商 SDK 重新初始化全局对象，症状是标记偶尔丢失、偶尔报 "already loaded"。
 * 这不是节流，也不是定时器 —— 只是"同一份脚本不重复拉"。
 */
const scriptPromises = new Map<string, Promise<void>>();

function loadScriptOnce(url: string): Promise<void> {
  const existing = scriptPromises.get(url);
  if (existing) return existing;

  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`failed to load map script: ${url.split('?')[0]}`));
    document.head.appendChild(script);
  });
  scriptPromises.set(url, promise);
  return promise;
}

/** 厂商样式表（只有 Mapbox GL 需要）。同样是"只加一次"。 */
function ensureStylesheet(url: string): void {
  if (document.querySelector(`link[data-rf-map-style="${url}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = url;
  link.dataset.rfMapStyle = url;
  document.head.appendChild(link);
}

// ---------------------------------------------------------------------------
// 厂商 SDK 的最小结构化类型
//
// 刻意**不**引入 @types/google.maps / mapbox-gl 这类包（零新增依赖），
// 也刻意不用 `any`：这里只声明我们真正调用的那三四个成员。
// ---------------------------------------------------------------------------

interface VendorMap {
  remove?: () => void;
  destroy?: () => void;
}

interface VendorSdk {
  /** 依次调用，返回一个清理函数（只处理我们加过的东西）。 */
  mount: (element: HTMLDivElement) => VendorMap | null;
}

function readGlobal(name: string): unknown {
  return (globalThis as unknown as Record<string, unknown>)[name];
}

function googleSdk(config: DeliveryMapClientConfig, points: MapPoint[]): VendorSdk | null {
  const google = readGlobal('google') as
    | { maps?: { Map?: unknown; Marker?: unknown; Polyline?: unknown } }
    | undefined;
  const maps = google?.maps;
  if (!maps?.Map || !maps.Marker || !maps.Polyline) return null;
  const MapCtor = maps.Map as new (el: HTMLElement, opts: Record<string, unknown>) => VendorMap;
  const MarkerCtor = maps.Marker as new (opts: Record<string, unknown>) => unknown;
  const PolylineCtor = maps.Polyline as new (opts: Record<string, unknown>) => unknown;
  return {
    mount: (element) => {
      const center = { lat: points[0].lat, lng: points[0].lng };
      const map = new MapCtor(element, { center, zoom: 13, mapTypeControl: false });
      const markers = points.map((point, index) => new MarkerCtor({
        position: { lat: point.lat, lng: point.lng },
        map,
        title: `point-${index}`,
      }));
      const line = new PolylineCtor({
        path: points.map((point) => ({ lat: point.lat, lng: point.lng })),
        map,
        strokeColor: RIDER_COLOR,
        strokeWeight: 3,
        // 直线（geodesic: false）：这不是路网路线，见文件头。
        geodesic: false,
      });
      void markers;
      void line;
      return map;
    },
  };
}

function mapboxSdk(config: DeliveryMapClientConfig, points: MapPoint[]): VendorSdk | null {
  const mapboxgl = readGlobal('mapboxgl') as
    | { Map?: unknown; Marker?: unknown }
    | undefined;
  if (!mapboxgl?.Map || !mapboxgl.Marker) return null;
  const MapCtor = mapboxgl.Map as new (opts: Record<string, unknown>) => VendorMap & {
    on?: (event: string, handler: () => void) => void;
    addSource?: (id: string, source: Record<string, unknown>) => void;
    addLayer?: (layer: Record<string, unknown>) => void;
  };
  const MarkerCtor = mapboxgl.Marker as new () => {
    setLngLat: (lngLat: [number, number]) => { addTo: (map: unknown) => unknown };
  };
  return {
    mount: (element) => {
      (mapboxgl as unknown as Record<string, unknown>).accessToken = config.api_key;
      const map = new MapCtor({
        container: element,
        style: config.style,
        center: [points[0].lng, points[0].lat],
        zoom: 13,
      });
      for (const point of points) {
        new MarkerCtor().setLngLat([point.lng, point.lat]).addTo(map);
      }
      map.on?.('load', () => {
        map.addSource?.('rf-delivery-path', {
          type: 'geojson',
          data: {
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: points.map((p) => [p.lng, p.lat]) },
          },
        });
        map.addLayer?.({
          id: 'rf-delivery-path-line',
          type: 'line',
          source: 'rf-delivery-path',
          paint: { 'line-color': RIDER_COLOR, 'line-width': 3 },
        });
      });
      return map;
    },
  };
}

function amapSdk(config: DeliveryMapClientConfig, points: MapPoint[]): VendorSdk | null {
  const AMap = readGlobal('AMap') as
    | { Map?: unknown; Marker?: unknown; Polyline?: unknown }
    | undefined;
  if (!AMap?.Map || !AMap.Marker || !AMap.Polyline) return null;
  const MapCtor = AMap.Map as new (el: HTMLElement, opts: Record<string, unknown>) => VendorMap & {
    add?: (overlays: unknown[]) => void;
  };
  const MarkerCtor = AMap.Marker as new (opts: Record<string, unknown>) => unknown;
  const PolylineCtor = AMap.Polyline as new (opts: Record<string, unknown>) => unknown;
  return {
    mount: (element) => {
      const map = new MapCtor(element, {
        zoom: 13,
        center: [points[0].lng, points[0].lat],
      });
      const markers = points.map((point) => new MarkerCtor({
        position: [point.lng, point.lat],
        map,
      }));
      const line = new PolylineCtor({
        path: points.map((point) => [point.lng, point.lat]),
        strokeColor: RIDER_COLOR,
        strokeWeight: 4,
        map,
      });
      void markers;
      void line;
      return map;
    },
  };
}

function baiduSdk(config: DeliveryMapClientConfig, points: MapPoint[]): VendorSdk | null {
  const BMapGL = readGlobal('BMapGL') as
    | { Map?: unknown; Point?: unknown; Marker?: unknown; Polyline?: unknown }
    | undefined;
  if (!BMapGL?.Map || !BMapGL.Point || !BMapGL.Marker || !BMapGL.Polyline) return null;
  const MapCtor = BMapGL.Map as new (el: HTMLElement) => VendorMap & {
    centerAndZoom?: (point: unknown, zoom: number) => void;
    addOverlay?: (overlay: unknown) => void;
  };
  const PointCtor = BMapGL.Point as new (lng: number, lat: number) => unknown;
  const MarkerCtor = BMapGL.Marker as new (point: unknown) => unknown;
  const PolylineCtor = BMapGL.Polyline as new (points: unknown[], opts: Record<string, unknown>) => unknown;
  return {
    mount: (element) => {
      const map = new MapCtor(element);
      // 注意：百度用 BD-09，而库里是 WGS-84，本项目不做坐标转换（该算法非公开，
      // 写一个"看起来对"的转换会把标记静默挪到几百米外）。偏移是已知且写在设置页上的。
      const first = new PointCtor(points[0].lng, points[0].lat);
      map.centerAndZoom?.(first, 13);
      for (const point of points) {
        map.addOverlay?.(new MarkerCtor(new PointCtor(point.lng, point.lat)));
      }
      if (points.length > 1) {
        map.addOverlay?.(new PolylineCtor(
          points.map((point) => new PointCtor(point.lng, point.lat)),
          { strokeColor: RIDER_COLOR, strokeWeight: 3 },
        ));
      }
      return map;
    },
  };
}

function sdkFor(provider: MapProviderId, config: DeliveryMapClientConfig, points: MapPoint[]): VendorSdk | null {
  switch (provider) {
    case 'google': return googleSdk(config, points);
    case 'mapbox': return mapboxSdk(config, points);
    case 'amap': return amapSdk(config, points);
    case 'baidu': return baiduSdk(config, points);
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

const MARKER_META: Record<'store' | 'rider' | 'destination', { color: string; label: string }> = {
  store: { color: STORE_COLOR, label: '门店' },
  rider: { color: RIDER_COLOR, label: '骑手' },
  destination: { color: DESTINATION_COLOR, label: '送达地' },
};

export const DeliveryMap: React.FC<DeliveryMapProps> = ({
  config,
  rider,
  destination,
  store,
  height = 240,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [sdkError, setSdkError] = useState<string | null>(null);

  // 容器宽度要实测：瓦片网格与标记位置都按像素算，猜一个宽度会让标记错位。
  // 这里只监听 resize（浏览器事件），**不是**定时器：位置变化来自 props 与服务端，
  // 不来自任何"自己走"的循环。
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return undefined;
    const update = () => setWidth(element.clientWidth);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  /**
   * 参与绘制的点。顺序即折线顺序：门店 → 骑手 → 送达地。
   * 缺谁就少谁 —— 不补一个"估计位置"。
   */
  const points = useMemo(() => {
    const list: { key: 'store' | 'rider' | 'destination'; point: MapPoint }[] = [];
    if (store) list.push({ key: 'store', point: store });
    if (rider) list.push({ key: 'rider', point: rider });
    if (destination) list.push({ key: 'destination', point: destination });
    return list;
  }, [store, rider, destination]);

  const mode = config?.mode ?? 'tiles';

  /**
   * provider 再过一次白名单（服务端已经收敛过一次，这里是前端这一侧的自保）：
   * 未知 provider 不猜成任何一家厂商，直接按"未配置"渲染 —— 猜一家会去加载
   * 一个我们并不知道的脚本地址，那是把不可信字符串塞进 `<script src>`。
   */
  const providerId = config ? normalizeMapProvider(config.provider) : null;

  /**
   * 瓦片网格与标记位置。zoom 由"所有点能装进容器"反推，因此这一块纯计算、
   * 无副作用、无随机、无时间 —— 同样的坐标永远画出同样的图。
   */
  const layout = useMemo(() => {
    if (points.length === 0 || width <= 0) return null;
    const coords = points.map((entry) => entry.point);
    const zoom = coords.length === 1 ? SINGLE_POINT_ZOOM : fitZoom(coords, width, height);
    const projected = coords.map((point) => worldPoint(point, zoom));
    const minX = Math.min(...projected.map((p) => p.x));
    const maxX = Math.max(...projected.map((p) => p.x));
    const minY = Math.min(...projected.map((p) => p.y));
    const maxY = Math.max(...projected.map((p) => p.y));
    // 居中用包围盒中点（不是经纬度平均）：跨纬度时后者会把画面拉偏。
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const toScreen = (point: MapPoint): { left: number; top: number } => {
      const world = worldPoint(point, zoom);
      return {
        left: width / 2 + (world.x - centerX),
        top: height / 2 + (world.y - centerY),
      };
    };
    return {
      zoom,
      markers: points.map((entry) => ({ ...entry, ...toScreen(entry.point) })),
      line: coords.map((point) => toScreen(point)),
      centerX,
      centerY,
    };
  }, [points, width, height]);

  const tiles = useMemo(() => {
    if (mode !== 'tiles' || !config || !layout) return [];
    const tileCount = 2 ** layout.zoom;
    const firstX = Math.floor((layout.centerX - width / 2) / TILE_SIZE);
    const lastX = Math.floor((layout.centerX + width / 2) / TILE_SIZE);
    const firstY = Math.floor((layout.centerY - height / 2) / TILE_SIZE);
    const lastY = Math.floor((layout.centerY + height / 2) / TILE_SIZE);
    const list: { key: string; url: string; left: number; top: number }[] = [];
    for (let x = firstX; x <= lastX; x += 1) {
      // 越界的瓦片直接跳过：向厂商请求不存在的瓦片只会拿到 404 图块，
      // 而它比空白更难看（会渲染成明显的"裂图"）。
      if (x < 0 || x >= tileCount) continue;
      for (let y = firstY; y <= lastY; y += 1) {
        if (y < 0 || y >= tileCount) continue;
        list.push({
          key: `${layout.zoom}/${x}/${y}`,
          url: buildTileUrl(config.base_url, layout.zoom, x, y, config.api_key, config.key_param),
          left: width / 2 + x * TILE_SIZE - layout.centerX,
          top: height / 2 + y * TILE_SIZE - layout.centerY,
        });
      }
    }
    return list;
  }, [mode, config, layout, width, height]);

  /**
   * SDK 模式：加载厂商脚本并初始化。
   *
   * 依赖只有 [provider, 地址, key, 点集] —— 点集来自 props，所以"位置更新"
   * 会重新初始化一次地图。这**不是**动画：没有新位置就什么都不会动。
   * 卸载时清理：mapbox/高德有 remove/destroy，Google 没有销毁方法，
   * 清空容器即可（我们创建的元素随组件一起被移除）。
   */
  useEffect(() => {
    if (mode !== 'sdk' || !config || !providerId || points.length === 0) return undefined;
    const element = containerRef.current;
    if (!element) return undefined;
    let cancelled = false;
    let mounted: VendorMap | null = null;
    setSdkError(null);

    const stylesheet = sdkStylesheetUrl(providerId);
    if (stylesheet) ensureStylesheet(stylesheet);

    const url = buildSdkScriptUrl(providerId, config.base_url, config.api_key);
    void loadScriptOnce(url)
      .then(() => {
        if (cancelled) return;
        const sdk = sdkFor(providerId, config, points.map((entry) => entry.point));
        if (!sdk) {
          setSdkError(`地图 SDK 未就绪（${config.provider}）`);
          return;
        }
        mounted = sdk.mount(element);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // 加载失败必须说出来：否则顾客看到的是一个空白框，与"没配置"无法区分。
        setSdkError(error instanceof Error ? error.message : '地图脚本加载失败');
      });

    return () => {
      cancelled = true;
      mounted?.remove?.();
      mounted?.destroy?.();
      element.innerHTML = '';
    };
  }, [mode, config, providerId, points]);

  /**
   * 未配置：明确说出来，不画空白框。
   * 这段在**没有坐标**之前就返回，因此"没配地图"这件事不会因为缺坐标而被吞掉。
   */
  if (!config || !providerId) {
    return (
      <div
        id="delivery-map-unconfigured"
        className="rounded-2xl border border-stone-700/70 bg-stone-800/60 px-3.5 py-3 text-[11px] text-stone-300"
      >
        <div className="font-semibold text-stone-200">地图未配置</div>
        <p className="mt-1 text-stone-400">
          本店还没有配置地图服务商（或已关闭）。商家可在「设置 → 系统集成 → 地图」里配置
          地图服务商与密钥；未配置时不会显示地图，也不会用别的地图代替。
        </p>
      </div>
    );
  }

  // 缺骑手位置或缺目的地坐标：**不画**地图（由调用方回落到状态时间轴）。
  // 目的地坐标来自顾客自己的设备，经常是空的 —— 那是常态，不是错误。
  if (!rider || !destination) return null;

  return (
    <div
      id="delivery-map"
      className="rounded-2xl overflow-hidden border border-stone-700/70 bg-stone-900"
    >
      <div
        ref={containerRef}
        className="relative w-full overflow-hidden"
        style={{ height }}
        data-map-provider={config.provider}
        data-map-mode={mode}
      >
        {mode === 'tiles' && tiles.map((tile) => (
          <img
            key={tile.key}
            src={tile.url}
            alt=""
            width={TILE_SIZE}
            height={TILE_SIZE}
            // 瓦片是装饰性背景：alt 留空 + 不可选中，避免读屏器把 12 张图念一遍。
            aria-hidden="true"
            draggable={false}
            className="absolute select-none"
            style={{ left: tile.left, top: tile.top }}
          />
        ))}

        {layout && (
          <>
            {/* 折线：两点之间是**球面直线**，不是路网路线 —— 我们没有路网数据。 */}
            <svg
              className="absolute inset-0 pointer-events-none"
              width={width}
              height={height}
              viewBox={`0 0 ${width} ${height}`}
              aria-hidden="true"
            >
              {layout.line.length > 1 && (
                <polyline
                  points={layout.line.map((point) => `${point.left},${point.top}`).join(' ')}
                  fill="none"
                  stroke={RIDER_COLOR}
                  strokeWidth={3}
                  strokeDasharray="6 5"
                  strokeLinecap="round"
                />
              )}
            </svg>

            {layout.markers.map((marker) => {
              const meta = MARKER_META[marker.key];
              return (
                <div
                  key={marker.key}
                  className="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center"
                  style={{ left: marker.left, top: marker.top }}
                >
                  <span
                    className="w-3.5 h-3.5 rounded-full border-2 border-white shadow"
                    style={{ backgroundColor: meta.color }}
                  />
                  <span className="mt-1 px-1.5 py-0.5 rounded bg-stone-900/85 text-[10px] text-stone-100 whitespace-nowrap">
                    {meta.label}
                  </span>
                </div>
              );
            })}
          </>
        )}

        {sdkError && (
          <div className="absolute inset-0 flex items-center justify-center bg-stone-900/80 px-4 text-center text-[11px] text-rose-300">
            {sdkError}
          </div>
        )}

        {/*
          署名。瓦片模式下这是厂商使用条款的**强制**要求（例如 OSM 明确要求
          "© OpenStreetMap contributors"）；SDK 模式下厂商一般自带署名控件，
          这里再显示一次是我们自己配置的那一份，不会造成误导。
          没有配置署名时不显示这一块（不写"© 未知"之类的占位）。
        */}
        {config.attribution && (
          <div className="absolute bottom-0 right-0 px-1.5 py-0.5 bg-white/80 text-[10px] text-stone-700">
            {config.attribution}
          </div>
        )}

        {width > 0 && tiles.length === 0 && mode === 'tiles' && (
          <div className="absolute inset-0 flex items-center justify-center text-[11px] text-stone-400">
            瓦片地址没有覆盖到当前视野
          </div>
        )}
      </div>
    </div>
  );
};
