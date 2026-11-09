import { useId } from 'react';

const CURL = 'M8 33c4 0 5.5-2 7.5-6.5S20 15 27 15c4.5 0 7 2.6 7 5.8 0 2.6-2 4.4-4.3 4.4-2 0-3.4-1.4-3.4-3.2';
const FOAM = 'M15.5 33c3 0 4-1.8 7.5-1.8S27 33 30 33s4.5-1.8 7.5-1.8';

/** The FlowWeb mark: a curling wave in a sea-blue tile. Decorative; the caller names it. */
export function LogoMark({ size = 30 }: { size?: number }) {
  const id = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      aria-hidden="true"
      focusable="false"
      className="logo-mark"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--logo-a)' }} />
          <stop offset=".6" style={{ stopColor: 'var(--logo-b)' }} />
          <stop offset="1" style={{ stopColor: 'var(--logo-c)' }} />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="14" fill={`url(#${id})`} />
      <rect
        x=".7"
        y=".7"
        width="46.6"
        height="46.6"
        rx="13.3"
        fill="none"
        style={{ stroke: 'var(--logo-rim)' }}
        strokeWidth="1.4"
      />
      <path
        d={FOAM}
        fill="none"
        style={{ stroke: 'var(--logo-foam)' }}
        strokeWidth="3"
        strokeLinecap="round"
        opacity=".85"
      />
      <path
        d={CURL}
        fill="none"
        style={{ stroke: 'var(--logo-curl)' }}
        strokeWidth="4.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Mark plus wordmark: script "Flow", bold "Web". The wordmark hides on narrow screens. */
export function Logo({ size = 30 }: { size?: number }) {
  return (
    <span className="logo">
      <LogoMark size={size} />
      <span className="logo-word" aria-hidden="true">
        <span className="logo-flow">Flow</span>
        <span className="logo-web">Web</span>
      </span>
    </span>
  );
}
