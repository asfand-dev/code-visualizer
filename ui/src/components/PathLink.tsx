import { liveConfig, openInEditor } from '../data/live';
import { toast, useStore } from '../state/store';

/**
 * A file that is not one of the analyzed source files (a workflow, a `.claude` skill): it opens in the editor
 * when the live server runs, and is plain text in a report. Paths that start with `~/` are outside the project.
 */
export function PathLink({ path, line, label }: { path: string; line?: number; label?: string }) {
  const editor = useStore((s) => s.editor);
  const text = label ?? (line ? `${path}:${line}` : path);
  if (!liveConfig() || path.startsWith('~/') || editor === 'none') return <span className="mono tiny muted">{text}</span>;
  return (
    <button
      className="chip"
      title={`Open ${path} in your editor`}
      onClick={async () => {
        if (!(await openInEditor(path, line, editor))) toast(`Could not open ${path}: is your editor's command on the PATH?`, { tone: 'warning' });
      }}
    >
      <span className="mono truncate">{text}</span>
    </button>
  );
}
