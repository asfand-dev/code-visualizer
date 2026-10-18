<script setup lang="ts">
const props = withDefaults(defineProps<{ title: string; subtitle?: string }>(), {
  subtitle: '',
});

const emit = defineEmits<{
  menu: [];
}>();
</script>

<template>
  <header>
    <button class="menu" @click="emit('menu')">☰</button>
    <h1>{{ props.title }}</h1>
    <p v-if="props.subtitle">{{ props.subtitle }}</p>
    <nav>
      <router-link to="/">Home</router-link>
      <router-link to="/todos">Todos</router-link>
      <router-link to="/about">About</router-link>
    </nav>
  </header>
</template>
