import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import AnalyzePage from "./pages/AnalyzePage";
import ProjectDetail from "./pages/ProjectDetail";
import ProjectsList from "./pages/ProjectsList";

function navClass({ isActive }: { isActive: boolean }): string {
  return `rounded-lg px-3 py-2 text-sm font-semibold transition ${
    isActive ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-200"
  }`;
}

export default function App() {
  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_20%_0%,#e8f6f3_0%,#f8fafc_45%,#f8fafc_100%)] text-slate-900">
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">ytai-analizer</p>
            <p className="text-sm text-slate-700">Analyze + Projects Dashboard</p>
          </div>
          <nav className="flex items-center gap-2 rounded-xl bg-slate-100 p-1">
            <NavLink to="/" end className={navClass}>
              Analyze
            </NavLink>
            <NavLink to="/projects" className={navClass}>
              Projects
            </NavLink>
          </nav>
        </div>
      </header>

      <Routes>
        <Route path="/" element={<AnalyzePage />} />
        <Route path="/projects" element={<ProjectsList />} />
        <Route path="/projects/:projectId" element={<ProjectDetail />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
