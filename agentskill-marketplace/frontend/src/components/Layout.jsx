import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';

// NavLink applies the `nav-link-active` class to the current page's link.
const navLinkClass = ({ isActive }) =>
  isActive ? 'nav-link nav-link-active' : 'nav-link';

export default function Layout() {
  const { user, token, isAdmin, logout } = useAuth();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate('/login');
  }

  return (
    <div className="layout">
      <header className="topnav">
        <nav className="topnav-links">
          <Link to="/marketplace" className="brand">
            agentSkill
          </Link>
          <NavLink to="/marketplace" className={navLinkClass}>
            Marketplace
          </NavLink>
          <NavLink to="/timeline" className={navLinkClass}>
            Timeline
          </NavLink>
          {isAdmin && (
            <NavLink to="/admin" className={navLinkClass}>
              Admin
            </NavLink>
          )}
        </nav>

        <div className="topnav-right">
          {token ? (
            <>
              <span className="username">{user?.username}</span>
              <button type="button" onClick={handleLogout} className="btn">
                Logout
              </button>
            </>
          ) : (
            <Link to="/login" className="btn">
              Login
            </Link>
          )}
        </div>
      </header>

      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
