import { Link } from 'react-router-dom';

function RegisterPage() {
  return (
    <section className="panel auth-panel">
      <div className="auth-panel__content">
        <h1>Crea tu cuenta</h1>
        <p className="hero-copy">Regístrate para guardar tu progreso y acceder a tus decks desde cualquier dispositivo.</p>

        <form className="login-form" onSubmit={(e) => e.preventDefault()}>
          <label className="login-field">
            <span className="eyebrow">Nombre completo</span>
            <input type="text" name="name" placeholder="Tu nombre" aria-label="Nombre completo" />
          </label>

          <label className="login-field">
            <span className="eyebrow">Correo electrónico</span>
            <input type="email" name="email" placeholder="tu@ejemplo.com" aria-label="Correo electrónico" />
          </label>

          <label className="login-field">
            <span className="eyebrow">Contraseña</span>
            <input type="password" name="password" placeholder="Mínimo 6 caracteres" aria-label="Contraseña" />
          </label>

          <label className="login-field">
            <span className="eyebrow">Confirmar contraseña</span>
            <input type="password" name="confirmPassword" placeholder="Repite tu contraseña" aria-label="Confirmar contraseña" />
          </label>

          <div className="login-row">
            <p style={{ fontSize: '0.9rem', color: '#6b7058' }}>
              ¿Ya tienes cuenta? <Link to="/login" className="back-link" style={{ display: 'inline' }}>Inicia sesión</Link>
            </p>
          </div>

          <div className="login-actions">
            <button className="button button--primary" type="submit">Registrarse</button>
            <Link to="/" className="button button--secondary">Volver</Link>
          </div>
        </form>
      </div>
    </section>
  );
}

export default RegisterPage;
