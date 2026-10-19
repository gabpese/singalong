---
status: accepted
date: 2026-10-19
---

# 0014. Own CSS from design tokens, without Tailwind or a component kit

**English** · [Português (Brasil)](0014-own-css-with-tokens.pt-BR.md)

The look comes from the brand ([BRAND](../BRAND.md)): design tokens in one file (`apps/web/src/styles/theme-bridge.css`) feed a global stylesheet. Component kits and utility frameworks were rejected in the 1.4.0 redesign because they bring the generic look the redesign set out to remove. A test keeps class names unique across the global stylesheet, and another keeps the desktop app's copy of the tokens identical.
