/**
 * Monaco editor UI for the Faraday extension.
 * Creates the editor in the iframe body and wires save/close to the host API.
 * Supports custom TextMate grammars passed from the host (from all loaded extensions).
 */

import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import type { ColorThemeData, EditorProps, HostApi } from './types';
import { Registry as TMRegistry, INITIAL } from 'vscode-textmate';
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma';
import type { StateStack } from 'vscode-textmate';
// @ts-expect-error - Vite ?url for asset URL in extension iframe
import onigWasmUrl from 'vscode-oniguruma/release/onig.wasm?url';

// Inline worker so the extension works when loaded as a single blob (no separate worker URL).
// @ts-expect-error - Vite ?worker&inline
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker&inline';
// Inject at runtime — host only loads the JS entry, so CSS must be in the bundle and applied in the iframe.
// @ts-expect-error - Vite ?raw
import monacoCss from 'monaco-editor/min/vs/editor/editor.main.css?raw';

let editorInstance: monaco.editor.IStandaloneCodeEditor | null = null;
let rootEl: HTMLDivElement | null = null;
let monacoReady = false;

// Cache Oniguruma + TextMate grammar JSON so language switches don't re-fetch everything.
let onigWasmLoadPromise: Promise<void> | null = null;
const grammarJsonCache = new Map<string, object | null>(); // key: scopeName
const activatedTokenProviders = new Set<string>(); // key: `${langIdLower}\0${scopeName}`

// ── TextMate state wrapper for Monaco ─────────────────────────────────

class TMState implements monaco.languages.IState {
  constructor(private _ruleStack: StateStack) {}
  get ruleStack(): StateStack {
    return this._ruleStack;
  }
  clone(): TMState {
    return new TMState(this._ruleStack);
  }
  equals(other: monaco.languages.IState): boolean {
    return other instanceof TMState && other._ruleStack === this._ruleStack;
  }
}

const COMMON_SCOPE_SUFFIXES = new Set([
  'js', 'jsx', 'ts', 'tsx', 'json', 'yaml', 'yml', 'md', 'rs', 'py', 'go', 'java', 'c', 'cpp', 'h', 'hpp',
  'css', 'scss', 'less', 'html', 'xml', 'toml', 'ini', 'sh', 'bash', 'zsh',
]);

/**
 * VS Code themes sometimes specify token scopes without language suffixes (e.g. `entity.name.function`)
 * while TextMate grammars may append `.ts`, `.js`, etc (e.g. `entity.name.function.ts`).
 *
 * Monaco matches token theme rules by prefix segments (`.`), so we normalize both sides by stripping
 * common suffixes when present.
 */
function stripLangSuffix(scope: string): string {
  const m = scope.match(/^(.*)\.([a-zA-Z0-9_-]+)$/);
  if (!m) return scope;
  const suffix = m[2]!.toLowerCase();
  if (!COMMON_SCOPE_SUFFIXES.has(suffix)) return scope;
  return m[1]!;
}

// ── Custom grammars (from host) ────────────────────────────────────────

async function ensureOnigurumaWasmLoaded(hostApi: HostApi): Promise<void> {
  if (onigWasmLoadPromise) return onigWasmLoadPromise;
  onigWasmLoadPromise = (async () => {
    // Prefer direct VFS fetch for `onig.wasm` (works when the whole extension bundle is served from VFS).
    // Fall back to host-provided WASM if direct fetch fails.
    let wasm: ArrayBuffer | null = null;
    try {
      const r = await fetch(onigWasmUrl);
      wasm = await r.arrayBuffer();
    } catch {
      wasm = null;
    }
    if (!wasm && hostApi.getOnigurumaWasm) {
      wasm = await hostApi.getOnigurumaWasm();
    }
    if (!wasm) return;
    await loadWASM(wasm);
  })();
  return onigWasmLoadPromise;
}

/**
 * Ensure TextMate tokenization is registered for a specific language id.
 * Used for initial mount and for language switching without reloading the iframe.
 */
export async function ensureTextMateLanguage(hostApi: HostApi, props: EditorProps, targetLangId: string): Promise<void> {
  const { languages = [], grammars = [] } = props;
  if (!targetLangId) return;
  if (languages.length === 0 && grammars.length === 0) return;

  for (const lang of languages) {
    const safeAliases = lang.aliases?.filter((a): a is string => typeof a === 'string' && a.length > 0);
    monaco.languages.register({
      id: lang.id,
      extensions: lang.extensions,
      aliases: safeAliases?.length ? safeAliases : undefined,
      filenames: lang.filenames,
    });
  }

  if (grammars.length === 0) return;
  await ensureOnigurumaWasmLoaded(hostApi);

  // Map `languageId -> scopeName` (case-insensitive match).
  const languageToScope = new Map<string, string>();
  const scopeToPath = new Map<string, string>();
  for (const g of grammars) {
    const { contribution, path } = g;
    const scopeName = contribution.scopeName;
    if (path) scopeToPath.set(scopeName, path);
    if (contribution.language) {
      languageToScope.set(contribution.language.toLowerCase(), scopeName);
    }
  }

  const targetLanguageId = targetLangId.toLowerCase();
  const targetScopeName = languageToScope.get(targetLanguageId);
  if (!targetScopeName) return;
  const activatedKey = `${targetLanguageId}\0${targetScopeName}`;
  if (activatedTokenProviders.has(activatedKey)) return;

  const tmRegistry = new TMRegistry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns: string[]) => createOnigScanner(patterns),
      createOnigString: (s: string) => createOnigString(s),
    }),
    loadGrammar: async (scopeName: string) => {
      const cached = grammarJsonCache.get(scopeName);
      if (cached !== undefined) return cached ? (cached as never) : null;

      const grammarPath = scopeToPath.get(scopeName);
      if (!grammarPath) {
        grammarJsonCache.set(scopeName, null);
        return null;
      }

      try {
        const jsonText = await hostApi.readFileText(grammarPath);
        const parsed = JSON.parse(jsonText) as object;
        grammarJsonCache.set(scopeName, parsed);
        return parsed as never;
      } catch {
        grammarJsonCache.set(scopeName, null);
        return null;
      }
    },
  });

  // Register TextMate tokens only for the current editor language.
  const grammar = await tmRegistry.loadGrammar(targetScopeName).catch(() => null);
  if (!grammar) return;
  monaco.languages.setTokensProvider(targetLangId, {
    getInitialState: () => new TMState(INITIAL),
    tokenize: (line: string, state: monaco.languages.IState) => {
      const tmState = state as TMState;
      const result = grammar!.tokenizeLine(line, tmState.ruleStack);
      const tokens: monaco.languages.IToken[] = result.tokens.map((t) => ({
        startIndex: t.startIndex,
        scopes: stripLangSuffix(t.scopes[t.scopes.length - 1] ?? 'source'),
      }));
      return {
        tokens,
        endState: new TMState(result.ruleStack),
      };
    },
  });

  activatedTokenProviders.add(activatedKey);
}

function ensureMonacoReady(): void {
  if (monacoReady) return;
  // Inject Monaco styles so line numbers, gutter, scrollbars and tokens render correctly.
  if (typeof document !== 'undefined' && document.head && monacoCss) {
    const style = document.createElement('style');
    style.setAttribute('data-monaco', 'true');
    style.textContent = typeof monacoCss === 'string' ? monacoCss : '';
    document.head.appendChild(style);
  }
  const g = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : self);
  (g as unknown as { MonacoEnvironment?: { getWorker: () => Worker } }).MonacoEnvironment = {
    getWorker: () => new (EditorWorker as new () => Worker)(),
  };
  const commonRules: monaco.editor.ITokenThemeRule[] = [
    { token: 'comment', foreground: '6A9955', fontStyle: 'italic' },
    { token: 'string', foreground: 'CE9178' },
    { token: 'keyword', foreground: '569CD6' },
    { token: 'entity.name.type', foreground: '4EC9B0' },
    { token: 'entity.name.function', foreground: 'DCDCAA' },
    { token: 'variable', foreground: '9CDCFE' },
  ];
  monaco.editor.defineTheme('faraday-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: commonRules,
    colors: { 'editor.background': '#1e1e1e', 'editor.foreground': '#d4d4d4' },
  });
  monaco.editor.defineTheme('faraday-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '008000', fontStyle: 'italic' },
      { token: 'string', foreground: 'A31515' },
      { token: 'keyword', foreground: '0000FF' },
      { token: 'entity.name.type', foreground: '267F99' },
      { token: 'entity.name.function', foreground: '795E26' },
      { token: 'variable', foreground: '001080' },
    ],
    colors: {},
  });
  monacoReady = true;
}

/**
 * Normalize a CSS color to #RRGGBB or #RRGGBBAA for Monaco's colors map.
 * Handles: #RGB, #RGBA, #RRGGBB, #RRGGBBAA, named colors.
 * Returns null if the value cannot be normalized.
 */
function normalizeColor(value: unknown): string | null {
  if (!value || typeof value !== 'string') return null;
  const v = value.trim();

  if (v.startsWith('#')) {
    const hex = v.slice(1);
    if (hex.length === 6 || hex.length === 8) return v; // already valid
    if (hex.length === 3) return '#' + hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    if (hex.length === 4) return '#' + hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
    return null;
  }

  // Named color — use a canvas to resolve it
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = v;
    const resolved = ctx.fillStyle; // returns '#rrggbb'
    if (resolved.startsWith('#')) return resolved;
    return null;
  } catch {
    return null;
  }
}

/**
 * Normalize a CSS color to 6-digit hex WITHOUT '#' prefix for Monaco token rules.
 */
function normalizeTokenColor(value: string): string | null {
  const c = normalizeColor(value);
  if (!c) return null;
  const hex = c.slice(1); // strip '#'
  // Token rules only accept 6-digit hex, strip alpha if present
  if (hex.length === 8) return hex.slice(0, 6);
  return hex;
}

/** Convert VS Code tokenColors to Monaco ITokenThemeRule[], and return editor colors. */
function buildMonacoTheme(
  themeData: ColorThemeData,
): { base: 'vs' | 'vs-dark'; rules: monaco.editor.ITokenThemeRule[]; colors: Record<string, string> } {
  const base: 'vs' | 'vs-dark' = themeData.kind === 'light' ? 'vs' : 'vs-dark';
  const rules: monaco.editor.ITokenThemeRule[] = [];
  const colors: Record<string, string> = {};

  if (themeData.colors) {
    for (const [key, value] of Object.entries(themeData.colors)) {
      const normalized = normalizeColor(value);
      if (normalized) colors[key] = normalized;
    }
  }

  if (Array.isArray(themeData.tokenColors)) {
    for (const entry of themeData.tokenColors) {
      if (!entry || typeof entry !== 'object') continue;
      const tc = entry as { scope?: string | string[]; settings?: { foreground?: string; fontStyle?: string; background?: string } };
      if (!tc.settings) continue;
      const rawScopes = Array.isArray(tc.scope) ? tc.scope : (tc.scope ? [tc.scope] : ['']);
      const scopes: string[] = [];
      for (const s of rawScopes) {
        if (!s) continue;
        // VS Code allows comma-separated scopes in a single string.
        for (const part of String(s).split(',')) {
          const trimmed = part.trim();
          if (!trimmed) continue;
          // Monaco doesn't support complex selector syntax; take the first token segment.
          // (e.g. "meta.function-call variable.function" → "meta.function-call")
          const simple = trimmed.split(/\s+/)[0]!;
          if (simple.startsWith('-')) continue;
          scopes.push(simple);
          const stripped = stripLangSuffix(simple);
          if (stripped && stripped !== simple) scopes.push(stripped);
        }
      }
      if (scopes.length === 0) scopes.push('');
      for (const scope of scopes) {
        const rule: monaco.editor.ITokenThemeRule = { token: scope };
        if (tc.settings.foreground) {
          const fg = normalizeTokenColor(tc.settings.foreground);
          if (fg) rule.foreground = fg;
        }
        if (tc.settings.fontStyle) rule.fontStyle = tc.settings.fontStyle;
        if (tc.settings.background) {
          const bg = normalizeTokenColor(tc.settings.background);
          if (bg) rule.background = bg;
        }
        rules.push(rule);
      }
    }
  }

  return { base, rules, colors };
}

let themeUnsubscribe: (() => void) | null = null;
let cssVarThemeObserver: MutationObserver | null = null;

function applyColorThemeToEditor(themeData: ColorThemeData): void {
  const { base, rules, colors } = buildMonacoTheme(themeData);
  monaco.editor.defineTheme('faraday-custom', { base, inherit: true, rules, colors });
  monaco.editor.setTheme('faraday-custom');
  if (rootEl?.parentElement) {
    rootEl.parentElement.className = themeData.kind === 'light' ? 'faraday-light' : 'faraday-dark';
  }
}

function applyCssVarThemeToEditor(isDark: boolean): void {
  const cs = getComputedStyle(document.documentElement);
  const bg = normalizeColor(cs.getPropertyValue('--bg')) ?? (isDark ? '#1e1e1e' : '#ffffff');
  const fg = normalizeColor(cs.getPropertyValue('--fg')) ?? (isDark ? '#d4d4d4' : '#1e1e1e');
  monaco.editor.defineTheme('faraday-css', {
    base: isDark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': bg,
      'editor.foreground': fg,
    },
  });
  monaco.editor.setTheme('faraday-css');
}

export async function createEditorMount(root: HTMLElement, hostApi: HostApi, props: EditorProps): Promise<() => void> {
  const api = (globalThis as unknown as { frdy?: HostApi }).frdy ?? hostApi;
  ensureMonacoReady();
  await ensureTextMateLanguage(api, props, props.langId);

  // Determine initial theme
  const colorTheme = api.getColorTheme?.() ?? null;
  let monacoTheme: string;
  let isDark: boolean;
  let usingVsCodeTheme = false;

  if (colorTheme && (colorTheme.colors || (Array.isArray(colorTheme.tokenColors) && colorTheme.tokenColors.length > 0))) {
    const { base, rules, colors } = buildMonacoTheme(colorTheme);
    monaco.editor.defineTheme('faraday-custom', { base, inherit: true, rules, colors });
    monacoTheme = 'faraday-custom';
    isDark = colorTheme.kind !== 'light';
    usingVsCodeTheme = true;
  } else {
    const theme = await api.getTheme();
    isDark = theme !== 'light' && theme !== 'high-contrast-light';
    // Use Faraday CSS variables (pushed into iframe by host) for Monaco background/foreground.
    applyCssVarThemeToEditor(isDark);
    monacoTheme = 'faraday-css';
    usingVsCodeTheme = false;
  }

  const content = await api.readFileText(props.filePath);

  root.innerHTML = '';
  root.style.margin = '0';
  root.style.padding = '0';
  root.style.height = '100%';
  root.style.overflow = 'hidden';
  root.style.display = 'flex';
  root.style.flexDirection = 'column';
  root.className = isDark ? 'faraday-dark' : 'faraday-light';

  const editorHost = document.createElement('div');
  editorHost.style.cssText = 'flex:1;min-height:0;width:100%;overflow:hidden;';

  root.appendChild(editorHost);
  rootEl = editorHost;

  const editor = monaco.editor.create(editorHost, {
    value: content,
    language: props.langId || 'plaintext',
    theme: monacoTheme,
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    fontFamily: 'monospace',
    lineNumbers: 'on',
    scrollBeyondLastLine: false,
    wordWrap: 'off',
    tabSize: 4,
    insertSpaces: true,
  });
  editorInstance = editor;

  // Subscribe to live theme changes
  if (themeUnsubscribe) themeUnsubscribe();
  if (cssVarThemeObserver) { cssVarThemeObserver.disconnect(); cssVarThemeObserver = null; }
  themeUnsubscribe = api.onThemeChange?.((newTheme) => {
    if (newTheme.colors || (Array.isArray(newTheme.tokenColors) && newTheme.tokenColors.length > 0)) {
      usingVsCodeTheme = true;
      applyColorThemeToEditor(newTheme);
    } else {
      // Faraday theme (CSS vars)
      usingVsCodeTheme = false;
      const nextIsDark = newTheme.kind !== 'light';
      isDark = nextIsDark;
      applyCssVarThemeToEditor(nextIsDark);
      root.className = newTheme.kind === 'light' ? 'faraday-light' : 'faraday-dark';
    }
  }) ?? null;

  // Also track direct CSS variable pushes (host → iframe) which don't go through onThemeChange.
  // Host updates `documentElement.style` when Faraday theme changes.
  cssVarThemeObserver = new MutationObserver(() => {
    if (usingVsCodeTheme) return;
    applyCssVarThemeToEditor(isDark);
  });
  cssVarThemeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });

  let dirty = false;
  const save = async (): Promise<boolean> => {
    try {
      await api.writeFile(props.filePath, editor.getValue());
      dirty = false;
      return true;
    } catch {
      return false;
    }
  };

  editor.onDidChangeModelContent(() => {
    dirty = true;
  });

  editor.addAction({
    id: 'faraday.save',
    label: 'Save File',
    keybindings: [monaco.KeyCode.F2],
    run: () => {
      void save();
    },
  });
  editor.addAction({
    id: 'faraday.close',
    label: 'Close Editor',
    keybindings: [monaco.KeyCode.Escape],
    run: () => {
      if (!dirty) {
        api.onClose();
        return;
      }
      if (window.confirm('Save changes before closing?')) {
        void save().then((ok) => {
          if (ok) api.onClose();
        });
      } else {
        api.onClose();
      }
    },
  });

  editor.focus();

  return () => {
    if (themeUnsubscribe) { themeUnsubscribe(); themeUnsubscribe = null; }
    if (cssVarThemeObserver) { cssVarThemeObserver.disconnect(); cssVarThemeObserver = null; }
    editor.dispose();
    editorInstance = null;
    if (rootEl?.parentNode) rootEl.parentNode.removeChild(rootEl);
    rootEl = null;
  };
}

export function setEditorLanguage(langId: string): void {
  if (editorInstance) {
    const model = editorInstance.getModel();
    if (model) {
      monaco.editor.setModelLanguage(model, langId);
    }
  }
}

export function disposeEditor(): void {
  if (themeUnsubscribe) { themeUnsubscribe(); themeUnsubscribe = null; }
  if (editorInstance) {
    editorInstance.dispose();
    editorInstance = null;
  }
  if (rootEl?.parentNode) rootEl.parentNode.removeChild(rootEl);
  rootEl = null;
}
