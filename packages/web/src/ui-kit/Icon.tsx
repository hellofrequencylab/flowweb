import type { ReactNode } from 'react';

/** Shapes that carry status without colour. Each status has a distinct shape and a word. */
export type IconName =
  | 'pass'
  | 'fail'
  | 'warn'
  | 'unknown'
  | 'notverified'
  | 'skipped'
  | 'waiting'
  | 'running'
  | 'paused'
  | 'stopped'
  | 'open'
  | 'blocked'
  | 'clock'
  | 'lock'
  | 'dot';

export function Icon({ name, size = 14, label }: { name: IconName; size?: number; label?: string }) {
  const p = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  let body: ReactNode;
  switch (name) {
    case 'pass':
      body = <path d="M3 8.5l3.2 3L13 4.5" {...p} />;
      break;
    case 'fail':
      body = <path d="M4 4l8 8M12 4l-8 8" {...p} />;
      break;
    case 'warn':
      body = (
        <>
          <path d="M8 2L14.5 13.5H1.5Z" {...p} />
          <path d="M8 6.5v3M8 11.5v0.01" {...p} />
        </>
      );
      break;
    case 'unknown':
      body = (
        <>
          <circle cx="8" cy="8" r="6" {...p} />
          <path d="M6.3 6.3a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1M8 11.2v.01" {...p} />
        </>
      );
      break;
    case 'notverified':
      body = <circle cx="8" cy="8" r="6" {...p} strokeDasharray="2.5 2.5" />;
      break;
    case 'skipped':
      body = <path d="M3 8h10" {...p} />;
      break;
    case 'waiting':
      body = <circle cx="8" cy="8" r="5" fill="currentColor" />;
      break;
    case 'running':
      body = <path d="M5 3.5l7 4.5-7 4.5Z" {...p} />;
      break;
    case 'paused':
      body = <path d="M5.5 3.5v9M10.5 3.5v9" {...p} />;
      break;
    case 'stopped':
      body = <rect x="3.5" y="3.5" width="9" height="9" {...p} />;
      break;
    case 'open':
      body = <circle cx="8" cy="8" r="5.5" {...p} />;
      break;
    case 'blocked':
      body = (
        <>
          <circle cx="8" cy="8" r="6" {...p} />
          <path d="M3.8 12.2l8.4-8.4" {...p} />
        </>
      );
      break;
    case 'clock':
      body = (
        <>
          <circle cx="8" cy="8" r="6" {...p} />
          <path d="M8 4.5V8l2.5 1.5" {...p} />
        </>
      );
      break;
    case 'lock':
      body = (
        <>
          <rect x="3.5" y="7" width="9" height="6.5" rx="1" {...p} />
          <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" {...p} />
        </>
      );
      break;
    case 'dot':
      body = <circle cx="8" cy="8" r="3" fill="currentColor" />;
      break;
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      {body}
    </svg>
  );
}
