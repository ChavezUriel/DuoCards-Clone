import React, { useState, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation, Link } from 'react-router-dom';
import { supabase } from './supabaseClient';
import { logout as apiLogout } from './api';
import HomePage from './pages/HomePage';
import MarketPage from './pages/MarketPage';
import DeckWordsPage from './pages/DeckWordsPage';
import PracticePage from './pages/PracticePage';
import ReviewPage from './pages/ReviewPage';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import ResetPasswordPage from './pages/ResetPasswordPage';

function PrivateRoute({ children, session }) {
  if (!session) {
    return <Navigate to="/login" replace />;
  }
  return children;
}

function App() {
  const location = useLocation();
  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });

    return () => subscription.subscription.unsubscribe();
  }, []);

  const handleLogout = async () => {
    try {
      await apiLogout();
    } finally {
      setSession(null);
    }
  };

  const isFocusedRoute =
    location.pathname.startsWith('/review/') ||
    location.pathname === '/practice' ||
    location.pathname.startsWith('/decks/');

  let headerContent = null;

  if (location.pathname === '/login') {
    headerContent = <Link to="/register" className="back-link">Create account</Link>;
  } else if (location.pathname === '/register') {
    headerContent = <Link to="/login" className="back-link">Login</Link>;
  } else if (location.pathname === '/forgot-password' || location.pathname === '/reset-password') {
    headerContent = <Link to="/login" className="back-link">Back to login</Link>;
  } else if (!isFocusedRoute) {
    if (session) {
      headerContent = (
        <button
          onClick={handleLogout}
          className="back-link"
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
        >
          Logout
        </button>
      );
    } else {
      headerContent = <Link to="/login" className="back-link">Login</Link>;
    }
  }

  // Avoid flashing the login page (or redirecting away) before the session loads.
  if (!authReady) {
    return (
      <div className="app-shell">
        <main className="page-content">
          <p className="deck-grid__status">Loading…</p>
        </main>
      </div>
    );
  }

  return (
    <div className={`app-shell ${isFocusedRoute ? 'app-shell--review' : ''}`}>
      <header className="app-header">
        <div className="app-header__inner">
          {headerContent}
        </div>
      </header>
      <main className={`page-content ${isFocusedRoute ? 'page-content--review' : ''}`}>
        <Routes>
          <Route path="/" element={<PrivateRoute session={session}><HomePage /></PrivateRoute>} />
          <Route path="/market" element={<PrivateRoute session={session}><MarketPage /></PrivateRoute>} />
          <Route path="/decks/:deckId/words" element={<PrivateRoute session={session}><DeckWordsPage /></PrivateRoute>} />
          <Route path="/practice" element={<PrivateRoute session={session}><PracticePage /></PrivateRoute>} />
          <Route path="/review/:deckId" element={<PrivateRoute session={session}><ReviewPage /></PrivateRoute>} />
          <Route path="/login" element={session ? <Navigate to="/" replace /> : <LoginPage />} />
          <Route path="/register" element={session ? <Navigate to="/" replace /> : <RegisterPage />} />
          <Route path="/forgot-password" element={session ? <Navigate to="/" replace /> : <ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;
