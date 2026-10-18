<script setup lang="ts">
import { RouterView } from 'vue-router';
import { useTodoStore } from '@/stores/todos';

const store = useTodoStore();
</script>

<template>
  <section>
    <h1>Todos ({{ store.remaining }} left)</h1>
    <RouterView />
  </section>
</template>
