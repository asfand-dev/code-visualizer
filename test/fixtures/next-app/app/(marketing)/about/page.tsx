import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'About — Acme' };

export default function AboutPage() {
  return (
    <article>
      <h1>About Acme</h1>
      <p>We build internal tools.</p>
    </article>
  );
}
