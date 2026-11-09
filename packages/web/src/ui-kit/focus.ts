/**
 * Ref callback that moves focus to an element when it appears. Use only where
 * the user's own action opened it (a dialog, a confirm step, a form they asked
 * for), never on page load of ordinary content.
 */
export function focusOnMount(el: HTMLElement | null) {
  el?.focus();
}
