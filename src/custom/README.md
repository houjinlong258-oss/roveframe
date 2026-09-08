# RoveFrame Customization Layer

This directory represents the tenant customization boundaries for **RoveFrame AI Business OS**.

## Directory Taxonomy

```
src/custom/
├── themes/           # Custom visual design tokens, color variants, dark mode accents
├── workflows/        # Custom automated multi-step business workflows
├── plugins/          # Custom feature plugins with plugin.json manifests
├── prompts/          # Customized AI agent system prompt overlays
├── ui_components/    # Tenant-specific customizable UI component overrides
└── business_rules/   # Custom business logic policies (discount rules, inventory thresholds)
```

## Security & Protection Rules

1. **Core SaaS Protection**: Payment endpoints, authentication flows, core security logic, and database schemas residing in `src/core/` or `@/storage/database/` are immutable and CANNOT be modified by customization logic.
2. **Safe Fallbacks**: If a customization file is missing or invalid, the customization loader (`loader.ts`) seamlessly falls back to standard RoveFrame Core defaults.
