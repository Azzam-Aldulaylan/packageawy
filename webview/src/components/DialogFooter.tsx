import { Children, createContext, useContext, useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { filledButtonForeground } from '../dialogButtonContrast.js';

type FooterSlots = {
  actions: HTMLDivElement | null;
  setActions(node: HTMLDivElement | null): void;
};
const FooterContext = createContext<FooterSlots | null>(null);

/** Keeps panel-owned state and handlers while placing their controls outside the scroll region. */
export function DialogFooterScope({ children }: { children: ReactNode }): ReactElement {
  const [actions, setActions] = useState<HTMLDivElement | null>(null);
  return <FooterContext.Provider value={{ actions, setActions }}>{children}</FooterContext.Provider>;
}

/** A single, non-scrolling footer. Secondary actions precede the final primary action. */
export function DialogFooter({ navigation, secondary, primary, children }: {
  navigation?: ReactNode;
  secondary?: ReactNode;
  primary?: ReactNode;
  children?: ReactNode;
}): ReactElement {
  const slots = useContext(FooterContext);
  const footerRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const footer = footerRef.current;
    if (footer === null) return;
    const document = footer.ownerDocument;
    const update = (): void => {
      const surfaces: string[] = [];
      for (let element: HTMLElement | null = footer; element !== null; element = element.parentElement) {
        surfaces.push(document.defaultView?.getComputedStyle(element).backgroundColor ?? '');
      }
      for (const button of footer.querySelectorAll<HTMLElement>('.button--upgrade, .button--removal')) {
        // Resolve the accent itself, even while hover or the previous theme uses the host fill.
        button.removeAttribute('data-dialog-accent-fallback');
        const previousFill = button.style.getPropertyValue('background-color');
        const previousPriority = button.style.getPropertyPriority('background-color');
        button.style.setProperty('background-color', 'var(--dialog-accent-background)', 'important');
        const accent = document.defaultView?.getComputedStyle(button).backgroundColor ?? '';
        if (previousFill === '') button.style.removeProperty('background-color');
        else button.style.setProperty('background-color', previousFill, previousPriority);
        const foreground = filledButtonForeground(accent, surfaces);
        if (foreground === null) {
          button.style.removeProperty('--dialog-accent-foreground');
          button.setAttribute('data-dialog-accent-fallback', '');
        } else {
          button.style.setProperty('--dialog-accent-foreground', foreground);
        }
      }
    };
    update();
    const Observer = document.defaultView?.MutationObserver;
    if (Observer === undefined) return;
    const observer = new Observer(update);
    // Both hosts update the body class and theme styles without remounting dialogs.
    observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    observer.observe(footer, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return <footer ref={footerRef} className="modal__footer dialog-footer">
    {navigation === undefined ? null : <div className="dialog-footer__navigation">{navigation}</div>}
    <div className="dialog-footer__actions">
      {secondary}
      <div className="dialog-footer__panel-actions" ref={slots?.setActions} />
      {children}
      {primary}
    </div>
  </footer>;
}

/** Portals retain React context, focus, consent state and the original action handlers. */
export function DialogFooterActions({ children }: { children: ReactNode }): ReactElement {
  const slots = useContext(FooterContext);
  const actions = Children.toArray(children);
  // Normalize the child list so adding a primary action preserves the focused secondary button.
  // Panels may also be rendered on their own, without modal chrome.
  if (slots === null) return <div className="dialog-footer__standalone-actions">{actions}</div>;
  return <>
    {slots.actions === null ? null : createPortal(actions, slots.actions)}
  </>;
}
