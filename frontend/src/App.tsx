import { Navigate, Route, Routes } from "react-router-dom";
import { useAuthStore } from "./store/auth";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import HomePage from "./pages/HomePage";
import ChannelPage from "./pages/ChannelPage";
import InvitePage from "./pages/InvitePage";
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
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/invite/:code" element={<InvitePage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <HomePage />
          </RequireAuth>
        }
      />
      <Route
        path="/channels/:channelId"
        element={
          <RequireAuth>
            <ChannelPage />
          </RequireAuth>
        }
      />
      <Route
        path="/channels/:channelId/rooms/:roomId"
        element={
          <RequireAuth>
            <ChannelPage />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </>
  );
}
