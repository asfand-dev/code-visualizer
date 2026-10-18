import type { EditorId } from '../state/store';

export const EDITORS: { id: EditorId; label: string }[] = [
  { id: 'vscode', label: 'VS Code' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'windsurf', label: 'Windsurf' },
  { id: 'webstorm', label: 'WebStorm' },
  { id: 'zed', label: 'Zed' },
  { id: 'none', label: 'Disabled' },
];

export function editorUrl(editor: EditorId, rootPath: string, fileId: string, line = 1): string | undefined {
  const abs = `${rootPath.replace(/\\/g, '/').replace(/\/$/, '')}/${fileId}`;
  const path = abs.startsWith('/') ? abs : `/${abs}`;
  switch (editor) {
    case 'vscode':
      return `vscode://file${path}:${line}:1`;
    case 'cursor':
      return `cursor://file${path}:${line}:1`;
    case 'windsurf':
      return `windsurf://file${path}:${line}:1`;
    case 'webstorm':
      return `webstorm://open?file=${encodeURIComponent(abs)}&line=${line}`;
    case 'zed':
      return `zed://file${path}:${line}`;
    default:
      return undefined;
  }
}
