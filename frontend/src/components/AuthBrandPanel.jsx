function AuthBrandPanel({
  quote = '"Still water, sharp mind. The words come when you stop chasing them."',
  tagline = 'A QUIET WAY TO LEARN ENGLISH',
}) {
  return (
    <div className="login-split__left">
      <div className="login-brand">
        <div className="login-brand__icon">
          <div className="login-brand__diamond" />
        </div>
        <span className="login-brand__name">Heron</span>
      </div>
      <div>
        <p className="login-quote">{quote}</p>
        <p className="login-tagline">{tagline}</p>
      </div>
    </div>
  );
}

export default AuthBrandPanel;
