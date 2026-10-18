import Link from 'next/link';

export function SiteHeader() {
  return (
    <header className="site-header">
      <Link href="/">Home</Link>
      <Link href="/about">About</Link>
    </header>
  );
}
