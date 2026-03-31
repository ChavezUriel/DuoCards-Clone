import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { register, login } from '../api';

function RegisterPage() {
  const navigate = useNavigate();
  const [formData, setFormData] = useState({ name: '', email: '', password: '', confirmPassword: '' });
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (formData.password !== formData.confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    try {
      setIsLoading(true);
      setError('');
      await register(formData.email, formData.name, formData.password);
      // Auto-login after registration
      await login(formData.email, formData.password);
      navigate('/');
    } catch (err) {
      setError(err.message || 'Registration failed');
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
        <h1>Create your account</h1>
        <p className="hero-copy">Sign up to save your progress and access your decks from any device.</p>

        {error && <div className="deck-grid__status deck-grid__status--error">{error}</div>}

        <form className="login-form" onSubmit={handleSubmit}>
          <label className="login-field">
            <span className="eyebrow">Full Name</span>
            <input type="text" name="name" value={formData.name} onChange={handleChange} placeholder="Your name" aria-label="Full name" required />
          </label>

          <label className="login-field">
            <span className="eyebrow">Email Address</span>
            <input type="email" name="email" value={formData.email} onChange={handleChange} placeholder="you@example.com" aria-label="Email address" required />
          </label>

          <label className="login-field">
            <span className="eyebrow">Password</span>
            <input type="password" name="password" value={formData.password} onChange={handleChange} placeholder="Minimum 6 characters" aria-label="Password" required minLength="6" />
          </label>

          <label className="login-field">
            <span className="eyebrow">Confirm Password</span>
            <input type="password" name="confirmPassword" value={formData.confirmPassword} onChange={handleChange} placeholder="Repeat your password" aria-label="Confirm password" required minLength="6" />
          </label>

          <div className="login-row">
            <p style={{ fontSize: '0.9rem', color: '#6b7058' }}>
              Already have an account? <Link to="/login" className="back-link" style={{ display: 'inline' }}>Sign in</Link>
            </p>
          </div>

          <div className="login-actions">
            <button className="button button--primary" type="submit" disabled={isLoading}>
              {isLoading ? 'Registering...' : 'Sign up'}
            </button>
            <Link to="/" className="button button--secondary">Back</Link>
          </div>
        </form>
      </div>
    </section>
  );
}

export default RegisterPage;
