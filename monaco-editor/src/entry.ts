/**
 * Faraday Monaco Editor extension — entry point.
 * Registers with the host via __faradayHostReady and renders into the provided root.
 */

import type { EditorExtensionApi, EditorProps, HostApi } from './types';
import { createEditorMount, disposeEditor, setEditorLanguage } from './editor';

function createExtensionApi(): EditorExtensionApi {
  let mounted = false;
  let unmountFn: (() => void) | null = null;

  return {
    async mount(root: HTMLElement, hostApi: HostApi, props: EditorProps): Promise<void> {
      if (mounted) return;
      unmountFn = await createEditorMount(root, hostApi, props);
      mounted = true;
    },
    async unmount(): Promise<void> {
      if (!mounted) return;
      if (unmountFn) {
        unmountFn();
        unmountFn = null;
      }
      disposeEditor();
      mounted = false;
    },
    setLanguage(langId: string): void {
      setEditorLanguage(langId);
    },
  };
}

const api = createExtensionApi();
if (typeof window !== 'undefined' && (window as Window & { __faradayHostReady?: (api: EditorExtensionApi) => void }).__faradayHostReady) {
  (window as Window & { __faradayHostReady: (api: EditorExtensionApi) => void }).__faradayHostReady(api);
}
