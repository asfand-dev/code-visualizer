import type { RecipeRisk } from '../../../src/shared/git-recipes';
import { CopyButton } from './ui';

const RISK: Record<RecipeRisk, { label: string; tone: string; title: string }> = {
  safe: { label: 'safe', tone: 'success', title: 'Changes nothing you cannot get back' },
  'rewrites-history': { label: 'rewrites history', tone: 'warn', title: 'Do not use it on commits other people already have' },
  'discards-work': { label: 'discards work', tone: 'danger', title: 'Uncommitted work is lost for good' },
};

export function RiskBadge({ risk }: { risk: RecipeRisk }) {
  const { label, tone, title } = RISK[risk];
  return (
    <span className={`badge ${tone}`} title={title}>
      {label}
    </span>
  );
}

/** Commands to paste into a terminal, one per line, with a copy button. Nothing here is ever run by the page. */
export function CommandBlock({ commands }: { commands: string[] | string }) {
  const text = typeof commands === 'string' ? commands : commands.join('\n');
  return (
    <div className="cmd">
      <pre>{text}</pre>
      <CopyButton text={text} />
    </div>
  );
}
