import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function IconBase({ size = 18, children, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      {...props}
    >
      {children}
    </svg>
  );
}

export const Icons = {
  aperture: (props: IconProps) => (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
      <path d="m8.2 4.9 3.5 6.1M19.4 8h-7M18 18.4l-3.5-6M6 17h7M5.4 8.3l3.5 6" stroke="currentColor" strokeWidth="1.5" />
    </IconBase>
  ),
  camera: (props: IconProps) => (
    <IconBase {...props}>
      <path d="M4 7.5h3l1.3-2h7.4l1.3 2h3v11H4z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.5" />
      <circle cx="12" cy="13" r="3.4" stroke="currentColor" strokeWidth="1.5" />
    </IconBase>
  ),
  check: (props: IconProps) => (
    <IconBase {...props}>
      <path d="m5 12.5 4.2 4.2L19.4 6.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
    </IconBase>
  ),
  chevronLeft: (props: IconProps) => (
    <IconBase {...props}>
      <path d="m14.5 5-7 7 7 7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
    </IconBase>
  ),
  chevronRight: (props: IconProps) => (
    <IconBase {...props}>
      <path d="m9.5 5 7 7-7 7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
    </IconBase>
  ),
  compare: (props: IconProps) => (
    <IconBase {...props}>
      <rect height="13" rx="1" stroke="currentColor" strokeWidth="1.5" width="7" x="3" y="5.5" />
      <rect height="13" rx="1" stroke="currentColor" strokeWidth="1.5" width="7" x="14" y="5.5" />
    </IconBase>
  ),
  folder: (props: IconProps) => (
    <IconBase {...props}>
      <path d="M3.5 6.5h6l2 2h9v9.5h-17z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.5" />
    </IconBase>
  ),
  grid: (props: IconProps) => (
    <IconBase {...props}>
      <path d="M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm10 0h6v6h-6z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.5" />
    </IconBase>
  ),
  histogram: (props: IconProps) => (
    <IconBase {...props}>
      <path d="M3 19V5m0 14h18M6 17v-4m3 4V8m3 9v-6m3 6V6m3 11v-8" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
    </IconBase>
  ),
  info: (props: IconProps) => (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12 10.5V17m0-10.2v.2" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </IconBase>
  ),
  list: (props: IconProps) => (
    <IconBase {...props}>
      <path d="M9 6h11M9 12h11M9 18h11M4 6h.1M4 12h.1M4 18h.1" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </IconBase>
  ),
  reject: (props: IconProps) => (
    <IconBase {...props}>
      <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </IconBase>
  ),
  rotate: (props: IconProps) => (
    <IconBase {...props}>
      <path d="M19 8V4l-2 2.1A8 8 0 1 0 19.5 14" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
    </IconBase>
  ),
  search: (props: IconProps) => (
    <IconBase {...props}>
      <circle cx="10.5" cy="10.5" r="6" stroke="currentColor" strokeWidth="1.5" />
      <path d="m15 15 5 5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
    </IconBase>
  ),
  settings: (props: IconProps) => (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
    </IconBase>
  ),
};

