import { canonicalizeEmail, findUnsubscribeByToken, recordUnsubscribe } from '@/lib/email/unsubscribe';

/**
 * 邮件页脚里给人点的退订页（`/{locale}/unsubscribe?token=…`）。
 *
 * ## 为什么既有这个页面又有 `/api/email/unsubscribe`
 *
 *   - **页面**给人点：老板在邮件里看到的落点应当是可读的一页；
 *   - **API** 给机器点：邮件客户端的一键退订（RFC 8058）会直接 POST 到
 *     `List-Unsubscribe` 头里的 URL，那必须是 API。
 * 两者共用同一段写入逻辑（`recordUnsubscribe`），因此任一路径退订都立即生效。
 *
 * ## 两个刻意的选择
 *
 * 1. **GET 时就完成退订，不做二次确认**。"退订必须被遵守"的意思就是点一次即生效；
 *    再加一步"确认退订"是常见的合规反模式（人会以为已经退了）。
 * 2. **返回 JSX 而不是 Response**。这是个页面，不是路由处理器：
 *    初版写成 `return new NextResponse(html)`，`tsc` 通过而 `next build` 失败
 *    （`AppPageConfig` 要求组件返回 ReactNode）。这里用普通组件形态。
 */

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main style={{ maxWidth: 520, margin: '0 auto', padding: '48px 20px' }}>
      <div
        style={{
          background: '#161a1f',
          border: '1px solid #262c34',
          borderRadius: 14,
          padding: 32,
          color: '#e8eaed',
        }}
      >
        <h1 style={{ fontSize: 20, margin: '0 0 12px' }}>{title}</h1>
        <p style={{ margin: 0, color: '#b6bdc7', lineHeight: 1.6 }}>{children}</p>
      </div>
    </main>
  );
}

export const dynamic = 'force-dynamic';

export default async function UnsubscribePage({ searchParams }: PageProps) {
  const params = await searchParams;
  const raw = params.token;
  const token = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';

  if (!token) {
    return <Card title="Invalid link">This unsubscribe link is missing its token.</Card>;
  }

  let record;
  try {
    record = await findUnsubscribeByToken(token);
  } catch (error) {
    console.error('[unsubscribe] token lookup failed:', error instanceof Error ? error.message : String(error));
    return (
      <Card title="Temporarily unavailable">
        We could not process this link right now. Please try again later.
      </Card>
    );
  }
  if (!record) {
    return (
      <Card title="Invalid link">
        This unsubscribe link is not valid or has already been used.
      </Card>
    );
  }

  try {
    await recordUnsubscribe({
      tenantId: record.tenant_id,
      businessId: record.business_id,
      address: record.email,
      token,
      reason: 'link',
      source: 'unsubscribe_page',
    });
  } catch (error) {
    console.error('[unsubscribe] record failed:', error instanceof Error ? error.message : String(error));
    return (
      <Card title="Temporarily unavailable">
        We could not process this link right now. Please try again later.
      </Card>
    );
  }

  return (
    <Card title="You are unsubscribed">
      Marketing emails will no longer be sent to{' '}
      <strong style={{ color: '#e8eaed' }}>{canonicalizeEmail(record.email)}</strong>.
    </Card>
  );
}
