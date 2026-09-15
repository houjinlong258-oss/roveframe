/**
 * 只读诊断：为什么 Mission Panel 是空的。
 * 逐步执行 missions 路由里的每一步，定位是哪一个查询失败。
 */
import { getSupabaseClient } from '../src/storage/database/supabase-client';
import { getBusinessContext } from '../src/lib/business-context';
import { deriveMissions } from '../src/lib/agent/missions';

const TENANT = '00000000-0000-0000-0000-000000000000';
const BUSINESS = '00000000-0000-0000-0000-000000000001';

async function main() {
  const client = getSupabaseClient();

  console.log('=== 1. getBusinessContext ===');
  try {
    const ctx = await getBusinessContext(TENANT, BUSINESS);
    console.log('  OK');
    console.log('   todayRevenue =', ctx.todayRevenue, ' weekRevenue =', ctx.weekRevenue);
    console.log('   todayOrders  =', ctx.todayOrders, ' pendingReviews =', ctx.pendingReviews);
    console.log('   lowStock     =', ctx.lowStockItems.length, ' churnRisk =', ctx.churnRiskCustomers.length);
    console.log('   negReviews   =', ctx.recentNegativeReviews.length, ' reservations =', ctx.todayReservations);
    console.log('   payments     =', JSON.stringify(ctx.paymentSummary));
  } catch (error) {
    console.log('  FAILED:', error instanceof Error ? error.message : String(error));
  }

  console.log('\n=== 2. agent_approvals count ===');
  const approvals = await client
    .from('agent_approvals')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', TENANT)
    .eq('business_id', BUSINESS)
    .eq('status', 'pending');
  console.log('  error:', approvals.error?.message ?? 'none', ' count:', approvals.count);

  console.log('\n=== 3. alerts（level=error & is_read=false）===');
  const alerts = await client
    .from('alerts')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', TENANT)
    .eq('business_id', BUSINESS)
    .eq('level', 'error')
    .eq('is_read', false);
  console.log('  error:', alerts.error?.message ?? 'none', ' count:', alerts.count);

  console.log('\n=== 4. agent_tasks ===');
  const tasks = await client
    .from('agent_tasks')
    .select('id, name, status, next_run_at')
    .eq('tenant_id', TENANT)
    .eq('business_id', BUSINESS)
    .in('status', ['active', 'running', 'paused'])
    .order('next_run_at', { ascending: true })
    .limit(5);
  console.log('  error:', tasks.error?.message ?? 'none', ' rows:', tasks.data?.length ?? 0);

  console.log('\n=== 5. deriveMissions 端到端 ===');
  try {
    const ctx = await getBusinessContext(TENANT, BUSINESS);
    const board = deriveMissions({
      persona: 'ceo-insight',
      context: ctx,
      pendingApprovals: approvals.count ?? 0,
      unreadErrorAlerts: alerts.count ?? 0,
      activeTasks: [],
    });
    console.log('  items:', board.items.length);
    for (const item of board.items) {
      console.log(`   [${item.status}/${item.severity}] ${item.code} metric=${item.metric}`);
    }
    console.log('  signals:', JSON.stringify(board.signals));
  } catch (error) {
    console.log('  FAILED:', error instanceof Error ? error.message : String(error));
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error('diagnostic failed:', error);
    process.exit(1);
  },
);
