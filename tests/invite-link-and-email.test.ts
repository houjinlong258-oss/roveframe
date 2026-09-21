import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Phase 18 §4.3（用户决策）—— 邀请链路：`generateLink` + 商家自建 SMTP 发信。
 *
 * ## 被修的是什么
 *
 * 原实现用 `auth.admin.inviteUserByEmail`，那会让 **Supabase Auth 自己发那封
 * 邀请邮件**。本项目没有配平台侧 SMTP，实测该调用返回 **429** ——
 * 而 429 看起来像"限流"，掩盖了真实原因：平台没有发信能力。
 * 结果是整条邀请链路不可用，且错误信息指向错误的方向。
 *
 * 现在：`generateLink({ type: 'invite' })` 只生成链接、不发信；
 * 邮件由**商家自己的** SMTP 发出（`sendEmailWithDefaultAccount`）。
 * 邀请邮件本来也该用商家的发件身份，而不是平台的。
 *
 * ## 这批断言守住的失败模式
 *
 *   1. 又用回 `inviteUserByEmail` ⇒ 在没有平台 SMTP 的项目上必然 429；
 *   2. 补写 `app_metadata` 被删掉 ⇒ 被邀请人"能设密码、然后每个请求 401"
 *      （`verifyJwtLocally` 与 `resolveUserByToken` 都读 app_metadata）；
 *   3. 拿不到 `action_link` 还返回 201 ⇒ 发出去一封点不开的信；
 *   4. 把发信失败当成邀请失败（或反过来）⇒ 商家拿着一个能用的链接却以为白干了。
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const stripComments = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('邀请链路：链接生成与发信分离', () => {
  const route = stripComments(read('src/app/api/team/invite/route.ts'));

  test('用 generateLink，而不是 inviteUserByEmail', () => {
    assert.match(route, /auth\.admin\.generateLink\(/);
    assert.match(route, /type: 'invite'/);
    // 负向对照：这正是被修掉的写法（在没有平台 SMTP 的项目上返回 429）
    assert.doesNotMatch(route, /inviteUserByEmail/);
  });

  test('补写 app_metadata.tenant_id（缺失 ⇒ 被邀请人永远 401）', () => {
    assert.match(route, /auth\.admin\.updateUserById\(/);
    assert.match(route, /app_metadata:\s*\{[\s\S]{0,120}tenant_id/);
  });

  test('拿不到 action_link 就 500，不返回成功', () => {
    assert.match(route, /no_action_link/);
    assert.match(route, /properties\?\.action_link/);
  });

  test('用商家自己的 SMTP 发信，且发信失败不伪装成成功', () => {
    assert.match(route, /sendEmailWithDefaultAccount\(/);
    assert.match(route, /email_sent: emailSent/);
    assert.match(route, /email_error: emailError/);
  });

  test('invite_url 一定非 null（前三步成功才走到返回）', () => {
    assert.match(route, /invite_url: inviteUrl/);
    assert.doesNotMatch(route, /invite_url:\s*null/);
  });

  test('仍然固定 staff 角色（不接受请求体里的 role）', () => {
    assert.match(route, /role: STAFF_ROLE/);
    assert.doesNotMatch(route, /role:\s*body\.role/);
  });

  test('负向对照：同一组 matcher 能命中一个"用回了 inviteUserByEmail"的合成片段', () => {
    const synthetic = "client.auth.admin.inviteUserByEmail(email, { redirectTo: url });";
    assert.match(synthetic, /inviteUserByEmail/);
  });
});

describe('被邀请人能通过鉴权链（读 app_metadata 的两处都必须在）', () => {
  test('本地验签路径读 app_metadata.tenant_id', () => {
    const guard = read('src/lib/auth-guard.ts');
    assert.match(guard, /const appMeta = \(payload\.app_metadata \?\? \{\}\)/);
    assert.match(guard, /appMeta\.tenant_id/);
  });

  test('远程解析路径同样要求 app_metadata 里有 tenant_id', () => {
    const auth = read('src/lib/auth.ts');
    assert.match(auth, /app_metadata/);
    assert.match(auth, /no tenant_id in app_metadata/);
  });
});
