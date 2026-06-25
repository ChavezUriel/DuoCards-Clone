import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { updatePassword } from '../api';
import AuthBrandPanel from '../components/AuthBrandPanel';

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
    body = (
      <>
        <h1 className="login-heading">One moment</h1>
        <p className="login-body">Validating your reset link…</p>
      </>
    );
  } else if (done) {
    body = (
      <>
        <h1 className="login-heading">Password updated</h1>
        <p className="login-body">You're signed in and ready to go.</p>
        <Link to="/" className="login-cta">Go to your decks</Link>
      </>
    );
  } else if (!hasRecoverySession) {
    body = (
      <>
        <h1 className="login-heading">Link expired</h1>
        <p className="login-body">This reset link is invalid or has expired.</p>
        <Link to="/forgot-password" className="login-cta">Request a new link</Link>
      </>
    );
  } else {
    body = (
      <>
        <h1 className="login-heading">Set a new password</h1>
        <p className="login-subheading">Choose a new password for your account.</p>

        {error && <p className="login-error">{error}</p>}

        <form onSubmit={handleSubmit} className="login-form-heron">
          <label className="login-label-mono" htmlFor="reset-password">NEW PASSWORD</label>
          <input
            id="reset-password"
            type="password"
            name="password"
            value={formData.password}
            onChange={handleChange}
            placeholder="Minimum 6 characters"
            className="login-input-heron"
            required
            minLength="6"
          />

          <label className="login-label-mono" htmlFor="reset-confirm">CONFIRM PASSWORD</label>
          <input
            id="reset-confirm"
            type="password"
            name="confirmPassword"
            value={formData.confirmPassword}
            onChange={handleChange}
            placeholder="Repeat your new password"
            className="login-input-heron"
            required
            minLength="6"
          />

          <button type="submit" className="login-cta" disabled={isLoading}>
            {isLoading ? 'Updating…' : 'Update password'}
          </button>
        </form>
      </>
    );
  }

  return (
    <div className="login-split">
      <AuthBrandPanel
        quote='"A fresh start is just another still morning by the water."'
        tagline="A QUIET WAY TO LEARN ENGLISH"
      />

      <div className="login-split__right">
        {body}
      </div>
    </div>
  );
}

export default ResetPasswordPage;
