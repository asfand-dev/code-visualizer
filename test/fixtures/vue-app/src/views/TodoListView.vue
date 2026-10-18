<script setup lang="ts">
import { ref } from 'vue';
import TodoList from '@/components/TodoList.vue';
import { useTodoStore } from '@/stores/todos';

const store = useTodoStore();
const draft = ref('');

function submit() {
  if (!draft.value.trim()) return;
  store.add(draft.value.trim());
  draft.value = '';
}
</script>

<template>
  <form @submit.prevent="submit">
    <input v-model="draft" placeholder="What needs doing?" />
  </form>
  <TodoList :items="store.items" :filter="store.filter" @toggle="store.toggle" @remove="store.remove" />
</template>
