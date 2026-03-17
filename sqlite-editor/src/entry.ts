import type { EditorExtensionApi, EditorProps, HostApi } from './types';
import { mountEditor, unmountEditor } from './editor';

function createExtensionApi(): EditorExtensionApi {
  let mounted = false;
  return {
    async mount(root: HTMLElement, hostApi: HostApi, props: EditorProps): Promise<void> {
      if (mounted) unmountEditor();
      await mountEditor(root, hostApi, props);
      mounted = true;
    },
    async unmount(): Promise<void> {
      if (!mounted) return;
      unmountEditor();
      mounted = false;
    },
  };
}

const api = createExtensionApi();
const w = window as unknown as Window & { __faradayHostReady?: (api: EditorExtensionApi) => void };
if (typeof window !== 'undefined' && w.__faradayHostReady) {
  w.__faradayHostReady(api);
}

