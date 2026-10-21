// The KQL editor's web worker: Microsoft's Kusto language service (parsing, completion, validation, formatting) inside Monaco's own
// editor worker, which hosts it. Since monaco-editor 0.53 the 'kusto' label needs this worker of its own. Bundled by Vite
// (`?worker`), so it loads from the app itself and nothing comes from a CDN.
import './worker-global';
import '@kusto/monaco-kusto/release/esm/kusto.worker';
import 'monaco-editor/esm/vs/editor/editor.worker.js';
