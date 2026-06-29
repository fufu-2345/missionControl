import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';

const navLinkStyle = ({ isActive }) => ({
  color: isActive ? '#111' : '#555',
  fontWeight: isActive ? 600 : 400,
  textDecoration: 'none',
});

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
          <NavLink to="/marketplace" style={navLinkStyle}>
            Marketplace
          </NavLink>
          <NavLink to="/timeline" style={navLinkStyle}>
            Timeline
          </NavLink>
          {isAdmin && (
            <NavLink to="/admin" style={navLinkStyle}>
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
