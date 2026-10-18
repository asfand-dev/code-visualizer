import { create } from 'zustand';
import type { CartItem } from '@/types';

interface CartState {
  items: CartItem[];
  add: (item: CartItem) => void;
  remove: (sku: string) => void;
  clear: () => void;
}

export const useCartStore = create<CartState>()((set) => ({
  items: [],
  add: (item) =>
    set((state) => {
      const existing = state.items.find((i) => i.sku === item.sku);
      if (existing) {
        return { items: state.items.map((i) => (i.sku === item.sku ? { ...i, quantity: i.quantity + 1 } : i)) };
      }
      return { items: [...state.items, item] };
    }),
  remove: (sku) => set((state) => ({ items: state.items.filter((i) => i.sku !== sku) })),
  clear: () => set({ items: [] }),
}));
