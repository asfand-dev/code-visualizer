export interface User {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'member';
  avatarUrl?: string;
}

export type Theme = 'light' | 'dark';

export interface CartItem {
  sku: string;
  title: string;
  price: number;
  quantity: number;
}
