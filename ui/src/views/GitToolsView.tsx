import { useMemo, useState } from 'react';
import { Lightbulb, SquareTerminal } from 'lucide-react';
import { contextOf, gitRecipes, type GitRecipe } from '../../../src/shared/git-recipes';
import { useModel } from '../data/context';
import { plural } from '../lib/format';
import { useRefreshOnFocus } from '../lib/use-refresh-on-focus';
import { CommandBlock, RiskBadge } from '../components/CommandBlock';
import { CommitHelper } from '../components/CommitHelper';
import { GitSearch } from '../components/GitSearch';
import { Standup } from '../components/Standup';
import { Empty, SearchInput, Tabs } from '../components/ui';

function RecipeCard({ recipe }: { recipe: GitRecipe }) {
  return (
    <div className="recipe">
      <div className="row nowrap" style={{ gap: 8 }}>
        <b className="small" style={{ flex: 1 }}>
          {recipe.title}
        </b>
        <RiskBadge risk={recipe.risk} />
      </div>
      {recipe.reason && (
        <div className="tiny" style={{ color: 'var(--accent)', fontWeight: 600 }}>
          {recipe.reason}
        </div>
      )}
      <div className="tiny muted">{recipe.explain}</div>
      <CommandBlock commands={recipe.commands} />
    </div>
  );
}

function matches(recipe: GitRecipe, query: string): boolean {
  return `${recipe.title} ${recipe.explain} ${recipe.commands.join(' ')}`.toLowerCase().includes(query);
}

export function GitToolsView() {
  const { data } = useModel();
  const [group, setGroup] = useState('all');
  const [search, setSearch] = useState('');
  useRefreshOnFocus();
  const context = useMemo(() => contextOf(data), [data]);
  const { suggested, groups } = useMemo(() => gitRecipes(context ?? { dirty: 0 }), [context]);
  if (!context) {
    return (
      <div className="page">
        <Empty icon={SquareTerminal} title="No git repository">
          The Git toolbox needs a repository with at least one commit.
        </Empty>
      </div>
    );
  }
  const query = search.trim().toLowerCase();
  const shown = groups.filter((g) => group === 'all' || g.id === group).map((g) => ({ ...g, recipes: g.recipes.filter((r) => !query || matches(r, query)) }));
  const total = groups.reduce((n, g) => n + g.recipes.length, 0);

  return (
    <div className="page">
      {suggested.length > 0 && (
        <div className="card suggested" style={{ marginBottom: 16 }}>
          <div className="card-head">
            <Lightbulb size={16} style={{ color: 'var(--accent)' }} />
            <h3>Right now</h3>
            <span className="tiny faint">fitted to {context.branch ? <span className="mono">{context.branch}</span> : 'your repository'}</span>
          </div>
          <div className="card-body recipes">
            {suggested.map((recipe) => (
              <RecipeCard key={recipe.id} recipe={recipe} />
            ))}
          </div>
        </div>
      )}

      <div className="grid cols-2">
        <CommitHelper />
        <Standup />
      </div>

      <div style={{ marginTop: 16 }}>
        <GitSearch />
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head" style={{ flexWrap: 'wrap' }}>
          <h3>Recipes</h3>
          <span className="tiny faint">{plural(total, 'situation')}, with your branch and base filled in</span>
          <span className="spacer" />
          <SearchInput value={search} onChange={setSearch} placeholder="undo, stash, rebase…" style={{ width: 220 }} />
        </div>
        <div style={{ padding: '4px 12px 0', overflowX: 'auto' }}>
          <Tabs value={group} onChange={setGroup} tabs={[{ value: 'all', label: 'All' }, ...groups.map((g) => ({ value: g.id, label: g.title, count: g.recipes.length }))]} />
        </div>
        <div className="card-body stack" style={{ gap: 18 }}>
          {shown.map(
            (g) =>
              g.recipes.length > 0 && (
                <section key={g.id}>
                  {group === 'all' && <div className="section-title">{g.title}</div>}
                  <div className="recipes">
                    {g.recipes.map((recipe) => (
                      <RecipeCard key={recipe.id} recipe={recipe} />
                    ))}
                  </div>
                </section>
              ),
          )}
          {shown.every((g) => !g.recipes.length) && <div className="muted small">No recipe matches “{search}”.</div>}
        </div>
      </div>
      <p className="tiny faint" style={{ marginTop: 12 }}>
        Nothing on this page runs a command for you: recipes and messages are text to copy into your terminal. Each recipe says whether it can lose work.
      </p>
    </div>
  );
}
