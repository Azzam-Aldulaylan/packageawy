import type { ReactElement, SVGProps } from 'react';

/**
 * A small, hand-authored icon set in the Codicon visual language (16x16,
 * stroke-based, `currentColor`) rather than a third-party icon package or
 * the actual Codicon font. The CSP's `style-src`/`font-src` only admit the
 * webview's bundled stylesheet: no remote font, and adding a local
 * font file would mean teaching dashboardPanel.ts and esbuild.mjs a new
 * asset-copy step just for this redesign. Inline SVG needs neither: it is
 * markup from the same nonce-tagged bundle already trusted to run.
 *
 * Icons are always paired with visible text or an aria-label on the
 * interactive element that hosts them, never the sole indicator of a
 * status (see the accessibility requirements this redesign has to meet),
 * so every icon here is `aria-hidden` and purely decorative on its own.
 */

type IconProps = Omit<SVGProps<SVGSVGElement>, 'viewBox' | 'xmlns'>;

function Svg({ children, ...props }: IconProps & { children: ReactElement }): ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

/** The Packageawy logo for the dashboard header. Filled, unlike the stroke icons, and drawn from media/activity-bar.svg. */
export function IconBrand(props: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true" focusable="false" {...props}>
      <path fillRule="evenodd" d="M3.478 5.108 Q3.180 4.950 3.491 4.820 L10.880 1.736 Q11.752 1.373 12.630 1.723 L15.465 2.857 Q15.465 2.857 15.465 2.857 L7.055 6.581 Q6.623 6.772 6.205 6.551 Z" />
      <path fillRule="evenodd" d="M8.205 7.333 Q7.905 7.178 8.215 7.044 L16.246 3.584 Q16.680 3.397 17.110 3.593 L20.828 5.283 Q21.135 5.422 20.822 5.549 L12.571 8.898 Q11.820 9.203 11.101 8.830 Z" />
      <path fillRule="evenodd" d="M1.830 6.840 Q1.830 5.827 2.730 6.292 L5.670 7.808 Q6.150 8.055 6.150 8.595 L6.150 18.922 Q6.150 19.598 5.566 19.260 L2.707 17.607 Q1.830 17.100 1.830 16.087 Z" />
      <path fillRule="evenodd" d="M7.365 9.203 Q7.365 8.393 8.094 8.745 L10.639 9.976 Q11.550 10.417 12.490 10.040 L21.184 6.551 Q21.810 6.300 21.810 6.975 L21.810 17.438 Q21.810 18.315 20.981 18.602 L11.630 21.832 Q10.672 22.162 9.801 21.647 L7.946 20.549 Q7.365 20.205 7.365 19.530 Z M8.850 12.037 Q8.850 11.362 9.364 11.801 L12.721 14.664 Q13.440 15.277 12.751 15.925 L9.428 19.047 Q8.985 19.462 8.948 18.856 L8.887 17.841 Q8.850 17.235 9.294 16.820 L10.776 15.437 Q10.875 15.345 10.775 15.255 L9.302 13.929 Q8.850 13.523 8.850 12.915 Z M13.710 17.235 Q13.710 16.627 14.317 16.627 L19.312 16.627 Q19.920 16.627 19.920 17.235 L19.920 17.640 Q19.920 18.247 19.312 18.247 L14.317 18.247 Q13.710 18.247 13.710 17.640 Z" />
    </svg>
  );
}

/** Generic package/library glyph: the Total card and the table's package-name fallback icon. */
export function IconPackage(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <>
        <path d="M8 1.5 14 4.75v6.5L8 14.5 2 11.25v-6.5z" />
        <path d="M2 4.75 8 8l6-3.25" />
        <path d="M8 8v6.5" />
      </>
    </Svg>
  );
}

/** Updates Available. */
export function IconTrendUp(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <>
        <path d="M1.5 11.5 6 7l3 3 5.5-5.5" />
        <path d="M10.5 4.5h4v4" />
      </>
    </Svg>
  );
}

/** Vulnerabilities. */
export function IconShield(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <>
        <path d="M8 1.5 13.5 3.5v4c0 3.5-2.3 5.9-5.5 7-3.2-1.1-5.5-3.5-5.5-7v-4z" />
        <path d="M5.75 8 7.25 9.5 10.25 6.5" />
      </>
    </Svg>
  );
}

/** Needs Attention, and the warning/partial-error banners. */
export function IconAlertTriangle(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <>
        <path d="M8 2 14.5 13.5h-13z" />
        <path d="M8 6.5v3" />
        <path d="M8 11.75h.01" />
      </>
    </Svg>
  );
}

export function IconSearch(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <>
        <circle cx="6.75" cy="6.75" r="4.25" />
        <path d="m13 13-3.2-3.2" />
      </>
    </Svg>
  );
}

export function IconX(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path d="M3.5 3.5l9 9m0-9-9 9" />
    </Svg>
  );
}

export function IconRefresh(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <>
        <path d="M13 5.5A5.5 5.5 0 0 0 3.4 4.1L1.5 6" />
        <path d="M1.5 2v4h4" />
        <path d="M3 10.5A5.5 5.5 0 0 0 12.6 11.9l1.9-1.9" />
        <path d="M14.5 14v-4h-4" />
      </>
    </Svg>
  );
}

export function IconChevronRight(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path d="M6 3.5 10.5 8 6 12.5" />
    </Svg>
  );
}

export function IconChevronLeft(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path d="M10 3.5 5.5 8 10 12.5" />
    </Svg>
  );
}

export function IconFolder(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path d="M1.5 4a1 1 0 0 1 1-1h3l1.5 1.75H13.5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />
    </Svg>
  );
}

/** The version-terminology affordance next to the Available header, and the empty-state info glyph. */
export function IconInfo(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <>
        <circle cx="8" cy="8" r="6.25" />
        <path d="M8 7.25v4" />
        <path d="M8 4.75h.01" />
      </>
    </Svg>
  );
}

/**
 * A sort header's direction indicator. Ascending as drawn. The caller
 * rotates 180deg via CSS for descending, and the pagination "previous"
 * button reuses `IconChevronRight` the same way rather than drawing a
 * mirror-image icon for each.
 */
export function IconSortArrow(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path d="M8 12.5v-9m0 0L4.5 7m3.5-3.5L11.5 7" />
    </Svg>
  );
}

/** The neutral/unsorted state of a sortable header: both directions, equally faint. */
export function IconSortNeutral(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <>
        <path d="M5 6.5 8 3.5l3 3" />
        <path d="M5 9.5 8 12.5l3-3" />
      </>
    </Svg>
  );
}

/** The "no results for this filter" empty state. */
export function IconFilter(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path d="M2 3h12l-4.5 5.5v4L6.5 14V8.5z" />
    </Svg>
  );
}

/** The quiet "Up to date" Action-column state. */
export function IconCheck(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
    </Svg>
  );
}

/** "View advisory source ↗". */
export function IconExternalLink(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <>
        <path d="M6.5 3.5h-3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3" />
        <path d="M9.5 2.5h4v4" />
        <path d="M13.2 2.8 7.5 8.5" />
      </>
    </Svg>
  );
}

/** "Unknown"/"could not be determined" outcome states: the Upgrade Analysis modal's fourth status alongside check/warning/x. */
export function IconHelpCircle(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <>
        <circle cx="8" cy="8" r="6.25" />
        <path d="M6.1 6.1a2 2 0 1 1 2.9 1.8c-.6.35-1 .7-1 1.5" />
        <path d="M8 11.75h.01" />
      </>
    </Svg>
  );
}

/** A conflict/blocking outcome: distinct from the plain dismiss "×" (IconX): a filled ring makes it read as a status, not a close affordance. */
export function IconXCircle(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <>
        <circle cx="8" cy="8" r="6.25" />
        <path d="M6 6l4 4m0-4-4 4" />
      </>
    </Svg>
  );
}

/** The Files section: package.json/lockfile ownership. */
export function IconFile(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <>
        <path d="M4.5 1.75h4.5L12.5 5v8.5a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-10.75a1 1 0 0 1 1-1z" />
        <path d="M9 1.75V5h3.5" />
      </>
    </Svg>
  );
}

/** The Verification section: a script/checklist glyph. */
export function IconListChecks(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <>
        <path d="M6 4h6.5" />
        <path d="M6 8h6.5" />
        <path d="M6 12h6.5" />
        <path d="m2 4 .8.8L4.4 3" />
        <path d="m2 8 .8.8L4.4 7" />
        <path d="m2 12 .8.8L4.4 11" />
      </>
    </Svg>
  );
}

/** The Smart Plan / coordinated-upgrade recommendation section, and Analyze remediation. */
export function IconRoute(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <>
        <circle cx="3.5" cy="4" r="1.5" />
        <circle cx="12.5" cy="12" r="1.5" />
        <path d="M3.5 5.5V9a2 2 0 0 0 2 2h5" />
      </>
    </Svg>
  );
}

/** "Configure verification": a settings/gear glyph. */
export function IconGear(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <>
        <circle cx="8" cy="8" r="2.1" />
        <path d="M8 2.3v1.5m0 8.4v1.5M13.7 8h-1.5M3.8 8H2.3m8.15-4.15-1.06 1.06M6.61 10.53 5.55 11.6m0-7.75 1.06 1.06m3.98 3.98 1.06 1.06" />
      </>
    </Svg>
  );
}

/** Rollback: a counter-clockwise history/undo arrow, for "restores your files if something fails". */
export function IconHistory(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <>
        <path d="M3.2 8a4.8 4.8 0 1 0 1.5-3.47" />
        <path d="M2 3v2.3h2.3" />
        <path d="M8 5.3V8l1.8 1.1" />
      </>
    </Svg>
  );
}

/** "Where is this used?" and the usage-analysis / cleanup results. */
export function IconTarget(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <>
        <circle cx="8" cy="8" r="6.25" />
        <circle cx="8" cy="8" r="3" />
        <circle cx="8" cy="8" r="0.6" fill="currentColor" />
      </>
    </Svg>
  );
}

/** "Analyze cleanup": a broom/sweep glyph for the dependency-hygiene scan. */
export function IconBroom(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <>
        <path d="M9.5 2.5 4 12.5" />
        <path d="M2 13.5 4 9.8" />
        <path d="M9.5 2.5c1.4-.5 3 .1 3.6 1.4.6 1.3.1 2.8-1.1 3.6L7.8 9.8" />
        <path d="M4 9.8h6" />
      </>
    </Svg>
  );
}

/** The Remove dependency action card and destructive Remove buttons. */
export function IconTrash(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <>
        <path d="M3 4.5h10" />
        <path d="M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5" />
        <path d="M4.25 4.5 4.9 13a1 1 0 0 0 1 .9h4.2a1 1 0 0 0 1-.9l.65-8.5" />
        <path d="M6.6 7v4M9.4 7v4" />
      </>
    </Svg>
  );
}

/** The Manage dependency action, and the modal's package-identity header. */
export function IconSliders(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <>
        <path d="M2 4.5h5.5M10 4.5h4" />
        <path d="M2 8h2.5M7 8h7" />
        <path d="M2 11.5h8M13 11.5h1" />
        <circle cx="8.5" cy="4.5" r="1.5" />
        <circle cx="5.5" cy="8" r="1.5" />
        <circle cx="10.5" cy="11.5" r="1.5" />
      </>
    </Svg>
  );
}
