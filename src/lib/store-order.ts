import { z } from 'zod';

/**
 * P0-6：公开下单载荷完整 schema —— items ≤50、单项 qty 1..99、
 * tip/总额上限、note ≤500。金额上限由路由在服务端计价后二次校验。
 */
export const MAX_ORDER_ITEMS = 50;
export const MAX_ITEM_QTY = 99;
export const MAX_TIP_AMOUNT = 10_000;
export const MAX_ORDER_TOTAL = 100_000;

export const storeOrderItemSchema = z.object({
  product_id: z.string().trim().min(1).max(64),
  qty: z.number().int().min(1).max(MAX_ITEM_QTY),
});

export const storeOrderSchema = z.object({
  token: z.string().optional(),
  note: z.string().max(500).optional().nullable(),
  items: z.array(storeOrderItemSchema).min(1).max(MAX_ORDER_ITEMS),
  tip_amount: z.number().finite().min(0).max(MAX_TIP_AMOUNT).optional().default(0),
  tip_percent: z.number().finite().min(0).max(100).optional().nullable(),
});
