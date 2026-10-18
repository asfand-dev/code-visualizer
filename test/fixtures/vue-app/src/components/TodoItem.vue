<script setup lang="ts">
import { computed } from 'vue';
import type { Todo } from '@/types';

const props = defineProps<{
  todo: Todo;
  editable?: boolean;
}>();

const emit = defineEmits<{
  (e: 'toggle', id: number): void;
  (e: 'remove', id: number): void;
}>();

const label = computed(() => (props.todo.done ? `✓ ${props.todo.title}` : props.todo.title));
</script>

<template>
  <li :class="{ done: todo.done }">
    <input type="checkbox" :checked="todo.done" @change="emit('toggle', todo.id)" />
    <span>{{ label }}</span>
    <button v-if="editable" @click="emit('remove', todo.id)">Remove</button>
  </li>
</template>
