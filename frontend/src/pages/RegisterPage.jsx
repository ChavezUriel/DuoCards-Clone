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
      setError('Las contraseñas no coinciden');
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
      setError(err.message || 'Error al registrar la cuenta');
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
        <h1>Crea tu cuenta</h1>
        <p className="hero-copy">Regístrate para guardar tu progreso y acceder a tus decks desde cualquier dispositivo.</p>

        {error && <div className="deck-grid__status deck-grid__status--error">{error}</div>}

        <form className="login-form" onSubmit={handleSubmit}>
          <label className="login-field">
            <span className="eyebrow">Nombre completo</span>
            <input type="text" name="name" value={formData.name} onChange={handleChange} placeholder="Tu nombre" aria-label="Nombre completo" required />
          </label>

          <label className="login-field">
            <span className="eyebrow">Correo electrónico</span>
            <input type="email" name="email" value={formData.email} onChange={handleChange} placeholder="tu@ejemplo.com" aria-label="Correo electrónico" required />
          </label>

          <label className="login-field">
            <span className="eyebrow">Contraseña</span>
            <input type="password" name="password" value={formData.password} onChange={handleChange} placeholder="Mínimo 6 caracteres" aria-label="Contraseña" required minLength="6" />
          </label>

          <label className="login-field">
            <span className="eyebrow">Confirmar contraseña</span>
            <input type="password" name="confirmPassword" value={formData.confirmPassword} onChange={handleChange} placeholder="Repite tu contraseña" aria-label="Confirmar contraseña" required minLength="6" />
          </label>

          <div className="login-row">
            <p style={{ fontSize: '0.9rem', color: '#6b7058' }}>
              ¿Ya tienes cuenta? <Link to="/login" className="back-link" style={{ display: 'inline' }}>Inicia sesión</Link>
            </p>
          </div>

          <div className="login-actions">
            <button className="button button--primary" type="submit" disabled={isLoading}>
              {isLoading ? 'Registrando...' : 'Registrarse'}
            </button>
            <Link to="/" className="button button--secondary">Volver</Link>
          </div>
        </form>
      </div>
    </section>
  );
}

export default RegisterPage;
