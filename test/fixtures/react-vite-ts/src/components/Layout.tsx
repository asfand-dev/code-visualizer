import { NavLink, Outlet } from 'react-router-dom';
import { useTheme } from '@/context/ThemeContext';
import { useCartStore } from '@/store/useCartStore';
import { ThemeToggle } from './ThemeToggle';

function Nav() {
  const count = useCartStore((state) => state.items.length);
  return (
    <nav>
      <NavLink to="/">Home</NavLink>
      <NavLink to="/settings">Settings</NavLink>
      <NavLink to="/admin/reports">Reports</NavLink>
      <span className="cart-count">{count}</span>
      <ThemeToggle />
    </nav>
  );
}

export default function Layout() {
  const { theme } = useTheme();
  return (
    <div className={`layout theme-${theme}`}>
      <Nav />
      <main>
        <Outlet />
      </main>
    </div>
  );
}
