<script lang="ts">
  import { formatDate, readingTime } from '$lib/utils';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<article>
  <h1>{data.post.title}</h1>
  <p>{formatDate(data.post.publishedAt)} · {readingTime(data.post.excerpt)} min read</p>
  <p>{data.post.excerpt}</p>
</article>
