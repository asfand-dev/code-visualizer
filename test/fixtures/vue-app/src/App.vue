<script setup lang="ts">
import { RouterView } from 'vue-router';
import AppHeader from '@/components/AppHeader.vue';
import { useCounterStore } from '@/stores/counter';

const counter = useCounterStore();
</script>

<template>
  <AppHeader title="Todos" :subtitle="`${counter.count} visits`" @menu="counter.increment()" />
  <RouterView />
</template>

<style scoped>
header {
  line-height: 1.5;
}
</style>
