import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { updatePassword } from '../api';

function ResetPasswordPage() {
  const [ready, setReady] = useState(false);
  const [hasRecoverySession, setHasRecoverySession] = useState(false);
  const [formData, setFormData] = useState({ password: '', confirmPassword: '' });
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    // supabase-js parses the recovery token from the URL and establishes a
    // short-lived session (detectSessionInUrl + PASSWORD_RECOVERY event).
    supabase.auth.getSession().then(({ data }) => {
      setHasRecoverySession(Boolean(data.session));
      setReady(true);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY' || session) {
        setHasRecoverySession(true);
        setReady(true);
      }
    });

    return () => subscription.subscription.unsubscribe();
  }, []);

  const handleChange = (e) => {
    setFormData(prev => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (formData.password !== formData.confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    try {
      setIsLoading(true);
      setError('');
      await updatePassword(formData.password);
      setDone(true);
    } catch (err) {
      setError(err.message || 'Could not update your password');
    } finally {
      setIsLoading(false);
    }
  };

  let body;
  if (!ready) {
    body = <p className="hero-copy">Validating your reset link…</p>;
  } else if (done) {
    body = (
      <>
        <p className="hero-copy">Your password has been updated. You're signed in.</p>
        <div className="login-actions">
          <Link to="/" className="button button--primary">Go to your decks</Link>
        </div>
      </>
    );
  } else if (!hasRecoverySession) {
    body = (
      <>
        <p className="hero-copy">This reset link is invalid or has expired.</p>
        <div className="login-actions">
          <Link to="/forgot-password" className="button button--primary">Request a new link</Link>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <p className="hero-copy">Choose a new password for your account.</p>
        {error && <div className="deck-grid__status deck-grid__status--error">{error}</div>}
        <form className="login-form" onSubmit={handleSubmit}>
          <label className="login-field">
            <span className="eyebrow">New Password</span>
            <input type="password" name="password" value={formData.password} onChange={handleChange} placeholder="Minimum 6 characters" aria-label="New password" required minLength="6" />
          </label>
          <label className="login-field">
            <span className="eyebrow">Confirm Password</span>
            <input type="password" name="confirmPassword" value={formData.confirmPassword} onChange={handleChange} placeholder="Repeat your new password" aria-label="Confirm new password" required minLength="6" />
          </label>
          <div className="login-actions">
            <button className="button button--primary" type="submit" disabled={isLoading}>
              {isLoading ? 'Updating...' : 'Update password'}
            </button>
          </div>
        </form>
      </>
    );
  }

  return (
    <section className="panel auth-panel">
      <div className="auth-panel__content">
        <h1>Set a new password</h1>
        {body}
      </div>
    </section>
  );
}

export default ResetPasswordPage;
