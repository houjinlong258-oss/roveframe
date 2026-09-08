import assert from 'node:assert/strict';
import test from 'node:test';
import { contextToPrompt, type BusinessContext } from '@/lib/business-context';

const context: BusinessContext = {
  businessName: 'Scope A Bistro',
  industry: 'restaurant',
  location: 'New York',
  language: 'en',
  currency: 'USD',
  todayRevenue: 120,
  todayOrders: 5,
  yesterdayRevenue: 160,
  yesterdayOrders: 7,
  weekRevenue: 880,
  weekOrders: 42,
  customerCount: 91,
  avgRating: 3.8,
  pendingReviews: 2,
  lowStockItems: ['Chili oil'],
  churnRiskCustomers: ['Customer A'],
  todayReservations: 4,
  channelRevenue: [{ channel: 'dine_in', revenue: 120, orders: 5 }],
  recentNegativeReviews: ['Slow service'],
  topProducts: [{ name: 'Noodles', price: 14, salesCount: 32 }],
  paymentSummary: { succeeded: 8, pending: 1, failed: 2, volume: 740 },
};

test('canonical business prompt contains all required operating fact domains', () => {
  const prompt = contextToPrompt(context, 'en');
  assert.match(prompt, /Scope A Bistro/); // profile
  assert.match(prompt, /revenue: \$880/); // sales
  assert.match(prompt, /orders: 42/); // orders
  assert.match(prompt, /Current customers: 91/); // customers
  assert.match(prompt, /Noodles \$14 \(32\)/); // products
  assert.match(prompt, /Chili oil/); // inventory
  assert.match(prompt, /Slow service/); // reviews
  assert.match(prompt, /8 succeeded, 1 pending, 2 failed/); // payments
});
