/**
 * 把 `scripts/migrate.sql` 里**非幂等**的 DDL 语句修成幂等。
 *
 * ## 为什么必须修
 *
 * `autoMigrate()` 在**每次进程启动**都跑整条迁移链。因此链上任何一句在第二次执行时
 * 失败，都等于"这个库每次重启都会报迁移失败" —— 而失败只出现在启动日志里，
 * 服务照常起来，所以没人会发现。
 *
 * 实测到的两个实例（对真实库）：
 *   1. `products_adapter_external_idx`：种子数据用空串而非 NULL 表示"无外部来源"，
 *      塌成同一个键 → 唯一索引建不出来（已单独修）。
 *   2. `integration_configs_tenant_business_provider_key`：这几句的写法是
 *      「drop 掉**旧名字** → create **新名字**」。第一次跑没问题，
 *      第二次跑时新名字已存在 → `relation already exists`。
 *
 * ## 修法
 *
 * 不改语义，只补一句"先删自己"：
 *   · `create unique index <name> on public.<table> (...)` 前补
 *     `drop index if exists public.<name>;`
 *   · `alter table <t> add constraint <name> ...` 前补
 *     `alter table <t> drop constraint if exists <name>;`
 *
 * 为什么不用 `create ... if not exists`：那会在名字已存在时**静默跳过**，
 * 于是"改了定义也不生效"。先删再建让文件里的定义始终是权威的。
 *
 * 用法：node scripts/_fix_migrate_idempotency.mjs [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'scripts/migrate.sql';
const checkOnly = process.argv.includes('--check');
const original = readFileSync(FILE, 'utf8');
const lines = original.split('\n');

/** 往前看 8 行内是否已经有针对同名对象的 drop —— 有就不重复补 */
function hasPrecedingDrop(index, pattern) {
  for (let i = Math.max(0, index - 8); i < index; i += 1) {
    if (pattern.test(lines[i])) return true;
  }
  return false;
}

const inserted = [];
const output = [];

for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  const indent = line.match(/^\s*/)?.[0] ?? '';

  const indexMatch = line.match(/^\s*create unique index (\w+) on\s+(public\.\w+)/);
  if (indexMatch) {
    const [, name] = indexMatch;
    const ownDrop = new RegExp(`drop index if exists\\s+(public\\.)?${name}\\b`);
    if (!hasPrecedingDrop(i, ownDrop)) {
      output.push(`${indent}-- 补：先删自己，否则第二次执行会报 relation already exists（autoMigrate 每次启动都跑）`);
      output.push(`${indent}drop index if exists public.${name};`);
      inserted.push(`drop index  ${name}`);
    }
  }

  const constraintMatch = line.match(/^\s*alter table\s+(public\.\w+)\s+add constraint\s+(\w+)/);
  if (constraintMatch) {
    const [, table, name] = constraintMatch;
    const ownDrop = new RegExp(`drop constraint if exists\\s+${name}\\b`);
    if (!hasPrecedingDrop(i, ownDrop)) {
      output.push(`${indent}-- 补：先删自己，否则第二次执行会报 constraint already exists`);
      output.push(`${indent}alter table ${table} drop constraint if exists ${name};`);
      inserted.push(`drop constraint  ${name}`);
    }
  }

  output.push(line);
}

console.log(`需要补 ${inserted.length} 处：`);
for (const item of inserted) console.log('  + ' + item);

if (checkOnly) {
  console.log(inserted.length === 0 ? '已全部幂等' : '仍有非幂等语句');
  process.exit(inserted.length === 0 ? 0 : 1);
}

if (inserted.length === 0) {
  console.log('无需修改');
  process.exit(0);
}

writeFileSync(FILE, output.join('\n'), 'utf8');
console.log(`\n已写入 ${FILE}`);
