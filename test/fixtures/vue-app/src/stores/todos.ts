import { defineStore } from 'pinia';
import type { Todo, TodoFilter } from '@/types';

export const useTodoStore = defineStore('todos', {
  state: () => ({
    items: [] as Todo[],
    filter: 'all' as TodoFilter,
    nextId: 1,
  }),
  getters: {
    remaining: (state) => state.items.filter((t) => !t.done).length,
    byId: (state) => (id: number) => state.items.find((t) => t.id === id),
  },
  actions: {
    add(title: string) {
      this.items.push({ id: this.nextId++, title, done: false });
    },
    toggle(id: number) {
      const todo = this.items.find((t) => t.id === id);
      if (todo) todo.done = !todo.done;
    },
    remove(id: number) {
      this.items = this.items.filter((t) => t.id !== id);
    },
  },
});
