import { createBrowserRouter } from 'react-router-dom';
import Layout from '@/components/Layout';
import UserProfile from '@/pages/UserProfile';
import App from './App';

/**
 * Data router. The admin area is defined here; everything else is still
 * rendered by the legacy <Routes> tree inside <App /> (splat route).
 */
export const router = createBrowserRouter([
  {
    path: '/admin',
    element: <Layout />,
    children: [
      { path: 'reports', lazy: () => import('@/pages/admin/Reports') },
      { path: 'users/:id', Component: UserProfile },
    ],
  },
  { path: '*', element: <App /> },
]);
