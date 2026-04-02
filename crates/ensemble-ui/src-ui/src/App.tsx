import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout";
import ErrorBoundary from "./components/ErrorBoundary";

const Dashboard = lazy(() => import("./pages/Dashboard"));
const IssueDetail = lazy(() => import("./pages/IssueDetail"));
const History = lazy(() => import("./pages/History"));
const ConfigPage = lazy(() => import("./pages/ConfigPage"));

function PageLoader() {
  return <div className="text-center py-12 text-muted-foreground">Loading...</div>;
}

export default function App() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/issue/:identifier" element={<IssueDetail />} />
            <Route path="/history" element={<History />} />
            <Route path="/config" element={<ConfigPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
