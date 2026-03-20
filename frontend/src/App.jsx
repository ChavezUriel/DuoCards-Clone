import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import HomePage from './pages/HomePage';
import PracticePage from './pages/PracticePage';
import ReviewPage from './pages/ReviewPage';

function App() {
  const location = useLocation();
  const isReviewRoute = location.pathname.startsWith('/review/') || location.pathname === '/practice';

  return (
    <div className={`app-shell ${isReviewRoute ? 'app-shell--review' : ''}`}>
      {!isReviewRoute ? (
        <header className="hero">
          <div>
            <p className="eyebrow">Spanish speakers learning English</p>
            <h1>DuoCards Clone</h1>
            <p className="hero-copy">
              Review short English flashcards, reveal the answer, and track what you already know.
            </p>
          </div>
        </header>
      ) : null}

      <main className={`page-content ${isReviewRoute ? 'page-content--review' : ''}`}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/practice" element={<PracticePage />} />
          <Route path="/review/:deckId" element={<ReviewPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;
