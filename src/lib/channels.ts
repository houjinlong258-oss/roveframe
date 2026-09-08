import { getSupabaseClient } from '@/storage/database/supabase-client';
import { decrypt } from '@/lib/crypto';
import { invokeChat } from '@/lib/ai/router';
import { fetchWithOutboundGuard } from '@/lib/security/outbound-url';
import { CHANNEL_KEYS, type ChannelKey } from '@/lib/channels-presets';

type ChannelConfig = Record<string, string>;

/** 读取某渠道已保存并解密的配置（仅已启用） */
export async function getChannelConfig(tenantId: string, businessId: string, provider: ChannelKey): Promise<ChannelConfig | null> {
  const client = getSupabaseClient();
  const { data } = await client
    .from('integration_configs')
    .select('config_encrypted, is_enabled')
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .eq('provider', provider)
    .eq('is_enabled', true)
    .maybeSingle();
  if (!data?.config_encrypted) return null;
  try {
    return JSON.parse(decrypt(data.config_encrypted)) as ChannelConfig;
  } catch {
    return null;
  }
}

/** 列出所有已启用的社交通讯渠道 */
export async function listConnectedChannels(tenantId: string, businessId: string): Promise<ChannelKey[]> {
  const client = getSupabaseClient();
  const { data } = await client
    .from('integration_configs')
    .select('provider')
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .eq('is_enabled', true)
    .in('provider', CHANNEL_KEYS);
  return ((data ?? []) as { provider: ChannelKey }[]).map((r) => r.provider);
}

/** 向指定渠道发送一段文本 */
export async function sendChannelMessage(
  provider: ChannelKey,
  config: ChannelConfig,
  text: string,
): Promise<void> {
  switch (provider) {
    case 'telegram': {
      const token = config.botToken?.trim();
      const chatId = config.chatId?.trim();
      if (!token || !chatId) throw new Error('botToken and chatId required');
      const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) throw new Error(`Telegram ${resp.status}: ${await resp.text()}`);
      return;
    }
    case 'whatsapp': {
      const token = config.accessToken?.trim();
      const phoneId = config.phoneNumberId?.trim();
      const to = config.to?.trim();
      if (!token || !phoneId || !to) throw new Error('accessToken, phoneNumberId and to required');
      const resp = await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) throw new Error(`WhatsApp ${resp.status}: ${await resp.text()}`);
      return;
    }
    case 'slack':
      await postWebhook(config, { text });
      return;
    case 'discord':
      await postWebhook(config, { content: text });
      return;
    case 'mattermost':
      await postWebhook(config, { text });
      return;
    case 'matrix': {
      const hs = config.homeserver?.trim().replace(/\/$/, '');
      const token = config.accessToken?.trim();
      const roomId = config.roomId?.trim();
      if (!hs || !token || !roomId) throw new Error('homeserver, accessToken and roomId required');
      // SSRF：homeserver 为商户配置输入，出站统一校验（公网 https + DNS 复检 + 重定向复检）
      const resp = await fetchWithOutboundGuard(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${Date.now()}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ msgtype: 'm.text', body: text }),
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!resp.ok) throw new Error(`Matrix ${resp.status}`);
      return;
    }
    case 'feishu':
      await postWebhook(config, { msg_type: 'text', content: { text } });
      return;
    case 'wecom':
      await postWebhook(config, { msgtype: 'text', text: { content: text } });
      return;
    case 'dingtalk':
      await postWebhook(config, { msgtype: 'text', text: { content: text } });
      return;
    default:
      throw new Error(`Channel '${provider}' is not available yet`);
  }
}

/** webhook 类渠道统一发送（Slack/Discord/飞书/企业微信/钉钉） */
async function postWebhook(config: ChannelConfig, payload: unknown): Promise<void> {
  const url = config.webhookUrl?.trim();
  if (!url) throw new Error('webhookUrl required');
  // SSRF：webhook URL 为客户端可控输入，出站统一校验（公网 https + DNS 复检 + 重定向复检）；
  // 失败不回显上游响应体（防内网响应泄露）
  const resp = await fetchWithOutboundGuard(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`Webhook ${resp.status}`);
}

/** 连通性测试：机器人渠道只验证凭据，webhook 渠道发送一条测试消息 */
export async function testChannelConnection(
  provider: ChannelKey,
  config: ChannelConfig,
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (provider === 'telegram') {
      const token = config.botToken?.trim();
      if (!token) return { ok: false, error: 'botToken required' };
      const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
      return { ok: true };
    }
    if (provider === 'whatsapp') {
      const token = config.accessToken?.trim();
      const phoneId = config.phoneNumberId?.trim();
      if (!token || !phoneId) return { ok: false, error: 'accessToken and phoneNumberId required' };
      const resp = await fetch(`https://graph.facebook.com/v20.0/${phoneId}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
      return { ok: true };
    }
    if (provider === 'matrix') {
      const hs = config.homeserver?.trim().replace(/\/$/, '');
      const token = config.accessToken?.trim();
      if (!hs || !token) return { ok: false, error: 'homeserver and accessToken required' };
      const resp = await fetch(`${hs}/_matrix/client/v3/account/whoami`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
      return { ok: true };
    }
    const preset = webhookPayload(provider);
    if (!preset) return { ok: false, error: `Channel '${provider}' is not available yet` };
    await postWebhook(config, preset.test);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'connection failed' };
  }
}

function webhookPayload(provider: ChannelKey): { test: unknown } | null {
  const TEST = '✅ [RoveFrame] Connection test successful';
  switch (provider) {
    case 'slack':
      return { test: { text: TEST } };
    case 'discord':
      return { test: { content: TEST } };
    case 'mattermost':
      return { test: { text: TEST } };
    case 'feishu':
      return { test: { msg_type: 'text', content: { text: TEST } } };
    case 'wecom':
      return { test: { msgtype: 'text', text: { content: TEST } } };
    case 'dingtalk':
      return { test: { msgtype: 'text', text: { content: TEST } } };
    default:
      return null;
  }
}

/** 聚合经营事实快照（营收/订单、库存告警、待回复差评、今日预约），供 AI 生成简报 */
export async function buildStoreSnapshot(tenantId: string, businessId: string, locale = 'en'): Promise<string> {
  const client = getSupabaseClient();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayIso = todayStart.toISOString();
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - 6);

  const [todayOrders, weekOrders, inventory, pendingReviews, todayResv] = await Promise.all([
    client.from('orders').select('total').eq('tenant_id', tenantId).eq('business_id', businessId).gte('created_at', todayIso).neq('status', 'cancelled'),
    client.from('orders').select('total').eq('tenant_id', tenantId).eq('business_id', businessId).gte('created_at', weekStart.toISOString()).neq('status', 'cancelled'),
    client.from('inventory_items').select('name, current_stock, safety_stock').eq('tenant_id', tenantId).eq('business_id', businessId),
    client.from('reviews').select('id').eq('tenant_id', tenantId).eq('business_id', businessId).eq('status', 'pending'),
    client.from('reservations').select('customer_name, party_size, table_no, reserved_at').eq('tenant_id', tenantId).eq('business_id', businessId).gte('reserved_at', todayIso).order('reserved_at').limit(5),
  ]);

  const sum = (rows: { total?: string | number | null }[] | null) =>
    (rows ?? []).reduce((s, r) => s + Number(r.total ?? 0), 0);

  const todayRevenue = Math.round(sum(todayOrders.data) * 100) / 100;
  const todayCount = todayOrders.data?.length ?? 0;
  const weekRevenue = Math.round(sum(weekOrders.data) * 100) / 100;
  const weekCount = weekOrders.data?.length ?? 0;

  const lowStock = ((inventory.data ?? []) as { name: string; current_stock: string | number; safety_stock: string | number }[])
    .filter((i) => Number(i.current_stock) < Number(i.safety_stock))
    .slice(0, 5);
  const pendingCount = pendingReviews.data?.length ?? 0;
  const reservations = (todayResv.data ?? []) as {
    customer_name: string; party_size: number; table_no: string | null; reserved_at: string;
  }[];

  if (locale === 'zh') {
    const lowStockStr = lowStock.length
      ? lowStock.map((i) => `${i.name}(${i.current_stock}/${i.safety_stock})`).join('、')
      : '无';
    const resvStr = reservations.length
      ? reservations.map((r) => `${r.customer_name} ${r.party_size}人 ${r.table_no ?? '-'} ${new Date(r.reserved_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`).join('；')
      : '无';
    return `今日营收 $${todayRevenue} · 今日订单 ${todayCount} 单\n近7天营收 $${weekRevenue} · 近7天订单 ${weekCount} 单\n⚠️ 库存告警: ${lowStockStr}\n🟡 待回复差评: ${pendingCount} 条\n📅 今日预约: ${reservations.length} 桌${reservations.length ? `（${resvStr}）` : ''}`;
  }

  const lowStockStr = lowStock.length
    ? lowStock.map((i) => `${i.name}(${i.current_stock}/${i.safety_stock})`).join(', ')
    : 'none';
  const resvStr = reservations.length
    ? reservations.map((r) => `${r.customer_name} (${r.party_size}p) ${r.table_no ?? '-'} ${new Date(r.reserved_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`).join('; ')
    : 'none';
  return `Today revenue: $${todayRevenue} · orders: ${todayCount}\n7-day revenue: $${weekRevenue} · orders: ${weekCount}\n⚠️ Low stock: ${lowStockStr}\n🟡 Pending reviews: ${pendingCount}\n📅 Reservations today: ${reservations.length}${reservations.length ? ` (${resvStr})` : ''}`;
}

/** 生成 AI 经营的实时简报（AI 失败时回落到结构化快照） */
export async function buildBriefing(
  tenantId: string,
  businessId: string,
  locale = 'en',
  forwardHeaders?: Record<string, string>,
): Promise<string> {
  const snapshot = await buildStoreSnapshot(tenantId, businessId, locale);
  const lang = locale === 'zh' ? '中文' : locale === 'es' ? '西班牙语' : '英文';
  try {
    const ai = await invokeChat(
      'light',
      [
        {
          role: 'system',
          content:
            `你是店铺的 AI 经营助手。用${lang}把下面的经营快照整理成一条适合手机阅读的实时简报：` +
            '分点、简洁、带少量 emoji，但绝不编造数据，也不要加寒暄。',
        },
        { role: 'user', content: snapshot },
      ],
      forwardHeaders,
      { tenantId, businessId },
      { agent: 'channels:brief' },
    );
    if (ai && ai.trim()) return ai.trim();
  } catch (error) {
    console.warn('[briefing] AI generation unavailable; using scoped snapshot:', error instanceof Error ? error.name : 'unknown_error');
  }
  return snapshot;
}
