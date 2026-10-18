import { createRouter, createWebHistory } from 'vue-router';
import HomeView from '../views/HomeView.vue';

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'home',
      component: HomeView,
    },
    {
      path: '/about',
      name: 'about',
      // route level code-splitting
      component: () => import('../views/AboutView.vue'),
    },
    {
      path: '/todos',
      component: () => import('@/views/TodosLayout.vue'),
      children: [
        { path: '', name: 'todos', component: () => import('@/views/TodoListView.vue') },
        { path: ':id', name: 'todo-detail', component: () => import('@/views/TodoDetailView.vue'), props: true },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

export default router;
