import { mountEditor, unmountEditor } from './editor';
import type { EditorExtensionApi, EditorProps } from '@dotdirfm/extension-api';

function createExtensionApi(): EditorExtensionApi {
  let mounted = false;
  return {
    async mount(root: HTMLElement, props: EditorProps): Promise<void> {
      if (mounted) unmountEditor();
      await mountEditor(root, props);
      mounted = true;
    },
    async unmount(): Promise<void> {
      if (!mounted) return;
      unmountEditor();
      mounted = false;
    },
  };
}

export default createExtensionApi();
