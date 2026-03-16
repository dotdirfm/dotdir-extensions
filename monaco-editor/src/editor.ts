/**
 * Monaco editor UI for the Faraday extension.
 * Creates the editor in the iframe body and wires save/close to the host API.
 * Supports custom TextMate grammars passed from the host (from all loaded extensions).
 */

import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import type { ColorThemeData, EditorProps, HostApi } from './types';
import { Registry as TMRegistry, INITIAL } from 'vscode-textmate';
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma';
import type { IGrammar, StateStack } from 'vscode-textmate';

// Inline worker so the extension works when loaded as a single blob (no separate worker URL).
// @ts-expect-error - Vite ?worker&inline
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker&inline';
// Inject at runtime — host only loads the JS entry, so CSS must be in the bundle and applied in the iframe.
// @ts-expect-error - Vite ?raw
import monacoCss from 'monaco-editor/min/vs/editor/editor.main.css?raw';

let editorInstance: monaco.editor.IStandaloneCodeEditor | null = null;
let rootEl: HTMLDivElement | null = null;
let monacoReady = false;

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

// ── Custom grammars (from host) ────────────────────────────────────────

/** Register languages and activate TextMate tokenization when host provides grammars. */
async function activateGrammars(hostApi: HostApi, props: EditorProps): Promise<void> {
  const { languages = [], grammars = [] } = props;
  if (languages.length === 0 && grammars.length === 0) return;
  if (!hostApi.getOnigurumaWasm) return;

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

  const wasm = await hostApi.getOnigurumaWasm();
  await loadWASM(wasm);

  const grammarContents = new Map<string, object>();
  const languageToScope = new Map<string, string>();
  for (const { contribution, content } of grammars) {
    grammarContents.set(contribution.scopeName, content);
    if (contribution.language) {
      languageToScope.set(contribution.language, contribution.scopeName);
    }
  }

  const tmRegistry = new TMRegistry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns: string[]) => createOnigScanner(patterns),
      createOnigString: (s: string) => createOnigString(s),
    }),
    loadGrammar: async (scopeName: string) => {
      const content = grammarContents.get(scopeName);
      return content ? (content as never) : null;
    },
  });

  for (const [languageId, scopeName] of languageToScope) {
    let grammar: IGrammar | null = null;
    try {
      grammar = await tmRegistry.loadGrammar(scopeName);
    } catch {
      continue;
    }
    if (!grammar) continue;

    monaco.languages.setTokensProvider(languageId, {
      getInitialState: () => new TMState(INITIAL),
      tokenize: (line: string, state: monaco.languages.IState) => {
        const tmState = state as TMState;
        const result = grammar!.tokenizeLine(line, tmState.ruleStack);
        const tokens: monaco.languages.IToken[] = result.tokens.map((t) => ({
          startIndex: t.startIndex,
          scopes: t.scopes[t.scopes.length - 1] ?? 'source',
        }));
        return {
          tokens,
          endState: new TMState(result.ruleStack),
        };
      },
    });
  }
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
 * Normalize a CSS color value to 6-digit hex (without '#') for Monaco token rules.
 * Handles: #RGB, #RRGGBB, #RRGGBBAA, named colors (white, red, etc.).
 * Returns null if the value cannot be normalized.
 */
function normalizeTokenColor(value: string): string | null {
  if (!value) return null;
  const v = value.trim();

  if (v.startsWith('#')) {
    const hex = v.slice(1);
    if (hex.length === 6) return hex;
    if (hex.length === 8) return hex.slice(0, 6); // strip alpha
    if (hex.length === 3) return hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    if (hex.length === 4) return hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]; // strip alpha
    return null;
  }

  // Named color — use a canvas to resolve it
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = v;
    const resolved = ctx.fillStyle; // returns '#rrggbb' or 'rgba(...)'
    if (resolved.startsWith('#')) return resolved.slice(1);
    return null;
  } catch {
    return null;
  }
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
      colors[key] = value;
    }
  }

  if (Array.isArray(themeData.tokenColors)) {
    for (const entry of themeData.tokenColors) {
      if (!entry || typeof entry !== 'object') continue;
      const tc = entry as { scope?: string | string[]; settings?: { foreground?: string; fontStyle?: string; background?: string } };
      if (!tc.settings) continue;
      const scopes = Array.isArray(tc.scope) ? tc.scope : (tc.scope ? [tc.scope] : ['']);
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

function applyColorThemeToEditor(themeData: ColorThemeData): void {
  const { base, rules, colors } = buildMonacoTheme(themeData);
  monaco.editor.defineTheme('faraday-custom', { base, inherit: true, rules, colors });
  monaco.editor.setTheme('faraday-custom');
  if (rootEl?.parentElement) {
    rootEl.parentElement.className = themeData.kind === 'light' ? 'faraday-light' : 'faraday-dark';
  }
}

export async function createEditorMount(root: HTMLElement, hostApi: HostApi, props: EditorProps): Promise<() => void> {
  ensureMonacoReady();
  await activateGrammars(hostApi, props);

  // Determine initial theme
  const colorTheme = hostApi.getColorTheme?.() ?? null;
  let monacoTheme: string;
  let isDark: boolean;

  if (colorTheme?.colors) {
    const { base, rules, colors } = buildMonacoTheme(colorTheme);
    monaco.editor.defineTheme('faraday-custom', { base, inherit: true, rules, colors });
    monacoTheme = 'faraday-custom';
    isDark = colorTheme.kind !== 'light';
  } else {
    const theme = await hostApi.getTheme();
    isDark = theme !== 'light' && theme !== 'high-contrast-light';
    monacoTheme = isDark ? 'faraday-dark' : 'faraday-light';
  }

  const content = await hostApi.readFileText(props.filePath);

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
  themeUnsubscribe = hostApi.onThemeChange?.((newTheme) => {
    if (newTheme.colors) {
      applyColorThemeToEditor(newTheme);
    } else {
      // Reverted to built-in theme
      const fallback = newTheme.kind === 'light' ? 'faraday-light' : 'faraday-dark';
      monaco.editor.setTheme(fallback);
      root.className = newTheme.kind === 'light' ? 'faraday-light' : 'faraday-dark';
    }
  }) ?? null;

  let dirty = false;
  const save = async (): Promise<boolean> => {
    try {
      await hostApi.writeFile(props.filePath, editor.getValue());
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
        hostApi.onClose();
        return;
      }
      if (window.confirm('Save changes before closing?')) {
        void save().then((ok) => {
          if (ok) hostApi.onClose();
        });
      } else {
        hostApi.onClose();
      }
    },
  });

  editor.focus();

  return () => {
    if (themeUnsubscribe) { themeUnsubscribe(); themeUnsubscribe = null; }
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
