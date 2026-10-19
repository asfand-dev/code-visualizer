import { useEffect } from 'react';
import { liveConfig, refreshAnalysis } from '../data/live';

/** Coming back to the tab sooner than this does not ask the server to look again. */
const MIN_REFRESH_GAP_MS = 20_000;

/**
 * The live server watches files, but not a branch created in a terminal or a `.claude` folder on some systems.
 * Views of the repository, CI and AI setup ask it to look again when the tab comes back into view.
 */
export function useRefreshOnFocus(): void {
  useEffect(() => {
    if (!liveConfig()) return;
    let last = Date.now();
    const onReturn = (): void => {
      if (document.visibilityState !== 'visible' || Date.now() - last < MIN_REFRESH_GAP_MS) return;
      last = Date.now();
      void refreshAnalysis();
    };
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    return () => {
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
    };
  }, []);
}
