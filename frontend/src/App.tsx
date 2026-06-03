import { Navigate, Route, Routes } from "react-router-dom";
import { useAuthStore } from "./store/auth";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import HomePage from "./pages/HomePage";
import ChannelPage from "./pages/ChannelPage";
import InvitePage from "./pages/InvitePage";
import DmPage from "./pages/DmPage";
import ProfilePage from "./pages/ProfilePage";
import MainLayout from "./components/MainLayout";
import GlobalEventListener from "./components/GlobalEventListener";

function RequireAuth({ children }: { children: JSX.Element }) {
  const token = useAuthStore((s) => s.accessToken);
  return token ? children : <Navigate to="/login" replace />;
}

export default function App() {
  const token = useAuthStore((s) => s.accessToken);
  return (
    <>
      {/* Single WS connection for the whole authenticated session — reacts to
          per-user moderation events (mute/kick/ban/role changes). Stays
          mounted across route changes so we don't churn the socket. */}
      {token && <GlobalEventListener />}
      <Routes>
        {/* Public */}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/invite/:code" element={<InvitePage />} />

        {/* Authenticated app shell: persistent left sidebar (channels, DMs,
            profile), pages render into <Outlet />. Sidebar stays mounted
            across navigations so WS state and lists don't reload. */}
        <Route
          element={
            <RequireAuth>
              <MainLayout />
            </RequireAuth>
          }
        >
          <Route path="/" element={<HomePage />} />
          <Route path="/profile/:userId" element={<ProfilePage />} />
          <Route path="/dm/:peerId" element={<DmPage />} />
          <Route path="/channels/:channelId" element={<ChannelPage />} />
          <Route
            path="/channels/:channelId/rooms/:roomId"
            element={<ChannelPage />}
          />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
