<script lang="ts">
  import type { Snippet } from 'svelte';
  import Header from '$lib/components/Header.svelte';

  let { children }: { children: Snippet } = $props();
</script>

<Header title="Field Notes" subtitle="A small blog" />
<main>
  {@render children()}
</main>
