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
