// Shared overlays and widgets on native platform features: menus and panels
// are popovers opened by invoker commands, modals are <dialog>, tooltips are
// interest-invoked hints, toasts are manual popovers in one region. Features
// not every target browser has yet (focusgroup, closedby, anchor positioning)
// get a small fallback here, so views never re-implement them.
import { cloneElement, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';

declare module 'react' {
  interface ButtonHTMLAttributes<T> {
    commandfor?: string;
    command?: string;
    interestfor?: string;
  }
  interface HTMLAttributes<T> {
    focusgroup?: string;
    focusgroupstart?: '';
  }
  interface InputHTMLAttributes<T> {
    // Native switch where supported (Safari); role="switch" and our CSS are the fallback look.
    switch?: '';
  }
}

const has = (proto: object, key: string) => typeof window !== 'undefined' && key in proto;
// Read at call time: tests and the interestfor polyfill can add them after load.
// Roles stay explicit even with native focusgroup: Chromium 157 moves focus but
// doesn't infer tablist/tab or menu/menuitem yet, and matching roles change nothing once it does.
export const nativeFocusgroup = () => has(HTMLElement.prototype, 'focusGroup');
const popovers = () => has(HTMLElement.prototype, 'showPopover');
const nativeClosedBy = () => has(HTMLDialogElement.prototype, 'closedBy');
const nativeAnchors = () => typeof CSS !== 'undefined' && CSS.supports?.('position-area: block-end');

// Arrow keys, Home and End between the enabled buttons of a group, where the
// browser has no focusgroup to do it. Each button may be wrapped once (as Tip does).
export function arrowKeys(e: KeyboardEvent<HTMLElement>, axis: 'block' | 'inline') {
  if (nativeFocusgroup()) return;
  const keys = axis === 'block' ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
  if (![...keys, 'Home', 'End'].includes(e.key)) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  if (at < 0) return;
  e.preventDefault();
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (at + (e.key === keys[0] ? -1 : 1) + items.length) % items.length;
  items[next].focus();
}

// Where anchor positioning is missing, put the popover under its trigger, flipped and clamped to the window.
function place(pop: HTMLElement, trigger: HTMLElement) {
  if (nativeAnchors()) return;
  const t = trigger.getBoundingClientRect();
  const p = pop.getBoundingClientRect();
  const left = Math.min(Math.max(8, t.left), window.innerWidth - p.width - 8);
  const top = t.bottom + p.height + 4 > window.innerHeight ? Math.max(8, t.top - p.height - 4) : t.bottom + 4;
  Object.assign(pop.style, { position: 'fixed', inset: 'auto', margin: '0', left: `${left}px`, top: `${top}px` });
}

type PopupProps = {
  // The trigger's content and look.
  label: ReactNode;
  triggerClass: string;
  triggerLabel?: string;
  disabled?: boolean;
  // The popover's accessible name and class.
  name: string;
  className: string;
  // A menu: arrow keys between its buttons, and choosing one closes it.
  menu?: boolean;
  onOpen?(): void;
  children: ReactNode | ((close: () => void) => ReactNode);
};

// A button and the popover it toggles (light dismiss, Esc and focus return come
// from the browser). A menu also takes the keyboard into its items on a keyboard open.
export function Popup({ label, triggerClass, triggerLabel, disabled, name, className, menu, onOpen, children }: PopupProps) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const enter = useRef(false);
  const first = () => pop.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  const opened = () => {
    place(pop.current!, trigger.current!);
    onOpen?.();
    if (enter.current) requestAnimationFrame(first);
    enter.current = false;
  };
  // Focus goes back to the trigger before the popover hides, without a ring after a pointer click.
  const close = () => {
    trigger.current?.focus({ focusVisible: false } as FocusOptions);
    if (popovers()) pop.current?.hidePopover();
    else setOpen(false);
  };
  // Without invoker commands (older browsers, jsdom) the click toggles it from script.
  const toggle = () => {
    if ('commandForElement' in HTMLButtonElement.prototype) return;
    const p = pop.current!;
    if (!popovers()) {
      if (!open) requestAnimationFrame(opened);
      return setOpen(!open);
    }
    if (p.matches(':popover-open')) p.hidePopover();
    else p.showPopover();
  };
  const content = typeof children === 'function' ? children(close) : children;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={triggerClass}
        aria-label={triggerLabel}
        disabled={disabled}
        aria-haspopup={menu ? 'menu' : undefined}
        aria-expanded={open}
        commandfor={id}
        command="toggle-popover"
        onClick={toggle}
        onKeyDown={(e) => {
          if (!menu) return;
          if (e.key === 'Enter' || e.key === ' ') enter.current = true;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (open) first();
            else {
              enter.current = true;
              trigger.current?.click();
            }
          }
        }}
      >
        {label}
      </button>
      {/* Right after its trigger, so no implicit aria-details is added. */}
      <div
        ref={pop}
        id={id}
        popover="auto"
        className={`pop ${className}`}
        role={menu ? undefined : 'region'}
        aria-label={menu ? undefined : name}
        hidden={popovers() ? undefined : !open}
        onToggle={(e) => {
          const now = e.newState === 'open';
          setOpen(now);
          if (now) opened();
        }}
        // Tabbing out closes it, so focus never stays in hidden content.
        onBlur={(e) => {
          const to = e.relatedTarget as Node | null;
          if (to && !e.currentTarget.contains(to) && to !== trigger.current) {
            if (popovers()) e.currentTarget.hidePopover();
            else setOpen(false);
          }
        }}
        onClick={menu ? (e) => (e.target as HTMLElement).closest('button') && close() : undefined}
      >
        {menu ? (
          <div focusgroup="menu nomemory" role="menu" aria-label={name} onKeyDown={(e) => arrowKeys(e, 'block')}>
            {content}
          </div>
        ) : (
          content
        )}
      </div>
    </>
  );
}

// One item of a Popup menu: a command with a title and a line of detail.
export function MenuItem({ title, detail, onSelect }: { title: string; detail?: string; onSelect(): void }) {
  return (
    <button type="button" role="menuitem" onClick={onSelect}>
      <b>{title}</b>
      {detail && <small>{detail}</small>}
    </button>
  );
}

export function MenuSection({ children }: { children: ReactNode }) {
  return (
    <>
      <hr />
      <div className="menu-section" aria-hidden>{children}</div>
    </>
  );
}

// A modal over the app: a native <dialog> opened with showModal() (focus trap,
// inert page, Esc, focus return), closed by its Close button or a click outside.
// Mount it to open it; onClose fires however it closes. Children that close it
// themselves take `close` (focus goes back to where it was before it opened).
export function Modal({ title, onClose, wide, children }: { title: ReactNode; onClose(): void; wide?: boolean; children: ReactNode | ((close: () => void) => ReactNode) }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current!;
    if (d.open) return;
    if (d.showModal) d.showModal();
    else d.setAttribute('open', ''); // no <dialog> support (jsdom): shown in place
  }, []);
  const shut = () => (ref.current?.close ? ref.current.close() : onClose());
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'wide' : ''}`}
      closedby="any"
      aria-labelledby={titleId}
      onClose={onClose}
      // closedby fallback: a click on the backdrop lands on the dialog itself, outside its box.
      onClick={(e) => {
        if (nativeClosedBy() || e.target !== e.currentTarget) return;
        const r = e.currentTarget.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.currentTarget.close();
      }}
    >
      <header className="modal-head">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="btn small ghost" autoFocus onClick={shut}>Close</button>
      </header>
      <div className="modal-body">{typeof children === 'function' ? children(shut) : children}</div>
    </dialog>
  );
}

// A short hint on a button or link, shown on hover, focus or long press and
// exposed as the control's description. Only for what the user can afford to miss.
// toggle: the button's only job is the hint (a toggletip), so a click shows it too.
export function Tip({ tip, toggle, children }: { tip: string; toggle?: boolean; children: ReactElement<Record<string, unknown>> }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const trigger = toggle
    ? { interestfor: id, popoverTarget: id, popoverTargetAction: 'show', 'aria-expanded': open }
    : { interestfor: id, 'aria-describedby': id };
  return (
    <>
      {cloneElement(children, trigger)}
      <span
        popover="hint"
        id={id}
        role="tooltip"
        className="pop tip"
        hidden={popovers() ? undefined : true}
        // Where "hint" is unknown it means "manual", which a click-opened toggletip would never leave.
        onBeforeToggle={(e) => {
          if (e.newState === 'open' && e.currentTarget.popover !== 'hint') e.currentTarget.popover = 'auto';
        }}
        onToggle={(e) => setOpen(e.newState === 'open')}
      >
        {tip}
      </span>
    </>
  );
}

// Toasts: one region in one manual popover (it stays when you click elsewhere and
// stacks its messages), each message announced to screen readers. Errors stay until
// closed; other messages leave after a few seconds unless focus is inside them.
export type ToastMsg = { id: number; text: string; error?: boolean };

export function Toasts({ list, onClose }: { list: ToastMsg[]; onClose(id: number): void }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !popovers()) return;
    const open = el.matches(':popover-open');
    if (list.length && !open) el.showPopover();
    if (!list.length && open) el.hidePopover();
  }, [list.length]);
  return (
    <section ref={ref} popover="manual" className="toasts" aria-label="Notifications" hidden={popovers() ? undefined : !list.length}>
      {list.map((t) => <Toast key={t.id} t={t} onClose={() => onClose(t.id)} />)}
    </section>
  );
}

function Toast({ t, onClose }: { t: ToastMsg; onClose(): void }) {
  const [focused, setFocused] = useState(false);
  // The app re-renders on every log line: keep the timer from restarting each time.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const doc = document as Document & { ariaNotify?(text: string, o?: { priority?: 'high' | 'normal' }): void };
    if (doc.ariaNotify) doc.ariaNotify(t.text, { priority: t.error ? 'high' : 'normal' });
    else announce(t.text);
  }, [t.text, t.error]);
  useEffect(() => {
    if (t.error || focused) return;
    const timer = setTimeout(() => closeRef.current(), 4000);
    return () => clearTimeout(timer);
  }, [t.error, focused]);
  return (
    <div
      className={`toast ${t.error ? 'error' : ''}`}
      onFocus={() => setFocused(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setFocused(false)}
    >
      <span>{t.text}</span>
      {/* shortcut: closing a focused toast drops focus to the page, move it to the next toast if keyboard users complain. */}
      <button type="button" className="toast-close" aria-label="Close notification" onClick={onClose}><span aria-hidden>✕</span></button>
    </div>
  );
}

// ariaNotify fallback: a live region that exists before anything is said into it.
function announce(text: string) {
  let region = document.getElementById('announcer');
  if (!region) {
    region = Object.assign(document.createElement('div'), { id: 'announcer', className: 'sr-only' });
    region.setAttribute('aria-live', 'polite');
    document.body.append(region);
    // A fresh region misses its first change: say it on the next frame.
    requestAnimationFrame(() => (region!.textContent = text));
    return;
  }
  region.textContent = text;
}

// The mark for settings and for system subjects (jobs, reactions): a drawn gear,
// not the ⚙ character, which some platforms render as a color emoji.
export function Gear() {
  return (
    <svg className="gear" viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path strokeLinejoin="round" d="M14.83 6.47L14.83 9.53L12.97 10.1L13.91 11.75L11.75 13.91L10.1 12.97L9.53 14.83L6.47 14.83L5.9 12.97L4.25 13.91L2.09 11.75L3.03 10.1L1.17 9.53L1.17 6.47L3.03 5.9L2.09 4.25L4.25 2.09L5.9 3.03L6.47 1.17L9.53 1.17L10.1 3.03L11.75 2.09L13.91 4.25L12.97 5.9Z" />
      <circle cx="8" cy="8" r="2.2" />
    </svg>
  );
}
