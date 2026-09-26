'use client';

import { useTranslations } from 'next-intl';
import {
  ArrowRight, BarChart3, Bot, Check, ClipboardCheck, Inbox, LineChart,
  MessageSquareWarning, ShieldCheck, Users, Utensils, Zap,
} from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { RoveFrameLogo } from '@/components/layout/brand-logo';

/**
 * 落地面（Phase 15）。
 *
 * ## 为什么需要
 *
 * 此前 `/` 是仪表盘：未登录访客会先渲染工作台，再被 AppShell 的会话守卫
 * `401 → 跳登录页`。也就是说**产品对外没有一句话介绍** ——
 * 访客（或潜在客户）打开域名直接被要求登录，不知道这是什么、给谁用、值多少钱。
 * 对一个"要卖出去的 SaaS"来说这是明确的缺口。
 *
 * ## 设计约束
 *
 * - 用 `@theme` 里已有的语义色（`bg-surface` / `text-on-surface-variant` 等），
 *   与后台视觉同源，不引入新的样式体系；
 * - 三语（en/zh/es）由 `messages/*.json` 的 `landing` 命名空间提供；
 * - 不写死价格数字以外的动态内容（不搞 `Date.now()`、随机数），避免 hydration 不一致；
 * - 不承诺产品还没有的能力：这里的每一条都对应真实代码，
 *   唯一的例外是价格 —— 它是占位区间，上线前必须由业务方确认（见文末注释）。
 */
export function LandingPage() {
  const t = useTranslations('landing');

  const features = [
    { icon: Bot, key: 'agent' },
    { icon: BarChart3, key: 'insight' },
    { icon: ClipboardCheck, key: 'approval' },
    { icon: Inbox, key: 'mail' },
    { icon: Users, key: 'customers' },
    { icon: MessageSquareWarning, key: 'reviews' },
    { icon: Utensils, key: 'store' },
    { icon: ShieldCheck, key: 'audit' },
  ] as const;

  const loop = ['data', 'insight', 'recommend', 'approve', 'execute', 'audit'] as const;

  return (
    <div className="min-h-screen bg-background">
      {/* 顶栏：仅品牌 + 登录/注册。访客看到的第一个界面不应是工作台导航。 */}
      <header className="sticky top-0 z-40 border-b border-outline-variant/40 bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-2">
            {/* 与工作台顶栏共用同一字标组件：品牌只有一处定义，不会再出现
                「落地页是纯文本、顶栏是字体拼字」这种两套不一致。 */}
            <RoveFrameLogo variant="primary" size="md" />
          </div>
          <div className="flex items-center gap-2">
            <Link href="/auth/login">
              <Button variant="ghost" size="sm">{t('signIn')}</Button>
            </Link>
            <Link href="/auth/signup">
              <Button size="sm">{t('startFree')}</Button>
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-6xl px-4 pb-16 pt-20 text-center">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-outline-variant/60 px-3 py-1 text-xs text-on-surface-variant">
          <Zap className="h-3 w-3" />
          {t('badge')}
        </span>
        <h1 className="mx-auto mt-6 max-w-3xl text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
          {t('heroTitle')}
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-on-surface-variant">
          {t('heroSubtitle')}
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link href="/auth/signup">
            <Button size="lg">
              {t('startFree')}
              <ArrowRight className="ml-1.5 h-4 w-4" />
            </Button>
          </Link>
          <Link href="/auth/login">
            <Button size="lg" variant="outline">{t('signIn')}</Button>
          </Link>
        </div>
        <p className="mt-4 text-xs text-on-surface-variant">{t('noCard')}</p>
      </section>

      {/* 闭环：这是产品真正的骨架，不是营销修辞 */}
      <section className="border-y border-outline-variant/40 bg-surface-container/40 py-14">
        <div className="mx-auto max-w-6xl px-4">
          <h2 className="text-center text-xl font-semibold">{t('loopTitle')}</h2>
          <p className="mx-auto mt-2 max-w-2xl text-center text-sm text-on-surface-variant">
            {t('loopSubtitle')}
          </p>
          <ol className="mt-8 flex flex-wrap items-center justify-center gap-2 text-sm">
            {loop.map((step, i) => (
              <li key={step} className="flex items-center gap-2">
                <span className="rounded-md border border-outline-variant/60 bg-surface px-3 py-1.5 font-medium">
                  {t(`loop.${step}`)}
                </span>
                {i < loop.length - 1 && <ArrowRight className="h-3.5 w-3.5 text-on-surface-variant" />}
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* 能力 */}
      <section className="mx-auto max-w-6xl px-4 py-16">
        <h2 className="text-center text-xl font-semibold">{t('featuresTitle')}</h2>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {features.map(({ icon: Icon, key }) => (
            <div key={key} className="rounded-lg border border-outline-variant/50 bg-surface p-5">
              <span className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Icon className="h-4.5 w-4.5" />
              </span>
              <h3 className="mt-3 text-sm font-semibold">{t(`features.${key}.title`)}</h3>
              <p className="mt-1.5 text-xs leading-relaxed text-on-surface-variant">
                {t(`features.${key}.body`)}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* 价格 */}
      <section className="border-t border-outline-variant/40 bg-surface-container/40 py-16">
        <div className="mx-auto max-w-6xl px-4">
          <h2 className="text-center text-xl font-semibold">{t('pricingTitle')}</h2>
          <p className="mx-auto mt-2 max-w-2xl text-center text-sm text-on-surface-variant">
            {t('pricingSubtitle')}
          </p>
          <div className="mt-10 grid gap-4 lg:grid-cols-3">
            {(['starter', 'growth', 'scale'] as const).map((tier) => (
              <div
                key={tier}
                className={`rounded-lg border bg-surface p-6 ${
                  tier === 'growth' ? 'border-primary/60 shadow-sm' : 'border-outline-variant/50'
                }`}
              >
                {tier === 'growth' && (
                  <span className="mb-3 inline-block rounded-sm bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                    {t('popular')}
                  </span>
                )}
                <h3 className="text-sm font-semibold">{t(`pricing.${tier}.name`)}</h3>
                <p className="mt-3 text-2xl font-semibold">
                  {t(`pricing.${tier}.price`)}
                  <span className="text-sm font-normal text-on-surface-variant">{t('perMonth')}</span>
                </p>
                <p className="mt-2 text-xs text-on-surface-variant">{t(`pricing.${tier}.blurb`)}</p>
                <ul className="mt-5 space-y-2">
                  {(['a', 'b', 'c'] as const).map((line) => (
                    <li key={line} className="flex items-start gap-2 text-xs">
                      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                      <span className="text-on-surface-variant">{t(`pricing.${tier}.${line}`)}</span>
                    </li>
                  ))}
                </ul>
                <Link href="/auth/signup" className="mt-6 block">
                  <Button className="w-full" variant={tier === 'growth' ? 'default' : 'outline'} size="sm">
                    {t('startFree')}
                  </Button>
                </Link>
              </div>
            ))}
          </div>
          {/* 价格是占位区间：上线前必须由业务方确认，否则等于对外承诺一个未定价产品 */}
          <p className="mt-6 text-center text-xs text-on-surface-variant">{t('pricingNote')}</p>
        </div>
      </section>

      {/* 收尾 CTA */}
      <section className="mx-auto max-w-6xl px-4 py-16 text-center">
        <LineChart className="mx-auto h-8 w-8 text-primary" />
        <h2 className="mt-4 text-xl font-semibold">{t('ctaTitle')}</h2>
        <p className="mx-auto mt-2 max-w-xl text-sm text-on-surface-variant">{t('ctaSubtitle')}</p>
        <Link href="/auth/signup" className="mt-6 inline-block">
          <Button size="lg">
            {t('startFree')}
            <ArrowRight className="ml-1.5 h-4 w-4" />
          </Button>
        </Link>
      </section>

      <footer className="border-t border-outline-variant/40 py-8">
        <div className="mx-auto max-w-6xl px-4 text-center text-xs text-on-surface-variant">
          {t('footer')}
        </div>
      </footer>
    </div>
  );
}
