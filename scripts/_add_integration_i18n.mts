/**
 * 为 messages/*.json 的 settings 命名空间补两个键（三语同步）。
 *
 * 为什么用脚本而不是手改：本仓库有"三语必须同步"的硬约束，
 * 漏一个语言会在运行时抛 MISSING_MESSAGE。脚本保证三个文件一起改，
 * 并在写入前断言"原文里确实没有该键"，避免静默覆盖。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ADDITIONS: Record<string, Record<string, string>> = {
  en: {
    connectivityOnly: 'Connectivity only',
    erpConnectivityOnlyNotice:
      'A connection test succeeded, but data sync from ERPNext is not implemented. '
      + 'Inventory shown for this business comes from local data, not from ERPNext.',
  },
  zh: {
    connectivityOnly: '仅连通性',
    erpConnectivityOnlyNotice:
      '连接测试已通过，但 ERPNext 的**数据同步尚未实现**。'
      + '本商家显示的库存来自本地数据，不是 ERPNext。',
  },
  es: {
    connectivityOnly: 'Solo conectividad',
    erpConnectivityOnlyNotice:
      'La prueba de conexión fue correcta, pero la sincronización de datos desde ERPNext '
      + 'no está implementada. El inventario mostrado proviene de datos locales, no de ERPNext.',
  },
};

function main(): number {
  for (const [loc, add] of Object.entries(ADDITIONS)) {
    const path = join(process.cwd(), 'messages', `${loc}.json`);
    const raw = readFileSync(path, 'utf8');
    const json = JSON.parse(raw) as { settings: Record<string, unknown> };

    for (const [key, value] of Object.entries(add)) {
      if (key in json.settings) {
        console.log(`  [${loc}] ${key} 已存在，跳过`);
        continue;
      }
      json.settings[key] = value;
      console.log(`  [${loc}] + ${key}`);
    }
    // 保持 2 空格缩进与其它 messages 文件一致
    writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
  }
  console.log('完成：三语 settings 命名空间已同步。');
  return 0;
}

process.exitCode = main();
