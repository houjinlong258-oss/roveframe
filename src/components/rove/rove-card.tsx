'use client';

import { cn } from '@/lib/utils';

/**
 * RoveFrame OS 基础空间容器：16–24px 圆角、柔和阴影、极小边框。
 * variant=float 用于悬浮面板（玻璃态 + 浮起阴影）。
 */
export function RoveCard({
  children,
  className,
  variant = 'default',
  rise,
}: {
  children: React.ReactNode;
  className?: string;
  variant?: 'default' | 'float' | 'glass';
  rise?: 0 | 1 | 2 | 3 | 4;
}) {
  return (
    <div
      className={cn(
        'rove-card',
        variant === 'float' && 'rove-card-float',
        variant === 'glass' && 'glass-panel rove-card-float',
        rise !== undefined && rise > 0 && `rove-rise rove-rise-${rise}`,
        rise === 0 && 'rove-rise',
        className
      )}
    >
      {children}
    </div>
  );
}

export function RoveCardHeader({
  title,
  subtitle,
  action,
  className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center justify-between mb-4', className)}>
      <div>
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
