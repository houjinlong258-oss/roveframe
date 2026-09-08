export interface PromptCustomization {
  systemPromptOverlay?: string;
  toneStyle?: 'professional' | 'friendly' | 'concise';
  customInstructions?: string[];
}

export const defaultPromptCustomization: PromptCustomization = {
  toneStyle: 'professional',
  customInstructions: [
    'Always prioritize ROI and revenue optimization when generating suggestions.',
    'Keep financial read-only guarantees intact.',
  ],
};
