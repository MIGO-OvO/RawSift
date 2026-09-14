# RawSift Design System

## Direction

RawSift uses a restrained dark photo-workstation interface. The photograph is the visual center. Navigation and import controls remain stable around it, but their contrast and density stay below the image. The interface should feel like a carefully made desktop tool, not a technical dashboard.

## Color

The palette uses warm graphite OKLCH neutrals with soft warm-white text. A desaturated apricot accent is reserved for selection, focus, and the final import action. Muted green communicates a verified or kept state, and muted brick communicates rejection or failure. Every semantic state also includes text or an icon, never color alone. Pure black, pure white, cyan, neon, glow effects, and decorative gradients are excluded.

## Typography

Use `Segoe UI Variable`, `Microsoft YaHei UI`, and the system sans-serif fallback. Product copy uses sentence case. Hierarchy comes from size, weight, and spacing rather than uppercase labels or tracking. Body copy stays compact for desktop use while preserving legibility.

## Layout

The default workspace has one toolbar and three columns: date navigation, the photograph, and the import inspector. The center contains a quiet filter row, a borderless image stage, a metadata baseline, a compact filmstrip, and persistent keep/reject controls. At 1024 × 640, side columns narrow and secondary toolbar labels disappear, but no core workflow is hidden. Immersive mode removes surrounding chrome while retaining the filmstrip and decision controls.

## Components

Buttons use subtle filled hover states and short 100–180ms feedback. Segmented controls share one quiet background rather than individual outlined boxes. Date rows and queue rows are unboxed and gain a single soft surface only for hover or selection. The primary import button is the only large apricot surface. Separators are one pixel and appear only between structural regions.

## Motion and Accessibility

Motion uses exponential ease-out curves and never animates layout properties. Reduced-motion preferences collapse transitions. All controls expose visible focus rings and accessible names. Contrast targets WCAG 2.2 AA. Selection, transfer, and review states include redundant text or icon cues.
