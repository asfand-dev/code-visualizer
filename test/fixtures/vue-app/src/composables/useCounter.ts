import { computed, ref } from 'vue';

export function useCounter(initial = 0, step = 1) {
  const count = ref(initial);
  const double = computed(() => count.value * 2);

  function increment() {
    count.value += step;
  }

  function reset() {
    count.value = initial;
  }

  return { count, double, increment, reset };
}
