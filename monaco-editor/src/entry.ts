/**
 * Faraday Monaco Editor extension — entry point.
 * Registers with the host via __faradayHostReady and renders into the provided root.
 */

import type { EditorExtensionApi, EditorProps, HostApi } from './types';
import { createEditorMount, disposeEditor, ensureTextMateLanguage, setEditorLanguage } from './editor';

function createExtensionApi(): EditorExtensionApi {
  let mounted = false;
  let unmountFn: (() => void) | null = null;
  let lastFilePath: string | null = null;
  let latestHostApi: HostApi | null = null;
  let latestProps: EditorProps | null = null;
  let lastLangId: string | null = null;

  return {
    async mount(root: HTMLElement, hostApi: HostApi, props: EditorProps): Promise<void> {
      latestHostApi = hostApi;
      latestProps = props;

      // If we're already mounted with the same file, nothing to do.
      if (mounted && lastFilePath === props.filePath) return;

      // Switching file contents: recreate the editor.
      if (mounted && lastFilePath !== props.filePath) {
        if (unmountFn) unmountFn();
        unmountFn = null;
        disposeEditor();
        mounted = false;
      }

      unmountFn = await createEditorMount(root, hostApi, props);
      mounted = true;
      lastFilePath = props.filePath;
      lastLangId = props.langId;
    },
    async unmount(): Promise<void> {
      if (!mounted) return;
      if (unmountFn) {
        unmountFn();
        unmountFn = null;
      }
      disposeEditor();
      mounted = false;
      lastFilePath = null;
      lastLangId = null;
    },
    setLanguage(langId: string): void {
      if (!mounted) return;
      // Language tokenization is async (grammar + onig load); do it in background,
      // then switch the Monaco model language when ready.
      void (async () => {
        if (latestHostApi && latestProps) {
          await ensureTextMateLanguage(latestHostApi, latestProps, langId);
        }
        setEditorLanguage(langId);
        lastLangId = langId;
      })().catch(() => {
        // If tokenization fails, still update the model language so Monaco behaves sanely.
        setEditorLanguage(langId);
        lastLangId = langId;
      });
    },
  };
}

const api = createExtensionApi();
if (typeof window !== 'undefined' && (window as Window & { __faradayHostReady?: (api: EditorExtensionApi) => void }).__faradayHostReady) {
  (window as Window & { __faradayHostReady: (api: EditorExtensionApi) => void }).__faradayHostReady(api);
}
