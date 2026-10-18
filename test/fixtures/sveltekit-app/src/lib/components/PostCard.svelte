<script lang="ts">
  import type { Post } from '$lib/types';
  import { formatDate } from '$lib/utils';

  interface Props {
    post: Post;
    compact?: boolean;
  }

  let { post, compact = false }: Props = $props();
  let date = $derived(formatDate(post.publishedAt));
</script>

<article class:compact>
  <h2><a href="/blog/{post.slug}">{post.title}</a></h2>
  <time datetime={post.publishedAt}>{date}</time>
  {#if !compact}<p>{post.excerpt}</p>{/if}
</article>
