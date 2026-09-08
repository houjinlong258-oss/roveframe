import { defaultThemeCustomization, ThemeCustomization } from './themes/default';
import { defaultPromptCustomization, PromptCustomization } from './prompts/business-agent';
import { defaultBusinessRulesCustomization, BusinessRulesCustomization } from './business-rules';
import { defaultCustomWorkflows, CustomWorkflowDefinition } from './workflows';

export interface TenantCustomizationBundle {
  theme: ThemeCustomization;
  prompts: PromptCustomization;
  rules: BusinessRulesCustomization;
  workflows: CustomWorkflowDefinition[];
}

let activeCustomizationBundle: TenantCustomizationBundle = {
  theme: defaultThemeCustomization,
  prompts: defaultPromptCustomization,
  rules: defaultBusinessRulesCustomization,
  workflows: defaultCustomWorkflows,
};

/** Load active customization bundle with safe fallback to core defaults. */
export function getActiveCustomization(): TenantCustomizationBundle {
  return activeCustomizationBundle;
}

/** Update customization bundle dynamically (e.g. from tenant DB overrides or custom layer). */
export function updateActiveCustomization(
  overrides: Partial<TenantCustomizationBundle>
): TenantCustomizationBundle {
  activeCustomizationBundle = {
    theme: { ...activeCustomizationBundle.theme, ...(overrides.theme ?? {}) },
    prompts: {
      ...activeCustomizationBundle.prompts,
      ...(overrides.prompts ?? {}),
      customInstructions: [
        ...(activeCustomizationBundle.prompts.customInstructions ?? []),
        ...(overrides.prompts?.customInstructions ?? []),
      ],
    },
    rules: {
      ...activeCustomizationBundle.rules,
      ...(overrides.rules ?? {}),
      customRuleFlags: {
        ...activeCustomizationBundle.rules.customRuleFlags,
        ...(overrides.rules?.customRuleFlags ?? {}),
      },
    },
    workflows: overrides.workflows ?? activeCustomizationBundle.workflows,
  };
  return activeCustomizationBundle;
}

/** Reset customization to core defaults. */
export function resetCustomizationToDefaults(): TenantCustomizationBundle {
  activeCustomizationBundle = {
    theme: defaultThemeCustomization,
    prompts: defaultPromptCustomization,
    rules: defaultBusinessRulesCustomization,
    workflows: defaultCustomWorkflows,
  };
  return activeCustomizationBundle;
}
