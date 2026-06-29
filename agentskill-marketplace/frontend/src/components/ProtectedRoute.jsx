import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';

// Requires a logged-in user. Renders children if provided, else <Outlet/>.
export default function ProtectedRoute({ children }) {
  const { token } = useAuth();
  if (!token) {
    return <Navigate to="/login" replace />;
  }
  return children ?? <Outlet />;
}

// Requires an admin user. Non-admins get bounced to the marketplace.
export function AdminRoute({ children }) {
  const { token, isAdmin } = useAuth();
  if (!token) {
    return <Navigate to="/login" replace />;
  }
  if (!isAdmin) {
    return <Navigate to="/marketplace" replace />;
  }
  return children ?? <Outlet />;
}
