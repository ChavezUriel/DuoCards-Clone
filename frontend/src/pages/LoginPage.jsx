import { Link } from 'react-router-dom';

function LoginPage() {
  return (
    <section className="panel auth-panel">
      <div className="auth-panel__content">
        <h1>Iniciar sesión</h1>
        <p className="hero-copy">Accede a tu cuenta para sincronizar tus decks y progreso.</p>

        <form className="login-form" onSubmit={(e) => e.preventDefault()}>
          <label className="login-field">
            <span className="eyebrow">Correo electrónico</span>
            <input type="email" name="email" placeholder="tu@ejemplo.com" aria-label="Correo electrónico" />
          </label>

          <label className="login-field">
            <span className="eyebrow">Contraseña</span>
            <input type="password" name="password" placeholder="Contraseña" aria-label="Contraseña" />
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
            <button className="button button--primary" type="submit">Iniciar sesión</button>
            <Link to="/" className="button button--secondary">Volver</Link>
          </div>
        </form>
      </div>
    </section>
  );
}

export default LoginPage;
