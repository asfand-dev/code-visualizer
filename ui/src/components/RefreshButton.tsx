import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { liveConfig, refreshAnalysis } from '../data/live';
import { toast } from '../state/store';

/** Asks the live server to look at the repository again (live only). The page updates when the server answers. */
export function RefreshButton({ what = 'repository' }: { what?: string }) {
  const [busy, setBusy] = useState(false);
  if (!liveConfig()) return null;
  return (
    <button
      className="btn ghost sm"
      disabled={busy}
      title={`Read the ${what} again: changes made in a terminal show up without waiting`}
      onClick={async () => {
        setBusy(true);
        const ok = await refreshAnalysis();
        setBusy(false);
        if (!ok) toast('The server did not answer. Is code-visualizer serve still running?', { tone: 'warning' });
      }}
    >
      <RefreshCw size={13} className={busy ? 'spin' : undefined} /> Refresh
    </button>
  );
}
