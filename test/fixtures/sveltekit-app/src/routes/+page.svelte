<script lang="ts">
  import PostCard from '$lib/components/PostCard.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<h1>Latest posts</h1>
{#each data.posts as post (post.slug)}
  <PostCard {post} />
{/each}
