export interface CustomWorkflowStep {
  id: string;
  name: string;
  actionType: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface CustomWorkflowDefinition {
  id: string;
  name: string;
  description: string;
  triggerEvent: string;
  steps: CustomWorkflowStep[];
}

export const defaultCustomWorkflows: CustomWorkflowDefinition[] = [
  {
    id: 'wf_low_stock_restock_approval',
    name: 'Low Stock Auto Draft Approval Workflow',
    description: 'Automatically creates a purchase draft approval item when stock drops below safety threshold.',
    triggerEvent: 'INVENTORY_ALERT',
    steps: [
      {
        id: 'step_create_approval',
        name: 'Create Purchase Approval Item',
        actionType: 'purchase.create_draft',
        enabled: true,
        config: { requireHumanApproval: true },
      },
    ],
  },
];
