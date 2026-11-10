import { type ButtonHTMLAttributes, type ReactNode, useId } from 'react';
import { HOSTED } from '../hosted/auth';
import { Icon } from './Icon';

/** The reason a Mac-only action gives on flowweb.app, where fwd is not reachable. */
export const MAC_ONLY = 'Only on your Mac';

/** The disabled reason for an action only fwd on the Owner's Mac can take: set on the site, null on the Mac. */
export function macOnlyReason(macOnly = true): string | null {
  return macOnly && HOSTED ? MAC_ONLY : null;
}

/**
 * Every disabled button says why, in words, next to it.
 * `disabledReason` disables the button and renders the reason underneath,
 * linked with aria-describedby.
 * `macOnly` marks an action only fwd on the Owner's Mac can take: on flowweb.app the button is
 * disabled with "Only on your Mac" as the reason, instead of failing after it is pressed.
 */
export function Button({
  variant = 'default',
  disabledReason: reason,
  macOnly,
  shortcut,
  children,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'quiet' | 'stop' | 'big';
  disabledReason?: string | null;
  macOnly?: boolean;
  shortcut?: string;
  children: ReactNode;
}) {
  const id = useId();
  const disabledReason = macOnlyReason(Boolean(macOnly)) ?? reason;
  const disabled = Boolean(disabledReason) || rest.disabled;
  const btn = (
    <button
      type="button"
      {...rest}
      disabled={disabled}
      aria-describedby={disabledReason ? id : rest['aria-describedby']}
      aria-keyshortcuts={shortcut}
      className={['btn', variant !== 'default' && `btn-${variant}`, className].filter(Boolean).join(' ')}
    >
      {children}
      {shortcut && (
        <span className="kbd" aria-hidden="true">
          {shortcut}
        </span>
      )}
    </button>
  );
  if (!disabledReason) return btn;
  return (
    <span className="action-group">
      {btn}
      <span id={id} className="disabled-reason">
        <Icon name="lock" size={13} />
        {disabledReason}
      </span>
    </span>
  );
}
