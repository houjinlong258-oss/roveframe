import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fmtCurrency } from '../src/lib/format';
import {
  businessDayRange,
  DEFAULT_BUSINESS_TIME_ZONE,
  localDateInTimeZone,
  resolveBusinessTimeZone,
} from '../src/lib/time';

const read = (path: string): string => readFileSync(path, 'utf8');

describe('P0-8 货币格式化（locale/currency 显式）', () => {
  test('USD/en 经典美元格式', () => {
    assert.equal(fmtCurrency(1234.5, 'USD', 'en'), '$1,234.50');
  });
  test('zh/es 的 USD 符号断言（不再恒显 $）', () => {
    assert.ok(fmtCurrency(1234.5, 'USD', 'zh').includes('US$'));
    assert.ok(fmtCurrency(1234.5, 'USD', 'es').includes('US$'));
  });
  test('EUR 显示欧元符号而非美元', () => {
    const esEur = fmtCurrency(1234.5, 'EUR', 'es');
    assert.ok(esEur.includes('€'));
    assert.ok(!esEur.includes('$'));
    const zhEur = fmtCurrency(1234.5, 'EUR', 'zh');
    assert.ok(zhEur.includes('€'));
  });
  test('整数金额无小数位', () => {
    assert.equal(fmtCurrency(9, 'USD', 'en'), '$9');
  });
});

describe('P0-8 业务时区日切（ISO-UTC 存储 + 业务时区零点）', () => {
  test('美东夏令时（EDT, UTC-4）零点切日', () => {
    const { start, end } = businessDayRange('2026-09-08', 'America/New_York');
    assert.equal(start.toISOString(), '2026-09-08T04:00:00.000Z');
    assert.equal(end.toISOString(), '2026-09-09T04:00:00.000Z');
  });

  test('美东冬令时（EST, UTC-5）零点切日', () => {
    const { start } = businessDayRange('2026-01-15', 'America/New_York');
    assert.equal(start.toISOString(), '2026-01-15T05:00:00.000Z');
  });

  test('上海（UTC+8）零点切日', () => {
    const { start } = businessDayRange('2026-09-08', 'Asia/Shanghai');
    assert.equal(start.toISOString(), '2026-09-07T16:00:00.000Z');
  });

  test('本地日期跟随业务时区而非进程时区', () => {
    // UTC 2026-09-08 03:00 = 美东 2026-09-07 23:00
    assert.equal(
      localDateInTimeZone(new Date('2026-09-08T03:00:00.000Z'), 'America/New_York'),
      '2026-09-07',
    );
    assert.equal(
      localDateInTimeZone(new Date('2026-09-08T03:00:00.000Z'), 'Asia/Shanghai'),
      '2026-09-08',
    );
  });

  test('非法时区回落默认，合法时区保留', () => {
    assert.equal(resolveBusinessTimeZone('Bad/Zone'), DEFAULT_BUSINESS_TIME_ZONE);
    assert.equal(resolveBusinessTimeZone(undefined), DEFAULT_BUSINESS_TIME_ZONE);
    assert.equal(resolveBusinessTimeZone(''), DEFAULT_BUSINESS_TIME_ZONE);
    assert.equal(resolveBusinessTimeZone('Asia/Tokyo'), 'Asia/Tokyo');
  });

  test('非法日期串抛错', () => {
    assert.throws(() => businessDayRange('2026-13-01', 'Asia/Shanghai'), /invalid date string/);
  });
});

describe('P0-8 时区/聚合接线契约', () => {
  test('business-context 按业务时区切日 + count/avg 聚合（无静默截断）', () => {
    const src = read('src/lib/business-context.ts');
    assert.match(src, /resolveBusinessTimeZone\(settings\.locale\?\.timezone\)/);
    assert.match(src, /businessDayRange\(todayStr, timeZone\)/);
    assert.match(src, /count: 'exact', head: true/);
    assert.ok(!src.includes('.limit(500)'), 'customerCount 不得再截断 500');
    assert.ok(!src.includes('.limit(200)'), '支付统计不得再截断 200');
    assert.match(src, /scopedQuery\('reviews', 'rating, status'\)/, '评分按全量评论聚合');
  });

  test('channels 简报快照按业务时区切日', () => {
    const src = read('src/lib/channels.ts');
    assert.match(src, /resolveBusinessTimeZone\(settings\.locale\?\.timezone\)/);
    assert.match(src, /businessDayRange\(todayStr, timeZone\)/);
  });

  test('reservations GET 按业务时区切日（不再用服务器本地时区解析）', () => {
    const src = read('src/app/api/reservations/route.ts');
    assert.match(src, /resolveBusinessTimeZone\(settings\.locale\?\.timezone\)/);
    assert.match(src, /businessDayRange\(date, timeZone\)/);
    assert.ok(!src.includes('T00:00:00'), '禁止服务器本地时区解析自然日');
  });

  test('store 页币种随菜单数据传入 fmtCurrency', () => {
    const src = read('src/app/[locale]/store/page.tsx');
    assert.match(src, /fmtCurrency\(amount, menu\?\.store\.currency \?\? 'USD', locale\)/);
  });
});
