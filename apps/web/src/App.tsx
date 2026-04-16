import { Routes, Route } from 'react-router-dom';

function Home() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-gray-900 mb-2">Prequest</h1>
        <p className="text-lg text-gray-600">Unified Workplace Operations Platform</p>
        <div className="mt-8 space-x-4">
          <a
            href="/portal"
            className="inline-block px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
          >
            Employee Portal
          </a>
          <a
            href="/desk"
            className="inline-block px-6 py-3 bg-gray-800 text-white rounded-lg hover:bg-gray-900 transition"
          >
            Service Desk
          </a>
        </div>
      </div>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      {/* Phase 1 routes */}
      {/* <Route path="/desk/*" element={<DeskLayout />} /> */}
      {/* <Route path="/portal/*" element={<PortalLayout />} /> */}
      {/* <Route path="/admin/*" element={<AdminLayout />} /> */}
    </Routes>
  );
}
