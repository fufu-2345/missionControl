import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import ProtectedRoute, { AdminRoute } from './components/ProtectedRoute.jsx';
import Login from './pages/Login.jsx';
import Marketplace from './pages/Marketplace.jsx';
import SkillPage from './pages/SkillPage.jsx';
import Timeline from './pages/Timeline.jsx';
import Admin from './pages/Admin.jsx';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      {/* Authenticated area, wrapped in the shared Layout. */}
      <Route element={<ProtectedRoute />}>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/marketplace" replace />} />
          <Route path="/marketplace" element={<Marketplace />} />
          <Route path="/skills/:id" element={<SkillPage />} />
          <Route path="/timeline" element={<Timeline />} />

          {/* Admin-only. */}
          <Route element={<AdminRoute />}>
            <Route path="/admin" element={<Admin />} />
          </Route>
        </Route>
      </Route>

      {/* Anything else -> marketplace (which itself guards to /login). */}
      <Route path="*" element={<Navigate to="/marketplace" replace />} />
    </Routes>
  );
}
