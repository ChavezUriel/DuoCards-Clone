import { useState } from 'react';
import { Link } from 'react-router-dom';
import { requestPasswordReset } from '../api';
import AuthBrandPanel from '../components/AuthBrandPanel';

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
    <div className="login-split">
      <AuthBrandPanel
        quote='"Lose a word, find it again. The river always returns what matters."'
        tagline="A QUIET WAY TO LEARN ENGLISH"
      />

      <div className="login-split__right">
        {sent ? (
          <>
            <h1 className="login-heading">Check your inbox</h1>
            <p className="login-body">
              If an account exists for <strong>{email}</strong>, we've sent a link to reset your
              password. Follow it to choose a new one.
            </p>
            <Link to="/login" className="login-cta">Back to login</Link>
          </>
        ) : (
          <>
            <h1 className="login-heading">Reset your password</h1>
            <p className="login-subheading">We'll email you a link to choose a new one.</p>

            {error && <p className="login-error">{error}</p>}

            <form onSubmit={handleSubmit} className="login-form-heron">
              <label className="login-label-mono" htmlFor="forgot-email">EMAIL</label>
              <input
                id="forgot-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@email.com"
                className="login-input-heron"
                required
              />

              <button type="submit" className="login-cta" disabled={isLoading}>
                {isLoading ? 'Sending…' : 'Send reset link'}
              </button>
            </form>

            <p className="login-signup-prompt">
              Remembered it? <Link to="/login" className="login-signup-link">Back to login</Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}

export default ForgotPasswordPage;
