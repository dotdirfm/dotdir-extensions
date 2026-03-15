/**
 * Faraday Monaco Editor extension — entry point.
 * Runs inside the host's extension iframe. Performs Comlink handshake and exposes EditorExtensionApi.
 */

import * as Comlink from 'comlink';
import type { EditorExtensionApi, EditorProps, HostApi } from './types';
import { createEditorMount, disposeEditor } from './editor';

const handshakeId =
  typeof window !== 'undefined' && (window as unknown as { __faradayHandshakeId?: string }).__faradayHandshakeId;

const postToHost = (msg: object, transfer?: Transferable[]) => {
  if (typeof parent !== 'undefined') parent.postMessage(msg, '*', transfer);
  else (window as Window).postMessage(msg, '*', transfer);
};

if (!handshakeId) {
  postToHost({ type: 'faraday-error', message: 'Missing __faradayHandshakeId' });
  throw new Error('Faraday extension: missing handshake id');
}

postToHost({ type: 'faraday-loaded', handshakeId });

function createExtensionApi(hostApi: HostApi): EditorExtensionApi {
  let mounted = false;
  let unmountFn: (() => void) | null = null;

  return {
    async mount(props: EditorProps): Promise<void> {
      if (mounted) return;
      unmountFn = await createEditorMount(hostApi, props);
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
  };
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.data?.type !== 'faraday-init' || event.data?.handshakeId !== handshakeId) return;
  const port: MessagePort = event.data.port;
  if (!port) return;

  const hostApi = Comlink.wrap<HostApi>(port);
  const extensionApi = createExtensionApi(hostApi);
  const { port1, port2 } = new MessageChannel();
  Comlink.expose(extensionApi, port1);
  postToHost({ type: 'faraday-ready', port: port2, handshakeId }, [port2]);
});
