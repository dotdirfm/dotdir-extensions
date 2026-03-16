/**
 * Minimal types for host ↔ extension communication (Comlink).
 * Must stay in sync with faraday-tauri src/extensionApi.ts.
 */

export interface EditorGrammarPayload {
  contribution: { language: string; scopeName: string; path: string; embeddedLanguages?: Record<string, string> };
  content: object;
}

export interface EditorLanguagePayload {
  id: string;
  aliases?: string[];
  extensions?: string[];
  filenames?: string[];
}

export interface EditorProps {
  filePath: string;
  fileName: string;
  langId: string;
  extensionDirPath?: string;
  languages?: EditorLanguagePayload[];
  grammars?: EditorGrammarPayload[];
}

export interface ColorThemeData {
  kind: 'dark' | 'light';
  colors?: Record<string, string>;
  tokenColors?: unknown[];
}

export interface HostApi {
  readFile(path: string): Promise<ArrayBuffer>;
  readFileText(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  getTheme(): Promise<string>;
  getColorTheme?(): ColorThemeData | null;
  onThemeChange?(callback: (theme: ColorThemeData) => void): () => void;
  onClose(): void;
  getOnigurumaWasm?(): Promise<ArrayBuffer>;
  executeCommand?<T = unknown>(command: string, args?: unknown): Promise<T>;
}

export interface EditorExtensionApi {
  mount(root: HTMLElement, hostApi: HostApi, props: EditorProps): Promise<void>;
  unmount(): Promise<void>;
  setDirty?(dirty: boolean): void;
  setLanguage?(langId: string): void | Promise<void>;
}

export interface ExtensionGrammar {
  language: string;
  scopeName: string;
  path: string;
  embeddedLanguages?: Record<string, string>;
}

export interface ExtensionLanguage {
  id: string;
  aliases?: string[];
  extensions?: string[];
  filenames?: string[];
}

export interface ExtensionManifest {
  contributes?: {
    languages?: ExtensionLanguage[];
    grammars?: { language: string; scopeName: string; path: string; embeddedLanguages?: Record<string, string> }[];
  };
}
