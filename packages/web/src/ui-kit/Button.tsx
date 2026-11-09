import { type ButtonHTMLAttributes, type ReactNode, useId } from 'react';

/**
 * Every disabled button says why, in words, next to it.
 * `disabledReason` disables the button and renders the reason underneath,
 * linked with aria-describedby.
 */
export function Button({
  variant = 'default',
  disabledReason,
  shortcut,
  children,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'quiet' | 'stop' | 'big';
  disabledReason?: string | null;
  shortcut?: string;
  children: ReactNode;
}) {
  const id = useId();
  const disabled = Boolean(disabledReason) || rest.disabled;
  const btn = (
    <button
      type="button"
      {...rest}
      disabled={disabled}
      aria-describedby={disabledReason ? id : rest['aria-describedby']}
      aria-keyshortcuts={shortcut}
      className={`btn ${variant !== 'default' ? `btn-${variant}` : ''} ${className}`}
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
        {disabledReason}
      </span>
    </span>
  );
}
