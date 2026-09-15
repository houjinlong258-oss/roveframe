import { getTableName, getTableColumns } from 'drizzle-orm';
import * as S from '../src/storage/database/shared/schema.ts';
const out = {};
for (const t of Object.values(S)) {
  try {
    const tn = getTableName(t);
    if (!tn) continue;
    const cols = getTableColumns(t);
    if (!cols || !Object.keys(cols).length) continue;
    out[tn] = Object.values(cols).map(c => ({ name: c.name, notNull: !!c.notNull }));
  } catch { /* not a table */ }
}
console.log(JSON.stringify(out, null, 1));
