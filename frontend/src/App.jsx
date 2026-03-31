import React, { useState, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation, Link } from 'react-router-dom';
import HomePage from './pages/HomePage';
import MarketPage from './pages/MarketPage';
import DeckWordsPage from './pages/DeckWordsPage';
import PracticePage from './pages/PracticePage';
import ReviewPage from './pages/ReviewPage';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';

function PrivateRoute({ children, token }) {
  if (!token) {
    return <Navigate to="/login" replace />;
  }
  return children;
}

function App() {
  const location = useLocation();
  const [token, setToken] = useState(localStorage.getItem('access_token'));

  // Update token when location changes (in case it changed after login)
  useEffect(() => {
    setToken(localStorage.getItem('access_token'));
  }, [location.pathname]);

  const handleLogout = () => {
    localStorage.removeItem('access_token');
    setToken(null);
  };

  const isFocusedRoute =
    location.pathname.startsWith('/review/') ||
    location.pathname === '/practice' ||
    location.pathname.startsWith('/decks/');

  const showHeaderLink = !['/', '/market'].includes(location.pathname);
  let headerContent = null;

  if (location.pathname === '/login') {
    headerContent = <Link to="/register" className="back-link">Crear cuenta</Link>;
  } else if (location.pathname === '/register') {
    headerContent = <Link to="/login" className="back-link">Iniciar sesión</Link>;
  } else if (!isFocusedRoute) {
    if (token) {
      headerContent = <button onClick={handleLogout} className="back-link" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Cerrar sesión</button>;
    } else {
      headerContent = <Link to="/login" className="back-link">Iniciar sesión</Link>;
    }
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
          <Route path="/" element={<PrivateRoute token={token}><HomePage /></PrivateRoute>} />
          <Route path="/market" element={<PrivateRoute token={token}><MarketPage /></PrivateRoute>} />
          <Route path="/decks/:deckId/words" element={<PrivateRoute token={token}><DeckWordsPage /></PrivateRoute>} />
          <Route path="/practice" element={<PrivateRoute token={token}><PracticePage /></PrivateRoute>} />
          <Route path="/review/:deckId" element={<PrivateRoute token={token}><ReviewPage /></PrivateRoute>} />
          <Route path="/login" element={token ? <Navigate to="/" replace /> : <LoginPage />} />
          <Route path="/register" element={token ? <Navigate to="/" replace /> : <RegisterPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;
