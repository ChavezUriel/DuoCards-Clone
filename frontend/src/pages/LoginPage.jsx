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
      setError(err.message || 'Error al iniciar sesión');
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
        <h1>Iniciar sesión</h1>
        <p className="hero-copy">Accede a tu cuenta para sincronizar tus decks y progreso.</p>

        {error && <div className="deck-grid__status deck-grid__status--error">{error}</div>}

        <form className="login-form" onSubmit={handleSubmit}>
          <label className="login-field">
            <span className="eyebrow">Correo electrónico</span>
            <input type="email" name="email" value={formData.email} onChange={handleChange} placeholder="tu@ejemplo.com" aria-label="Correo electrónico" required />
          </label>

          <label className="login-field">
            <span className="eyebrow">Contraseña</span>
            <input type="password" name="password" value={formData.password} onChange={handleChange} placeholder="Contraseña" aria-label="Contraseña" required />
          </label>

          <div className="login-row">
            <label className="login-remember">
              <input type="checkbox" name="remember" />
              <span>Recordarme</span>
            </label>

            <Link to="/" className="back-link">¿Olvidaste tu contraseña?</Link>
          </div>

          <div style={{ marginTop: '0.5rem', fontSize: '0.9rem', color: '#6b7058' }}>
            ¿No tienes cuenta? <Link to="/register" className="back-link" style={{ display: 'inline' }}>Regístrate ahora</Link>
          </div>

          <div className="login-actions">
            <button className="button button--primary" type="submit" disabled={isLoading}>
              {isLoading ? 'Iniciando...' : 'Iniciar sesión'}
            </button>
            <Link to="/" className="button button--secondary">Volver</Link>
          </div>
        </form>
      </div>
    </section>
  );
}

export default LoginPage;
