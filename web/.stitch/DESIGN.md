---
name: 影策 Canvas
colors:
  surface: '#0e0f15'
  surface-raised: '#171724'
  surface-overlay: '#111216'
  on-surface: '#ffffff'
  on-surface-muted: 'rgba(255,255,255,0.60)'
  outline: 'rgba(163,148,255,0.20)'
  primary: '#684fff'
  primary-strong: '#2477f2'
  primary-container: 'rgba(105,83,255,0.16)'
  on-primary: '#ffffff'
  success: '#6ee7b7'
  success-container: 'rgba(52,211,153,0.12)'
  warning: '#fcd34d'
  warning-container: 'rgba(251,191,36,0.10)'
  loading: '#c4b5fd'
  loading-container: 'rgba(139,92,246,0.12)'
typography:
  display:
    fontFamily: Inter Variable
    fontSize: 36px
    fontWeight: '700'
    lineHeight: 44px
    letterSpacing: '-0.02em'
  title:
    fontFamily: Inter Variable
    fontSize: 22px
    fontWeight: '700'
    lineHeight: 30px
    letterSpacing: '-0.02em'
  body:
    fontFamily: Inter Variable
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 22px
    letterSpacing: '0'
  action:
    fontFamily: Inter Variable
    fontSize: 16px
    fontWeight: '600'
    lineHeight: 20px
    letterSpacing: '0'
rounded:
  sm: 6px
  md: 8px
  lg: 12px
  xl: 16px
  panel: 26px
  full: 9999px
spacing:
  unit: 4px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
---

# Design System: 影策 Canvas

## 1. Visual Theme & Atmosphere

影策 Canvas uses a deep charcoal workspace with restrained violet light to make video, image, and workflow content the visual focus. The interface is dense enough for a creative-production canvas, while modal surfaces and cards use translucent gradients, hairline borders, and black elevation to remain calm over the dark canvas.

Interactive emphasis comes from blue-to-violet gradients. Functional states are deliberately separated: amber starts an attention-required manual task, violet represents in-progress work, and emerald confirms a finished result.

## 2. Color Palette & Roles

### Primary Foundation

- **Midnight Workspace** `#0e0f15` — primary canvas and modal base.
- **Lifted Indigo Surface** `#171724` — modal and review-card surface.
- **Soft Violet Outline** `rgba(163,148,255,0.20)` — card and modal separation.

### Accent & Interactive

- **Electric Violet** `#684fff` and **Clear Blue** `#2477f2` — primary actions and selected paths.
- **Manual Transcription Amber** `#fcd34d` on `rgba(251,191,36,0.10)` — the actionable “语音转写” state.
- **Transcription Success Emerald** `#6ee7b7` on `rgba(52,211,153,0.12)` — “语音转写完成”.
- **Processing Violet** `#c4b5fd` on `rgba(139,92,246,0.12)` — a non-actionable in-progress state.

### Typography & Text Hierarchy

- **Primary Text** `#ffffff` — titles and actions.
- **Secondary Text** `rgba(255,255,255,0.60)` — descriptions and metadata.
- **Tertiary Text** `rgba(255,255,255,0.45)` — supporting workflow hints.

## 3. Typography Rules

Inter Variable with PingFang SC fallbacks is used for both Latin and Chinese. Large titles use tight tracking and a 700 weight. Body text is 14px with a relaxed 22px line height. Compact controls use 600 weight so they remain legible against translucent surfaces.

## 4. Component Stylings

### Buttons and Status Chips

Primary buttons use a violet-to-blue horizontal gradient, white 600-weight labels, and a soft blue shadow. Status chips are pill shaped. The manual transcription trigger is an amber outlined pill with a wave icon; after completion it becomes an emerald outlined pill with a check icon and the label “语音转写完成”. While processing, preserve the same geometry but use violet and a spinner.

### Cards & Review Modal

Review surfaces combine a dark linear gradient, subtle violet radial light, 1px translucent outlines, and 16–26px radii. Separate sections with low-contrast borders instead of bright dividers. Use black shadows for depth; do not use white glow as an elevation substitute.

### Canvas Nodes

Nodes use semantic color accents, large icon tiles, concise text hierarchy, and 4px-based spacing. Video review cards visually inherit the violet system and should avoid opening unrelated image-generation controls.

## 5. Layout Principles

The base grid is 4px with common 8px, 16px, 24px, and 32px intervals. Review modals use a main content area plus a narrow workflow guidance rail. Controls maintain at least 44px high interactive targets. On narrower screens, preserve clear action labels and let grids reduce columns before shrinking content.

## 6. Design System Notes for Stitch Generation

### Language to Use

Use: “dark cinematic creative workspace”, “restrained violet glow”, “hairline translucent borders”, “high-contrast Chinese workflow labels”, and “pill-shaped functional status”.

### Component Prompts

- “Create a dark video-review modal with a violet radial glow, amber manual transcription button, and emerald completed transcription badge.”
- “Create a FrameScript canvas node with a blue-violet CTA and compact workflow status chips.”

### Incremental Iteration

Preserve the state-color contract: amber for manual action, violet for processing, emerald for completion. Avoid adding colors that compete with the source footage or primary generation actions.
