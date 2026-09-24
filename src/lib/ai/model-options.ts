/**
 * 「模型分流」可选项的计算 —— 纯函数，**不 import 任何东西**，
 * 因此既能在客户端组件里用，也能被单元测试直接导入。
 *
 * ## 为什么需要它（一起真实故障）
 *
 * `model-registry.ts` 的头注释记着：用户的服务商 `/models` 里同时有
 * `agnes-image-2.0-flash`、`agnes-video-2.5-flash`。Composer 把图像模型和聊天模型
 * 混在一起列出，用户把图像模型选来当聊天模型，**每次请求必然 400**，
 * 白白触发一次故障切换（真实账本里连续 4 条 provider_error）。
 *
 * 「模型分流」（每个能力用哪个模型）是同一类风险面：把图像/视频模型配成 agent
 * 的聊天模型，会造成同样的持续 400。所以这里只放行 `capability === 'chat'`。
 *
 * ## 为什么分类结果由服务端给
 *
 * 分类函数在 `model-registry.ts`，而那个模块引入了 `getSupabaseClient`（服务端专用）。
 * 客户端组件直接 import 它会把数据库客户端拖进浏览器包（构建会失败）。
 * 所以 `GET /api/settings/models` 返回已经带 `capability`/`strength` 的 `modelsCatalog`，
 * 这里只做筛选与兜底。
 */

export interface ModelsCatalogEntry {
  id: string;
  /** 'chat' | 'image' | 'video' | 'audio' | 'embedding' | 'other' */
  capability: string;
  /** 仅用于 UI 分组的命名模式启发式标签 */
  strength: string;
}

export interface ProviderLike {
  id: string;
  displayName: string;
  catalogModels: { id: string }[];
  modelsCatalog?: ModelsCatalogEntry[];
  connection: { defaultModel: string | null } | null;
}

/**
 * 某个供应商在「模型分流」里可选的聊天模型。
 *
 * 只列 `capability === 'chat'`。服务端未给分类时（旧响应 / 未配置）退回
 * 「当前默认模型 + 目录里的静态提示」，**不把 modelsCache 全量倒进来** ——
 * 那里面正可能含图像/视频模型，而这正是本模块要防的事。
 */
export function chatModelOptions(provider: ProviderLike): { id: string; strength: string }[] {
  const chat = (provider.modelsCatalog ?? []).filter((m) => m.capability === 'chat');
  if (chat.length > 0) return chat.map((m) => ({ id: m.id, strength: m.strength }));
  const ids = new Set<string>();
  if (provider.connection?.defaultModel) ids.add(provider.connection.defaultModel);
  for (const m of provider.catalogModels) ids.add(m.id);
  return [...ids].map((id) => ({ id, strength: '' }));
}
