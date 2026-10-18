<script setup lang="ts">
import { useCounter } from '@/composables/useCounter';

const { count, double, increment } = useCounter(10);
</script>

<template>
  <main>
    <p>Count: {{ count }} (double: {{ double }})</p>
    <button @click="increment">+1</button>
  </main>
</template>
