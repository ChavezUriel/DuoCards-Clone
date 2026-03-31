import { Navigate, Route, Routes, useLocation, Link } from 'react-router-dom';
import HomePage from './pages/HomePage';
import MarketPage from './pages/MarketPage';
import DeckWordsPage from './pages/DeckWordsPage';
import PracticePage from './pages/PracticePage';
import ReviewPage from './pages/ReviewPage';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';

function App() {
  const location = useLocation();
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
    headerContent = <Link to="/login" className="back-link">Iniciar sesión</Link>;
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
          <Route path="/" element={<HomePage />} />
          <Route path="/market" element={<MarketPage />} />
          <Route path="/decks/:deckId/words" element={<DeckWordsPage />} />
          <Route path="/practice" element={<PracticePage />} />
          <Route path="/review/:deckId" element={<ReviewPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;
