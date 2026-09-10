type AltKeyEvent = {
    key: string;
    preventDefault(): void;
    getModifierState?(key: string): boolean;
};

type TerminalRoot = Pick<HTMLElement, 'contains'> | undefined | null;

/** The Alt modifier itself, not AltGraph/AltGr used for third-level characters. */
export function isBareAltKey(event: Pick<AltKeyEvent, 'key' | 'getModifierState'>): boolean {
    return event.key === 'Alt' && event.getModifierState?.('AltGraph') !== true;
}

/**
 * True when the focused node is the xterm helper textarea (or inside it).
 * Settings controls live outside the terminal element and must keep Alt.
 */
export function isTerminalFocused(terminalElement: TerminalRoot, activeElement: Node | null): boolean {
    return !!terminalElement && !!activeElement && terminalElement.contains(activeElement);
}

/** Suppress the browser menu-bar / access-key default for a focused terminal. */
export function captureBareAltKey(event: AltKeyEvent, terminalElement: TerminalRoot): boolean {
    const active = typeof document === 'undefined' ? null : document.activeElement;
    if (!isBareAltKey(event) || !isTerminalFocused(terminalElement, active)) return false;
    event.preventDefault();
    return true;
}
