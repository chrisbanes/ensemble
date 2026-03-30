import { Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import IssueDetail from "./pages/IssueDetail";
import History from "./pages/History";
import ConfigStatus from "./pages/ConfigStatus";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/issue/:identifier" element={<IssueDetail />} />
        <Route path="/history" element={<History />} />
        <Route path="/config" element={<ConfigStatus />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
