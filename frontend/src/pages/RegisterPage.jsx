import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { register, loginWithGoogle } from '../api';
import AuthBrandPanel from '../components/AuthBrandPanel';

function RegisterPage() {
  const navigate = useNavigate();
  const [formData, setFormData] = useState({ name: '', email: '', password: '', confirmPassword: '' });
  const [error, setError] = useState('');
  const [confirmEmail, setConfirmEmail] = useState('');
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
      const data = await register(formData.email, formData.name, formData.password);
      if (data.session) {
        // Email confirmation is disabled — the user is signed in immediately.
        navigate('/');
      } else {
        // Email confirmation is enabled — swap the form for a confirmation screen.
        setConfirmEmail(formData.email);
      }
    } catch (err) {
      setError(err.message || 'Registration failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogle = async () => {
    try {
      setError('');
      await loginWithGoogle();
    } catch (err) {
      setError(err.message || 'Google sign-in failed');
    }
  };

  const handleChange = (e) => {
    setFormData(prev => ({ ...prev, [e.target.name]: e.target.value }));
  };

  return (
    <div className="login-split">
      <AuthBrandPanel
        quote='"Begin quietly. A few words today become a language by the river of time."'
        tagline="A QUIET WAY TO LEARN ENGLISH"
      />

      <div className="login-split__right">
        {confirmEmail ? (
          <>
            <h1 className="login-heading">Check your inbox</h1>
            <p className="login-body">
              Your account is ready. We've sent a confirmation link to{' '}
              <strong>{confirmEmail}</strong>. Open it to verify your address, then sign in.
            </p>
            <Link to="/login" className="login-cta">Go to login</Link>
          </>
        ) : (
        <>
        <h1 className="login-heading">Create your account</h1>
        <p className="login-subheading">Save your progress and pick up on any device.</p>

        {error && <p className="login-error">{error}</p>}

        <form onSubmit={handleSubmit} className="login-form-heron">
          <label className="login-label-mono" htmlFor="register-name">FULL NAME</label>
          <input
            id="register-name"
            type="text"
            name="name"
            value={formData.name}
            onChange={handleChange}
            placeholder="Your name"
            className="login-input-heron"
            required
          />

          <label className="login-label-mono" htmlFor="register-email">EMAIL</label>
          <input
            id="register-email"
            type="email"
            name="email"
            value={formData.email}
            onChange={handleChange}
            placeholder="you@email.com"
            className="login-input-heron"
            required
          />

          <label className="login-label-mono" htmlFor="register-password">PASSWORD</label>
          <input
            id="register-password"
            type="password"
            name="password"
            value={formData.password}
            onChange={handleChange}
            placeholder="Minimum 6 characters"
            className="login-input-heron"
            required
            minLength="6"
          />

          <label className="login-label-mono" htmlFor="register-confirm">CONFIRM PASSWORD</label>
          <input
            id="register-confirm"
            type="password"
            name="confirmPassword"
            value={formData.confirmPassword}
            onChange={handleChange}
            placeholder="Repeat your password"
            className="login-input-heron"
            required
            minLength="6"
          />

          <button type="submit" className="login-cta" disabled={isLoading}>
            {isLoading ? 'Creating account…' : 'Create account'}
          </button>
        </form>

        <div className="auth-divider"><span>or</span></div>

        <button type="button" onClick={handleGoogle} className="button button--google">
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="#4285F4" d="M22.5 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.9a5 5 0 0 1-2.2 3.3v2.7h3.6c2.1-1.9 3.2-4.8 3.2-7.8Z" />
            <path fill="#34A853" d="M12 23c2.9 0 5.4-1 7.2-2.6l-3.6-2.7c-1 .7-2.3 1.1-3.6 1.1-2.8 0-5.1-1.9-6-4.4H2.3v2.8A11 11 0 0 0 12 23Z" />
            <path fill="#FBBC05" d="M6 14.4a6.6 6.6 0 0 1 0-4.2V7.4H2.3a11 11 0 0 0 0 9.8L6 14.4Z" />
            <path fill="#EA4335" d="M12 5.6c1.6 0 3 .5 4.1 1.6l3.1-3.1A11 11 0 0 0 2.3 7.4L6 10.2c.9-2.6 3.2-4.6 6-4.6Z" />
          </svg>
          Continue with Google
        </button>

        <p className="login-signup-prompt">
          Already have an account? <Link to="/login" className="login-signup-link">Sign in</Link>
        </p>
        </>
        )}
      </div>
    </div>
  );
}

export default RegisterPage;
