/**
 * Monaco editor UI for the Faraday extension.
 * Creates the editor in the iframe body and wires save/close to the host API.
 * Supports custom TextMate grammars passed from the host (from all loaded extensions).
 */

import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import type { EditorProps, HostApi } from './types';
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

export async function createEditorMount(hostApi: HostApi, props: EditorProps): Promise<() => void> {
  ensureMonacoReady();
  await activateGrammars(hostApi, props);
  const theme = await hostApi.getTheme();
  const isDark = theme !== 'light' && theme !== 'high-contrast-light';
  const monacoTheme = isDark ? 'faraday-dark' : 'faraday-light';

  const content = await hostApi.readFileText(props.filePath);

  // Build DOM: header + editor area. Fill iframe and avoid overflow/clipping.
  const doc = document;
  doc.documentElement.style.height = '100%';
  doc.documentElement.style.overflow = 'hidden';
  doc.body.innerHTML = '';
  doc.body.style.margin = '0';
  doc.body.style.padding = '0';
  doc.body.style.height = '100%';
  doc.body.style.overflow = 'hidden';
  doc.body.style.display = 'flex';
  doc.body.style.flexDirection = 'column';
  doc.body.className = isDark ? 'faraday-dark' : 'faraday-light';

  const header = document.createElement('div');
  header.style.cssText =
    'display:flex;align-items:center;padding:6px 10px;border-bottom:1px solid var(--border, #333);flex-shrink:0;';
  const title = document.createElement('span');
  title.textContent = props.fileName;
  title.style.flex = '1';
  header.appendChild(title);
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.title = 'Close (Esc)';
  closeBtn.style.cssText = 'background:transparent;border:none;cursor:pointer;font-size:18px;padding:0 8px;';
  closeBtn.onclick = () => hostApi.onClose();
  header.appendChild(closeBtn);

  const editorHost = document.createElement('div');
  editorHost.style.cssText = 'flex:1;min-height:0;width:100%;overflow:hidden;';

  document.body.appendChild(header);
  document.body.appendChild(editorHost);
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
    editor.dispose();
    editorInstance = null;
    if (rootEl?.parentNode) rootEl.parentNode.removeChild(rootEl);
    rootEl = null;
  };
}

export function disposeEditor(): void {
  if (editorInstance) {
    editorInstance.dispose();
    editorInstance = null;
  }
  if (rootEl?.parentNode) rootEl.parentNode.removeChild(rootEl);
  rootEl = null;
}
