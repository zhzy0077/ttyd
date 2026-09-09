import type { ITheme, Terminal } from '@xterm/xterm';
import './settings.scss';

const paletteKeys = [
    'black',
    'red',
    'green',
    'yellow',
    'blue',
    'magenta',
    'cyan',
    'white',
    'brightBlack',
    'brightRed',
    'brightGreen',
    'brightYellow',
    'brightBlue',
    'brightMagenta',
    'brightCyan',
    'brightWhite',
];

function theme(background: string, foreground: string, colors: string[]): ITheme {
    return {
        background,
        foreground,
        cursor: foreground,
        ...Object.fromEntries(paletteKeys.map((key, i) => [key, colors[i]])),
    };
}

const themes: Record<string, ITheme> = {
    dark: theme('#1e1e2e', '#cdd6f4', [
        '#45475a',
        '#f38ba8',
        '#a6e3a1',
        '#f9e2af',
        '#89b4fa',
        '#f5c2e7',
        '#94e2d5',
        '#bac2de',
        '#585b70',
        '#f38ba8',
        '#a6e3a1',
        '#f9e2af',
        '#89b4fa',
        '#f5c2e7',
        '#94e2d5',
        '#a6adc8',
    ]),
    light: theme('#ffffff', '#202020', [
        '#202020',
        '#b91c1c',
        '#167020',
        '#806000',
        '#1d4ed8',
        '#9333a8',
        '#007080',
        '#d0d0d0',
        '#606060',
        '#dc2626',
        '#228030',
        '#907000',
        '#2563eb',
        '#a020a0',
        '#008090',
        '#ffffff',
    ]),
    nord: theme('#2e3440', '#d8dee9', [
        '#3b4252',
        '#bf616a',
        '#a3be8c',
        '#ebcb8b',
        '#81a1c1',
        '#b48ead',
        '#88c0d0',
        '#e5e9f0',
        '#4c566a',
        '#bf616a',
        '#a3be8c',
        '#ebcb8b',
        '#81a1c1',
        '#b48ead',
        '#8fbcbb',
        '#eceff4',
    ]),
    dracula: theme('#282a36', '#f8f8f2', [
        '#21222c',
        '#ff5555',
        '#50fa7b',
        '#f1fa8c',
        '#bd93f9',
        '#ff79c6',
        '#8be9fd',
        '#f8f8f2',
        '#6272a4',
        '#ff6e6e',
        '#69ff94',
        '#ffffa5',
        '#d6acff',
        '#ff92df',
        '#a4ffff',
        '#ffffff',
    ]),
};

interface Settings {
    theme?: string;
    foreground?: string;
    background?: string;
    cursor?: string;
    fontFamily?: string;
    fontSize?: number;
    suppressContextMenu?: boolean;
}

function validate(value: unknown): Settings {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const raw = value as Record<string, unknown>;
    const settings: Settings = {};
    if (typeof raw.theme === 'string' && Object.prototype.hasOwnProperty.call(themes, raw.theme))
        settings.theme = raw.theme;
    for (const key of ['foreground', 'background', 'cursor'] as const) {
        if (typeof raw[key] === 'string' && /^#[0-9a-f]{6}$/i.test(raw[key] as string))
            settings[key] = raw[key] as string;
    }
    if (typeof raw.fontFamily === 'string' && raw.fontFamily.trim() && raw.fontFamily.length <= 300) {
        settings.fontFamily = raw.fontFamily;
    }
    if (typeof raw.fontSize === 'number' && Number.isInteger(raw.fontSize) && raw.fontSize >= 8 && raw.fontSize <= 48) {
        settings.fontSize = raw.fontSize;
    }
    if (typeof raw.suppressContextMenu === 'boolean') settings.suppressContextMenu = raw.suppressContextMenu;
    return settings;
}

export class TerminalSettings {
    private key = `ttyd.settings.v1:${window.location.pathname}`;
    private settings: Settings = {};
    private defaults: { theme: ITheme; fontFamily: string; fontSize: number };
    private root = document.createElement('div');
    private panel: HTMLElement;
    private toggle: HTMLButtonElement;
    private status: HTMLElement;
    private frame = 0;
    private disposed = false;
    private storageAvailable = true;

    constructor(
        private terminal: Terminal,
        private fit: () => void
    ) {
        this.captureDefaults();
        let stored: string | null = null;
        try {
            stored = localStorage.getItem(this.key);
        } catch {
            this.storageAvailable = false;
        }
        try {
            this.settings = validate(JSON.parse(stored || '{}'));
        } catch {
            // Invalid or unavailable storage must not prevent terminal startup.
        }
        this.root.className = 'ttyd-settings';
        this.root.innerHTML = `
            <button type="button" class="settings-toggle" aria-label="Terminal settings" aria-expanded="false" aria-controls="ttyd-settings-panel">⚙</button>
            <section id="ttyd-settings-panel" role="dialog" aria-label="Terminal settings" hidden>
                <header><strong>Terminal settings</strong><button type="button" data-close aria-label="Close settings">×</button></header>
                <label>Theme<select name="theme" aria-label="Theme"><option value="">Server default</option value="dark">Dark</option><option value="light">Light</option><option value="nord">Nord</option><option value="dracula">Dracula</option></select></label>
                <div class="settings-colors">
                    <label>Text<input name="foreground" type="color"></label>
                    <label>Background<input name="background" type="color"></label>
                    <label>Cursor<input name="cursor" type="color"></label>
                </div>
                <label>Font family<input name="fontFamily" list="ttyd-fonts" maxlength="300" placeholder="Server default"></label>
                <datalist id="ttyd-fonts"><option value="monospace"></option><option value="JetBrains Mono, monospace"></option><option value="JetBrainsMono Nerd Font, monospace"></option><option value="Fira Code, monospace"></option><option value="Cascadia Code, monospace"></option><option value="DejaVu Sans Mono, monospace"></option><option value="Menlo, monospace"></option></datalist>
                <small>Use a font installed on this device, or enter another family name.</small>
                <label>Font size (px)<input name="fontSize" type="number" min="8" max="48" step="1"></label>
                <label class="settings-checkbox"><input name="suppressContextMenu" type="checkbox">Suppress terminal right-click menu</label>
                <small>Does not enable paste. Firefox can still show its menu with Shift + right-click.</small>
                <button type="button" data-upload>Upload file</button>
                <input type="file" data-upload-input hidden multiple>
                <button type="button" data-reset>Reset to server defaults</button>
                <small role="status" aria-live="polite"></small>
            </section>`;
        this.panel = this.root.querySelector('section') as HTMLElement;
        this.toggle = this.root.querySelector('.settings-toggle') as HTMLButtonElement;
        this.status = this.root.querySelector('[role="status"]') as HTMLElement;
        this.toggle.addEventListener('click', () => this.setOpen(this.panel.hidden));
        this.root.querySelector('[data-close]')?.addEventListener('click', () => this.setOpen(false));
        this.root.querySelector('[data-reset]')?.addEventListener('click', () => {
            this.settings = {};
            this.persist(true);
            this.apply();
        });
        const fileInput = this.root.querySelector('[data-upload-input]') as HTMLInputElement;
        this.root.querySelector('[data-upload]')?.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', event => {
            event.stopPropagation();
            const files = Array.from(fileInput.files || []);
            fileInput.value = '';
            if (files.length) void this.upload(files);
        });
        this.panel.addEventListener('change', this.onChange);
        this.panel.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                this.setOpen(false);
            }
        });
        document.addEventListener('pointerdown', this.onOutside);
        terminal.element?.addEventListener('contextmenu', this.onContextMenu, true);
        document.fonts?.addEventListener('loadingdone', this.scheduleFit);
        document.body.appendChild(this.root);
        this.apply();
    }

    private control(name: string): HTMLInputElement | HTMLSelectElement {
        return this.root.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLSelectElement;
    }

    private setOpen(open: boolean) {
        this.panel.hidden = !open;
        this.toggle.setAttribute('aria-expanded', String(open));
        if (open) this.control('theme').focus();
        else this.toggle.focus();
    }

    private onOutside = (event: Event) => {
        if (!this.root.contains(event.target as Node)) {
            this.panel.hidden = true;
            this.toggle.setAttribute('aria-expanded', 'false');
        }
    };

    private onContextMenu = (event: Event) => {
        if (this.settings.suppressContextMenu) event.preventDefault();
    };

    private onChange = (event: Event) => {
        const input = event.target as HTMLInputElement;
        const { name, value } = input;
        if (!name) return;
        if (name === 'fontSize' && !input.checkValidity()) {
            input.reportValidity();
            return;
        }
        if (name === 'theme') {
            delete this.settings.foreground;
            delete this.settings.background;
            delete this.settings.cursor;
        }
        this.settings = validate({
            ...this.settings,
            [name]: name === 'suppressContextMenu' ? input.checked : name === 'fontSize' ? Number(value) : value,
        });
        this.persist();
        this.apply();
    };

    private async upload(files: File[]) {
        const prefix = window.location.pathname.replace(/[/]+$/, '');
        const paths: string[] = [];
        this.status.textContent = 'Uploading…';
        try {
            for (const file of files) {
                const res = await fetch(`${prefix}/upload?name=${encodeURIComponent(file.name)}`, {
                    method: 'POST',
                    body: file,
                    credentials: 'same-origin',
                });
                if (!res.ok) throw new Error((await res.text()) || res.statusText);
                const body = (await res.json()) as { path?: string };
                if (!body.path) throw new Error('Upload did not return a path');
                paths.push(body.path);
            }
            const text = paths.join('\n');
            try {
                await navigator.clipboard.writeText(text);
                this.status.textContent = `Copied ${text}`;
            } catch {
                this.status.textContent = text;
            }
        } catch (err) {
            this.status.textContent = err instanceof Error ? err.message : 'Upload failed';
        }
    }

    private persist(reset = false) {
        try {
            if (reset) localStorage.removeItem(this.key);
            else localStorage.setItem(this.key, JSON.stringify(this.settings));
            this.storageAvailable = true;
        } catch {
            this.storageAvailable = false;
        }
    }

    private scheduleFit = () => {
        if (this.disposed) return;
        cancelAnimationFrame(this.frame);
        this.frame = requestAnimationFrame(() => {
            if (!this.disposed) this.fit();
        });
    };

    // Server preferences can arrive after startup and again on reconnect.
    // Restore the baseline first so a local theme cannot leak into that baseline.
    restoreDefaults() {
        this.terminal.options.theme = { ...this.defaults.theme };
        this.terminal.options.fontFamily = this.defaults.fontFamily;
        this.terminal.options.fontSize = this.defaults.fontSize;
    }

    captureDefaults() {
        const { theme, fontFamily, fontSize } = this.terminal.options;
        this.defaults = { theme: { ...theme }, fontFamily: fontFamily || 'monospace', fontSize: fontSize || 15 };
    }

    apply() {
        const settings = this.settings;
        const colors = { ...(settings.theme ? themes[settings.theme] : this.defaults.theme) };
        for (const key of ['foreground', 'background', 'cursor'] as const) {
            if (settings[key]) colors[key] = settings[key];
        }
        this.terminal.options.theme = colors;
        this.terminal.options.fontFamily = settings.fontFamily || this.defaults.fontFamily;
        this.terminal.options.fontSize = settings.fontSize || this.defaults.fontSize;
        this.control('theme').value = settings.theme || '';
        this.control('fontFamily').value = settings.fontFamily || '';
        this.control('fontSize').value = String(this.terminal.options.fontSize);
        (this.control('suppressContextMenu') as HTMLInputElement).checked = !!settings.suppressContextMenu;
        for (const key of ['foreground', 'background', 'cursor'] as const) {
            // Convert named server colors (e.g. "white") for the HTML color input.
            const canvas = document.createElement('canvas').getContext('2d');
            if (canvas) {
                canvas.fillStyle = key === 'background' ? '#000000' : '#ffffff';
                if (colors[key]) canvas.fillStyle = colors[key] as string;
                this.control(key).value = canvas.fillStyle as string;
            }
        }
        this.status.textContent = this.storageAvailable
            ? 'Saved choices apply to this terminal URL in this browser.'
            : 'Browser storage is unavailable. Changes apply until this page is closed.';
        this.scheduleFit();
        if (document.fonts) {
            void document.fonts
                .load(`${this.terminal.options.fontSize}px ${this.terminal.options.fontFamily}`)
                .then(this.scheduleFit, this.scheduleFit);
        }
    }

    dispose() {
        this.disposed = true;
        cancelAnimationFrame(this.frame);
        document.removeEventListener('pointerdown', this.onOutside);
        document.fonts?.removeEventListener('loadingdone', this.scheduleFit);
        this.terminal.element?.removeEventListener('contextmenu', this.onContextMenu, true);
        this.root.remove();
    }
}
