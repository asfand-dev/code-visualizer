<script lang="ts">
import { defineComponent } from 'vue';
import TodoItem from './TodoItem.vue';

// Options API on purpose: this component predates <script setup>.
export default defineComponent({
  name: 'TodoList',
  components: { TodoItem },
  props: ['items', 'filter'],
  emits: ['toggle', 'remove'],
  computed: {
    visible() {
      if (this.filter === 'open') return this.items.filter((t: { done: boolean }) => !t.done);
      if (this.filter === 'done') return this.items.filter((t: { done: boolean }) => t.done);
      return this.items;
    },
  },
});
</script>

<template>
  <ul class="todo-list">
    <todo-item
      v-for="item in visible"
      :key="item.id"
      :todo="item"
      editable
      @toggle="$emit('toggle', $event)"
      @remove="$emit('remove', $event)"
    />
  </ul>
</template>
