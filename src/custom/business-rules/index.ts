export interface BusinessRulesCustomization {
  inventoryLowStockThreshold: number;
  revenueDropAlertPercent: number;
  reviewWinBackHours: number;
  customRuleFlags: Record<string, boolean>;
}

export const defaultBusinessRulesCustomization: BusinessRulesCustomization = {
  inventoryLowStockThreshold: 10,
  revenueDropAlertPercent: 20,
  reviewWinBackHours: 24,
  customRuleFlags: {
    enableAutoWinBackEmailDraft: true,
    enableInventoryRestockApproval: true,
  },
};
