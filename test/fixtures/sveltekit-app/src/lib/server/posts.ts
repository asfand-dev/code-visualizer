import type { Post } from '$lib/types';

const posts: Post[] = [
  { slug: 'hello-world', title: 'Hello world', excerpt: 'First post.', publishedAt: '2024-05-01' },
  { slug: 'runes', title: 'Svelte 5 runes', excerpt: 'State, derived and effects.', publishedAt: '2024-10-20' },
];

export function listPosts(): Post[] {
  return [...posts].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

export function getPost(slug: string): Post | undefined {
  return posts.find((p) => p.slug === slug);
}
