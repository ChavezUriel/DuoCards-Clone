import { useState } from 'react';
import { Link } from 'react-router-dom';
import { requestPasswordReset } from '../api';

function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      setIsLoading(true);
      setError('');
      await requestPasswordReset(email);
      setSent(true);
    } catch (err) {
      setError(err.message || 'Could not send the reset email');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <section className="panel auth-panel">
      <div className="auth-panel__content">
        <h1>Reset your password</h1>

        {sent ? (
          <>
            <p className="hero-copy">
              If an account exists for <strong>{email}</strong>, we've sent a link to reset your
              password. Check your inbox and follow the link to choose a new password.
            </p>
            <div className="login-actions">
              <Link to="/login" className="button button--primary">Back to login</Link>
            </div>
          </>
        ) : (
          <>
            <p className="hero-copy">Enter your email and we'll send you a link to reset your password.</p>

            {error && <div className="deck-grid__status deck-grid__status--error">{error}</div>}

            <form className="login-form" onSubmit={handleSubmit}>
              <label className="login-field">
                <span className="eyebrow">Email Address</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  aria-label="Email address"
                  required
                />
              </label>

              <div className="login-actions">
                <button className="button button--primary" type="submit" disabled={isLoading}>
                  {isLoading ? 'Sending...' : 'Send reset link'}
                </button>
                <Link to="/login" className="button button--secondary">Back</Link>
              </div>
            </form>
          </>
        )}
      </div>
    </section>
  );
}

export default ForgotPasswordPage;
