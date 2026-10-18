<script lang="ts">
  // Svelte 4 style props (legacy mode still supported in Svelte 5)
  export let title: string;
  export let subtitle = '';
</script>

<header>
  <a href="/">{title}</a>
  {#if subtitle}<small>{subtitle}</small>{/if}
  <nav>
    <a href="/blog/hello-world">Blog</a>
  </nav>
</header>

<style>
  header {
    display: flex;
    gap: 1rem;
  }
</style>
