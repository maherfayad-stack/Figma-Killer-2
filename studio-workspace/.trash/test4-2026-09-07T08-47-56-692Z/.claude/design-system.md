# Design system reference

Generated from this project's own design-system CSS (@alm-design/design-system, alm-design-design-system-1-1-3) — a MAP of the tokens and components, not the CSS itself. Regenerated on every chat turn from a content hash of the underlying files; do not hand-edit. Every line below names the file to open for the exact rule, selector, or dark-mode override.

## Colors (171 tokens)

By name prefix: color(54), background(41), border(20), icon(18), button(15), text(15), ai(3), overlay(3), liquid(2).

Reach for the semantic name that matches intent (`--text-warning-default`, `--background-primary-hover`, …) over a raw palette value — open the token file(s) for exact hex/rgba.

## Typography (8 size steps, 45 detail tokens)

--type-meta-size: 11px, --type-eyebrow-size: 12px, --type-caption-size: 12px, --type-body-size: 14px, --type-subtitle-size: 16px, --type-title-size: 18px, --type-headline-size: 26px, --type-display-size: 34px

Detail tokens (family/weight/line-height/letter-spacing) are counted, not listed by value — open the token file for the exact pairing.

## Spacing (14 tokens)

--space-2xs: 2px, --space-xs: 4px, --space-unit: 8px, --space-sm: 8px, --space-md: 12px, --space-card-gap: 12px, --space: 16px, --space-container: 16px, --space-lg: 24px, --space-xl: 32px, --space-section: 32px, --space-2xl: 40px, --space-3xl: 48px, --space-4xl: 64px

## Radius (6 tokens)

--rounded-xs: 4px, --rounded-sm: 8px, --rounded: 12px, --rounded-lg: 16px, --rounded-popover: 34px, --rounded-full: 100px

## Elevation / shadow (4 tokens)

--elevation-floating, --elevation-raised, --liquid-glass-shadow, --liquid-glass-sheet-shadow

Values are multi-part shadow strings — open the token file rather than guessing one.

19 other custom properties were found but did not fit any family above — open the token files directly for those.

## Components (56)

- .accolade — variants: --background, --small — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/Accolade.css
- .accordion — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/Accordion.css
- .action-sheet — variants: --android — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/ActionSheet.css
- .action-sheet-overlay — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/ActionSheet.css
- .ad-banner — variants: --card, --desktop, --large, --medium — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/AdBanner.css
- .badge — variants: --alert, --buttercap, --neutral, --new — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/Badge.css
- .badge-anchor — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/Badge.css
- .banner — variants: --color-featured, --color-info, --color-neutral, --color-promo, --small — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/Banner.css
- .bottom-action-bar — variants: --funnel, --payment — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/BottomActionBar.css
- .bottom-sheet — variants: --android, --fullscreen, --ios, --medium, --open, --small — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/BottomSheet.css
- .btn — variants: --apple-pay, --destructive, --gpay-card, --gpay-checkout-with, --gpay-pay-with, --gpay-personalized, --payment, --primary, --primary-inverted, --secondary, --secondary-inverted, --size-default, --size-medium, --size-small, --skeleton — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/Button.css
- .callout — variants: --small — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/Callout.css
- .cell — variants: --selected — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/Cell.css
- .checkbox — variants: --checked, --disabled, --error, --skeleton — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/Checkbox.css, styles/imported/alm-design-design-system-1-1-3/src/components/List.css
- .chip — variants: --dropdown, --error, --selected, --skeleton — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/Chip.css
- .cpi — variants: --android, --ios, --large, --with-label — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/CircularProgressIndicator.css
- .dialog — variants: --android — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/Dialog.css
- .dialog-overlay — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/Dialog.css
- .expander — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/Expander.css
- .eyebrow — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/tokens/typography.css
- .footer — variants: --pwa — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/Footer.css
- .glass-btn — variants: --bg-default, --bg-dim, --bg-primary, --type-1-icon, --type-back, --type-x — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/GlassButton.css
- .icon-btn — variants: --grey, --overlay, --primary, --secondary, --size-default, --size-medium, --size-small — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/IconButton.css
- .ios-dialog — variants: --side-by-side — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/IOSDialogCard.css
- .list-item — variants: --checkbox, --disabled, --error, --radio — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/List.css
- .lpi — variants: --android, --ios — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/LinearProgressIndicator.css
- .marketing-card — variants: --gradient-large, --gradient-small, --img-large, --img-medium, --img-small — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/MarketingCard.css
- .navbar — variants: --android, --default, --gradient, --ios, --overlay — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/Navbar.css
- .progress-stepper — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/ProgressStepper.css
- .radio — variants: --checked, --disabled, --error, --skeleton — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/List.css, styles/imported/alm-design-design-system-1-1-3/src/components/Radio.css
- .search — variants: --android, --ios — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/Search.css
- .seg-control — variants: --android — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/SegmentedControl.css
- .separator — variants: --dashed, --or, --section — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/Cell.css, styles/imported/alm-design-design-system-1-1-3/src/components/Separator.css
- .slider — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/Slider.css
- .snackbar — variants: --visible — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/Snackbar.css
- .stepper — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/Stepper.css
- .system-banner — variants: --caution, --desktop, --error, --neutral, --skeleton, --success, --visual — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/SystemBanner.css
- .tabbar — variants: --android, --ios — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/TabBar.css
- .tag — variants: --caution-filled, --caution-tinted, --default-filled, --neutral-filled, --neutral-tinted, --skeleton, --success-filled, --success-tinted, --warning-filled, --warning-tinted — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/Tag.css
- .text-input — variants: --disabled, --error, --focus, --multiline, --skeleton — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/TextInput.css
- .toggle — variants: --android, --checked, --disabled, --ios, --skeleton — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/Toggle.css
- .tooltip — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/Tooltip.css
- .type-body-bold — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/tokens/typography.css
- .type-body-regular — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/tokens/typography.css
- .type-body-semibold — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/tokens/typography.css
- .type-caption-regular — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/tokens/typography.css
- .type-caption-semibold — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/tokens/typography.css
- .type-display — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/tokens/typography.css
- .type-headline — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/tokens/typography.css
- .type-meta-regular — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/tokens/typography.css
- .type-meta-semibold — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/tokens/typography.css
- .type-subtitle — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/tokens/typography.css
- .type-subtitle-bold — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/tokens/typography.css
- .type-title — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/tokens/typography.css
- .type-title-bold — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/tokens/typography.css
- .visual-card — variants: --large, --medium, --no-bar — node_modules/@alm-design/design-system/dist/index.css, styles/imported/alm-design-design-system-1-1-3/src/components/VisualCard.css
