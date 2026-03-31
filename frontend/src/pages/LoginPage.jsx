import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { login } from '../api';

function LoginPage() {
  const navigate = useNavigate();
  const [formData, setFormData] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      setIsLoading(true);
      setError('');
      await login(formData.email, formData.password);
      navigate('/');
    } catch (err) {
      setError(err.message || 'Login failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handleChange = (e) => {
    setFormData(prev => ({ ...prev, [e.target.name]: e.target.value }));
  };

  return (
    <section className="panel auth-panel">
      <div className="auth-panel__content">
        <h1>Login</h1>
        <p className="hero-copy">Sign in to your account to sync your decks and progress.</p>

        {error && <div className="deck-grid__status deck-grid__status--error">{error}</div>}

        <form className="login-form" onSubmit={handleSubmit}>
          <label className="login-field">
            <span className="eyebrow">Email Address</span>
            <input type="email" name="email" value={formData.email} onChange={handleChange} placeholder="you@example.com" aria-label="Email address" required />
          </label>

          <label className="login-field">
            <span className="eyebrow">Password</span>
            <input type="password" name="password" value={formData.password} onChange={handleChange} placeholder="Password" aria-label="Password" required />
          </label>

          <div className="login-row">
            <label className="login-remember">
              <input type="checkbox" name="remember" />
              <span>Remember me</span>
            </label>

            <Link to="/" className="back-link">Forgot your password?</Link>
          </div>

          <div style={{ marginTop: '0.5rem', fontSize: '0.9rem', color: '#6b7058' }}>
            Don't have an account? <Link to="/register" className="back-link" style={{ display: 'inline' }}>Sign up now</Link>
          </div>

          <div className="login-actions">
            <button className="button button--primary" type="submit" disabled={isLoading}>
              {isLoading ? 'Signing in...' : 'Log in'}
            </button>
            <Link to="/" className="button button--secondary">Back</Link>
          </div>
        </form>
      </div>
    </section>
  );
}

export default LoginPage;
