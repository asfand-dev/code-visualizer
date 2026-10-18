<script setup lang="ts">
import { computed } from 'vue';
import TodoItem from '@/components/TodoItem.vue';
import { useTodoStore } from '@/stores/todos';

const props = defineProps<{ id: string }>();
const store = useTodoStore();
// TODO: show a 404 state instead of an empty page
const todo = computed(() => store.byId(Number(props.id)));
</script>

<template>
  <TodoItem v-if="todo" :todo="todo" @toggle="store.toggle" />
</template>
