/**
 * .dir Monaco Editor extension — entry point.
 */

import { createEditorMount, disposeEditor, ensureTextMateLanguage, focusEditor, setEditorLanguage } from './editor';
import type { EditorExtensionApi, EditorProps } from '@dotdirfm/extension-api';

function createExtensionApi(): EditorExtensionApi {
  let mounted = false;
  let unmountFn: (() => void) | null = null;
  let lastFilePath: string | null = null;
  let latestProps: EditorProps | null = null;

  return {
    async mount(root: HTMLElement, props: EditorProps): Promise<void> {
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

      unmountFn = await createEditorMount(root, props);
      mounted = true;
      lastFilePath = props.filePath;
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
    },
    focus(): void {
      if (!mounted) return;
      focusEditor();
    },
    setLanguage(langId: string): void {
      if (!mounted) return;
      // Language tokenization is async (grammar + onig load); do it in background,
      // then switch the Monaco model language when ready.
      void (async () => {
        if (latestProps) {
          await ensureTextMateLanguage(latestProps, langId);
        }
        setEditorLanguage(langId);
      })().catch(() => {
        // If tokenization fails, still update the model language so Monaco behaves sanely.
        setEditorLanguage(langId);
      });
    },
  };
}

export default createExtensionApi();
