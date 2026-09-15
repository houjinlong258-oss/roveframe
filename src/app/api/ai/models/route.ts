import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';
import { buildModelRegistry, REASONING_LEVELS } from '@/lib/ai/model-registry';
import { errorResponse } from '@/lib/api-helpers';

/**
 * Model Composer 的数据源：`GET /api/ai/models`
 *
 * 只读、无副作用、不需要任何 Key。返回：
 * - 每个已接入服务商的真实健康度（来自连接测试 + 最近 200 次真实调用账本）
 * - 可选模型清单（provider 探测结果优先，缺失时回落内置目录）
 * - 平台内置兜底模型（永远可用）
 *
 * 注意：绝不解密或返回任何凭据；未接入的服务商 health='offline'，不可选。
 */
export async function GET(request: NextRequest) {
  try {
    const context = requireBusinessContext(await getTenantContext(request));
    requirePermission(context, 'agent:use');
    const registry = await buildModelRegistry({
      tenantId: context.tenantId,
      businessId: context.businessId,
    });
    return NextResponse.json({
      ...registry,
      reasoningLevels: Object.values(REASONING_LEVELS).map((profile) => ({
        level: profile.level,
        label: profile.label,
        description: profile.description,
      })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
