import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import HomePage from './pages/HomePage';
import MarketPage from './pages/MarketPage';
import DeckWordsPage from './pages/DeckWordsPage';
import PracticePage from './pages/PracticePage';
import ReviewPage from './pages/ReviewPage';

function App() {
  const location = useLocation();
  const isFocusedRoute =
    location.pathname.startsWith('/review/') ||
    location.pathname === '/practice' ||
    location.pathname.startsWith('/decks/');

  return (
    <div className={`app-shell ${isFocusedRoute ? 'app-shell--review' : ''}`}>
      <main className={`page-content ${isFocusedRoute ? 'page-content--review' : ''}`}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/market" element={<MarketPage />} />
          <Route path="/decks/:deckId/words" element={<DeckWordsPage />} />
          <Route path="/practice" element={<PracticePage />} />
          <Route path="/review/:deckId" element={<ReviewPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;
