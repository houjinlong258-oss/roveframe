/**
 * 顾客**设备**定位 —— 收货坐标唯一诚实的来源。
 *
 * ## 为什么不给地址做地理编码
 *
 * 把一行文字地址猜成坐标，猜错了 ETA 与地图会一起错，而顾客无从分辨
 * （他看到的只是一个数字）。所以坐标只从设备取；取不到就是没有。
 *
 * ## 三条边界（都往"没有坐标"这一侧倒，不编坐标）
 *
 *   1. **必须顾客显式授权**：浏览器会在首次调用时弹窗询问；
 *      拒绝就是拒绝，我们不做任何劝说，也不记默认值。
 *   2. **必须有超时**：`getCurrentPosition` 在室内/无 GPS 时可以**永不回调**
 *      （它不会 reject，只是不说话）。没有超时的话下单按钮会一直转圈。
 *   3. **安全上下文**：`navigator.geolocation` 在 http 下不可用（除 localhost），
 *      此时直接返回 null，而不是抛错打断下单。
 *
 * 返回 `null` 是**正常结果**，不是失败：调用方据此不传坐标字段。
 */

export interface DeviceCoordinates {
  lat: number;
  lng: number;
  /** 定位精度（米），仅用于日志与将来判断可信度；不上屏。 */
  accuracyM: number | null;
}

/**
 * 取一次当前位置。
 *
 * @param timeoutMs 超时上限。默认 6000 ms —— 比常见"定位中"提示短一点，
 *   因为下单流程里顾客在等；宁可这一次没有坐标，也不要卡住结算。
 *   `enableHighAccuracy: false` 是刻意的：省电与更快出结果，
 *   而配送 ETA 只需要米级以下的精度。
 */
export function getDeviceCoordinates(timeoutMs = 6_000): Promise<DeviceCoordinates | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    // 服务端渲染 / http 上下文 / 老浏览器：没有这项能力，如实返回 null。
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: DeviceCoordinates | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    try {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const { latitude, longitude, accuracy } = position.coords;
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            // 设备返回了非有限值：当作没有，不把它写进订单。
            finish(null);
            return;
          }
          finish({
            lat: latitude,
            lng: longitude,
            accuracyM: Number.isFinite(accuracy) ? accuracy : null,
          });
        },
        () => {
          // 拒绝授权 / 定位不可用 / 超时（浏览器自己的超时）。
          // 不区分原因：对下单流程来说三者都是"这次没有坐标"。
          finish(null);
        },
        { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 60_000 },
      );
    } catch {
      // 某些环境下访问 geolocation 会抛（权限策略 / 奇怪的内嵌 WebView）。
      finish(null);
    }
  });
}
