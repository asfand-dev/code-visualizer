import clsx from 'clsx';

/** Bundled by vite, so importing a devDependency here is fine. */
export function App({ dark = false }: { dark?: boolean }) {
  return <main className={clsx('app', { dark })}>Hello</main>;
}
