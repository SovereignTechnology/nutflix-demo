import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { IconButton } from '../Button/Button.js';
import { cx } from '../shared/format.js';

export interface SheetProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title?: string | undefined;
  /** `right` = desktop side panel (peer panel, rendition picker, settings); `bottom` = mobile-style. */
  readonly side?: 'right' | 'bottom';
  /** Width (right) or max height (bottom); CSS length. */
  readonly size?: string | undefined;
  /** Renders inside the current layout instead of fixed to the viewport (Storybook, embedded). */
  readonly inline?: boolean;
  readonly children?: ReactNode;
  readonly footer?: ReactNode;
  readonly className?: string;
  /**
   * What receives focus when the sheet opens. Default: the first focusable element (the
   * Close button). Pass `'first-field'` for the first enabled form field — a form sheet
   * should land in its first input, not on Close — a CSS selector resolved inside the panel,
   * or a ref. Falls back to the default when nothing matches.
   */
  readonly initialFocus?: string | RefObject<HTMLElement | null> | undefined;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** `initialFocus="first-field"`: the first enabled, visible-to-AT form control. */
const FIRST_FIELD =
  'input:not([disabled]):not([type="hidden"]):not([aria-hidden="true"]), select:not([disabled]), textarea:not([disabled])';

function initialTarget(
  panel: HTMLElement,
  initialFocus: SheetProps['initialFocus'],
): HTMLElement | null {
  if (initialFocus !== undefined) {
    if (typeof initialFocus === 'string') {
      const selector = initialFocus === 'first-field' ? FIRST_FIELD : initialFocus;
      let el: HTMLElement | null = null;
      try {
        el = panel.querySelector<HTMLElement>(selector);
      } catch {
        // an invalid selector must not break the sheet: fall back to the default below
      }
      if (el !== null) return el;
    } else if (initialFocus.current !== null && panel.contains(initialFocus.current)) {
      return initialFocus.current;
    }
  }
  return panel.querySelector<HTMLElement>(FOCUSABLE);
}

/**
 * Modal sheet: backdrop, `role="dialog"` + `aria-modal`, Escape and backdrop click close,
 * focus moves in on open and is trapped with Tab; the previous element is refocused on
 * close. Motion ≤ 200 ms and disabled under `prefers-reduced-motion` (tokens).
 */
export function Sheet({
  open,
  onClose,
  title,
  side = 'right',
  size,
  inline = false,
  children,
  footer,
  className,
  initialFocus,
}: SheetProps): ReactElement | null {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<Element | null>(null);

  // Read once per open: the target is chosen when the sheet opens, not on every render.
  const initialFocusRef = useRef(initialFocus);
  initialFocusRef.current = initialFocus;

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement;
    const panel = panelRef.current;
    // Children's effects have run by now, so a ref passed in is already attached.
    const target = panel === null ? null : initialTarget(panel, initialFocusRef.current);
    (target ?? panel)?.focus();
    return () => {
      const prev = restoreRef.current;
      if (prev instanceof HTMLElement) prev.focus();
    };
  }, [open]);

  if (!open) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !panelRef.current) return;
    const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const firstEl = items[0];
    const lastEl = items[items.length - 1];
    if (!firstEl || !lastEl) return;
    if (e.shiftKey && document.activeElement === firstEl) {
      e.preventDefault();
      lastEl.focus();
    } else if (!e.shiftKey && document.activeElement === lastEl) {
      e.preventDefault();
      firstEl.focus();
    }
  };

  return (
    <div
      className={cx('nf-sheet', `nf-sheet--${side}`, inline && 'nf-sheet--inline', className)}
      onKeyDown={onKeyDown}
    >
      <div
        className="nf-sheet__backdrop"
        onClick={onClose}
        data-testid="sheet-backdrop"
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        className="nf-sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : 'Sheet'}
        tabIndex={-1}
        style={size ? (side === 'right' ? { width: size } : { maxHeight: size }) : undefined}
      >
        <header className="nf-sheet__head">
          {title ? (
            <h2 id={titleId} className="nf-sheet__title">
              {title}
            </h2>
          ) : (
            <span />
          )}
          <IconButton icon="close" label="Close" onClick={onClose} />
        </header>
        <div className="nf-sheet__body">{children}</div>
        {footer ? <footer className="nf-sheet__foot">{footer}</footer> : null}
      </div>
    </div>
  );
}
