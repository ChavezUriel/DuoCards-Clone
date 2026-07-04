import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import {
  deleteAccount,
  exportAccountData,
  fetchMe,
  fetchUserIdentities,
  linkGoogleIdentity,
  requestPasswordReset,
  unlinkUserIdentity,
  updateNickname,
  updatePassword,
} from '../api';
import GoogleButton from '../components/GoogleButton';
import {
  isNotificationSupported,
  loadReminderSettings,
  requestNotificationPermission,
  saveReminderSettings,
} from '../notifications';
import { loadPracticeSettings, savePracticeSettings } from '../practiceSettings';

// OAuth failures (e.g. Google linking) come back appended to the redirect URL.
function readOAuthErrorFromUrl() {
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const searchParams = new URLSearchParams(window.location.search);
  return hashParams.get('error_description') || searchParams.get('error_description') || '';
}

function AccountSection({ me, onNicknameSaved }) {
  const [nickname, setNickname] = useState(me.full_name);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');

  const trimmedNickname = nickname.trim();
  const isDirty = trimmedNickname !== me.full_name;

  async function handleSubmit(event) {
    event.preventDefault();
    if (!trimmedNickname || !isDirty) {
      return;
    }
    setStatus('saving');
    setError('');
    try {
      await updateNickname(trimmedNickname);
      onNicknameSaved(trimmedNickname);
      setStatus('saved');
    } catch (saveError) {
      setError(saveError.message);
      setStatus('error');
    }
  }

  const memberSince = me.created_at
    ? new Date(me.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'long' })
    : null;

  return (
    <section className="panel st-section" aria-labelledby="st-account-title">
      <div>
        <h2 className="st-section__title" id="st-account-title">Account</h2>
        <p className="st-section__hint">
          Signed in as <strong>{me.email}</strong>
          {memberSince ? ` · member since ${memberSince}` : ''}.
        </p>
      </div>

      <form className="st-form" onSubmit={handleSubmit}>
        <label className="st-field">
          <span className="st-field__label">Nickname</span>
          <input
            className="st-input"
            type="text"
            value={nickname}
            onChange={(event) => {
              setNickname(event.target.value);
              setStatus('idle');
            }}
            maxLength={60}
            autoComplete="nickname"
            required
          />
        </label>
        <div className="st-actions">
          <button
            type="submit"
            className="button button--primary"
            disabled={status === 'saving' || !trimmedNickname || !isDirty}
          >
            {status === 'saving' ? 'Saving…' : 'Save nickname'}
          </button>
          {status === 'saved' ? <span className="st-success">Nickname updated.</span> : null}
          {status === 'error' ? <span className="st-error">{error}</span> : null}
        </div>
      </form>
    </section>
  );
}

function SecuritySection({ me, identities, onIdentitiesChanged }) {
  const googleIdentity = identities.find((identity) => identity.provider === 'google');
  const emailIdentity = identities.find((identity) => identity.provider === 'email');
  const hasPassword = Boolean(emailIdentity);
  const canUnlinkGoogle = Boolean(googleIdentity) && identities.length > 1;

  const [linkError, setLinkError] = useState('');
  const [isLinking, setIsLinking] = useState(false);
  const [isUnlinking, setIsUnlinking] = useState(false);

  const [passwordForm, setPasswordForm] = useState({ password: '', confirmPassword: '' });
  const [passwordStatus, setPasswordStatus] = useState('idle');
  const [passwordError, setPasswordError] = useState('');
  const [resetStatus, setResetStatus] = useState('idle');

  async function handleLinkGoogle() {
    setLinkError('');
    setIsLinking(true);
    try {
      // Redirects to Google on success, so we normally never reach the end.
      await linkGoogleIdentity();
    } catch (linkFailure) {
      setLinkError(linkFailure.message);
      setIsLinking(false);
    }
  }

  async function handleUnlinkGoogle() {
    setLinkError('');
    setIsUnlinking(true);
    try {
      await unlinkUserIdentity(googleIdentity);
      await onIdentitiesChanged();
    } catch (unlinkFailure) {
      setLinkError(unlinkFailure.message);
    } finally {
      setIsUnlinking(false);
    }
  }

  async function handlePasswordSubmit(event) {
    event.preventDefault();
    if (passwordForm.password !== passwordForm.confirmPassword) {
      setPasswordError('Passwords do not match');
      setPasswordStatus('error');
      return;
    }
    setPasswordStatus('saving');
    setPasswordError('');
    try {
      await updatePassword(passwordForm.password);
      setPasswordForm({ password: '', confirmPassword: '' });
      setPasswordStatus('saved');
      // A Google-only user gains an email identity once a password exists.
      await onIdentitiesChanged();
    } catch (updateFailure) {
      setPasswordError(updateFailure.message);
      setPasswordStatus('error');
    }
  }

  async function handleSendResetEmail() {
    setResetStatus('sending');
    try {
      await requestPasswordReset(me.email);
      setResetStatus('sent');
    } catch {
      setResetStatus('error');
    }
  }

  return (
    <section className="panel st-section" aria-labelledby="st-security-title">
      <div>
        <h2 className="st-section__title" id="st-security-title">Sign-in &amp; security</h2>
        <p className="st-section__hint">Manage the ways you sign in to your account.</p>
      </div>

      <ul className="st-identity-list">
        <li className="st-identity">
          <div className="st-identity__info">
            <span className="st-identity__name">Email &amp; password</span>
            <span className="st-identity__meta">
              {hasPassword ? me.email : 'Not set up — add a password below'}
            </span>
          </div>
          {hasPassword
            ? <span className="st-chip">Active</span>
            : <span className="st-chip st-chip--muted">Off</span>}
        </li>
        <li className="st-identity">
          <div className="st-identity__info">
            <span className="st-identity__name">Google</span>
            <span className="st-identity__meta">
              {googleIdentity ? (googleIdentity.identity_data?.email || 'Connected') : 'Not linked'}
            </span>
          </div>
          {googleIdentity ? (
            <div className="st-actions">
              <span className="st-chip">Linked</span>
              <button
                type="button"
                className="button button--secondary st-button--compact"
                onClick={handleUnlinkGoogle}
                disabled={!canUnlinkGoogle || isUnlinking}
              >
                {isUnlinking ? 'Unlinking…' : 'Unlink'}
              </button>
            </div>
          ) : (
            <GoogleButton onClick={handleLinkGoogle} label={isLinking ? 'Redirecting…' : 'Link Google'} />
          )}
        </li>
      </ul>
      {googleIdentity && !canUnlinkGoogle ? (
        <p className="st-note">Google is your only way to sign in. Set a password below before unlinking it.</p>
      ) : null}
      {linkError ? <p className="st-error">{linkError}</p> : null}

      <form className="st-form" onSubmit={handlePasswordSubmit}>
        <div>
          <h3 className="st-subtitle">{hasPassword ? 'Change password' : 'Set a password'}</h3>
          {!hasPassword ? (
            <p className="st-section__hint">
              You sign in with Google. Adding a password also lets you sign in with your email.
            </p>
          ) : null}
        </div>
        <div className="st-form__grid">
          <label className="st-field">
            <span className="st-field__label">New password</span>
            <input
              className="st-input"
              type="password"
              value={passwordForm.password}
              onChange={(event) => setPasswordForm((current) => ({ ...current, password: event.target.value }))}
              placeholder="Minimum 6 characters"
              minLength={6}
              autoComplete="new-password"
              required
            />
          </label>
          <label className="st-field">
            <span className="st-field__label">Confirm password</span>
            <input
              className="st-input"
              type="password"
              value={passwordForm.confirmPassword}
              onChange={(event) => setPasswordForm((current) => ({ ...current, confirmPassword: event.target.value }))}
              placeholder="Repeat the new password"
              minLength={6}
              autoComplete="new-password"
              required
            />
          </label>
        </div>
        <div className="st-actions">
          <button type="submit" className="button button--primary" disabled={passwordStatus === 'saving'}>
            {passwordStatus === 'saving' ? 'Updating…' : hasPassword ? 'Update password' : 'Set password'}
          </button>
          <button
            type="button"
            className="st-link-button"
            onClick={handleSendResetEmail}
            disabled={resetStatus === 'sending' || resetStatus === 'sent'}
          >
            {resetStatus === 'sent'
              ? `Reset link sent to ${me.email}`
              : resetStatus === 'sending'
                ? 'Sending…'
                : 'Or email me a reset link'}
          </button>
        </div>
        {passwordStatus === 'saved' ? <p className="st-success">Password updated.</p> : null}
        {passwordStatus === 'error' ? <p className="st-error">{passwordError}</p> : null}
        {resetStatus === 'error' ? <p className="st-error">Could not send the reset email. Try again.</p> : null}
      </form>
    </section>
  );
}

function NotificationsSection() {
  const supported = isNotificationSupported();
  const [reminderSettings, setReminderSettings] = useState(() => loadReminderSettings());
  const [permission, setPermission] = useState(supported ? Notification.permission : 'unsupported');

  async function handleToggleReminder() {
    if (reminderSettings.enabled) {
      const nextSettings = { ...reminderSettings, enabled: false };
      setReminderSettings(nextSettings);
      saveReminderSettings(nextSettings);
      return;
    }

    const nextPermission = await requestNotificationPermission();
    setPermission(nextPermission);
    if (nextPermission !== 'granted') {
      return;
    }

    const nextSettings = { ...reminderSettings, enabled: true };
    setReminderSettings(nextSettings);
    saveReminderSettings(nextSettings);
  }

  return (
    <section className="panel st-section" aria-labelledby="st-notifications-title">
      <div>
        <h2 className="st-section__title" id="st-notifications-title">Notifications</h2>
        <p className="st-section__hint">More notification options are on the way — this is the first one.</p>
      </div>

      <div className="st-row">
        <div className="st-row__info">
          <span className="st-row__label">Daily review reminder</span>
          <span className="st-row__meta">
            One browser notification per day when cards are due. It only fires while the app is open in a tab.
          </span>
        </div>
        <label className="st-switch">
          <input
            type="checkbox"
            checked={reminderSettings.enabled}
            onChange={handleToggleReminder}
            disabled={!supported}
            aria-label="Toggle daily review reminder"
          />
          <span className="st-switch__track" aria-hidden="true" />
        </label>
      </div>

      {!supported ? (
        <p className="st-note">This browser does not support notifications.</p>
      ) : null}
      {supported && permission === 'denied' ? (
        <p className="st-note">
          Notifications are blocked for this site. Allow them in your browser's site settings, then flip the toggle again.
        </p>
      ) : null}
    </section>
  );
}

const MINIGAME_FREQUENCY_OPTIONS = [
  { value: 'off', label: 'Off — classic flashcard only' },
  { value: 'light', label: 'Light' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'heavy', label: 'Heavy' },
];

// Presentation metadata for each game key in settings.minigames.games. `counts`
// drives the Tier-A "Counts toward scheduling" vs practice-only badge. Keys added
// here as each rollout phase ships a game; unknown keys fall back to the raw key.
const MINIGAME_META = {
  type_translation: {
    label: 'Type the translation',
    description: 'Type the English for the Spanish prompt. Correct or wrong, it grades the card just like a swipe.',
    counts: true,
  },
};

function MinigamesSection() {
  const [settings, setSettings] = useState(() => loadPracticeSettings());
  const minigames = settings.minigames;
  const gameEntries = Object.entries(minigames.games ?? {});

  // Persist the whole practice-settings blob so the other practice settings
  // (block size, interleaving, …) survive alongside the minigame changes.
  function persistMinigames(nextMinigames) {
    setSettings((current) => {
      const nextSettings = { ...current, minigames: nextMinigames };
      savePracticeSettings(nextSettings);
      return nextSettings;
    });
  }

  return (
    <section className="panel st-section" aria-labelledby="st-minigames-title">
      <div>
        <h2 className="st-section__title" id="st-minigames-title">Minigames</h2>
        <p className="st-section__hint">
          Vary how you answer during Smart Practice. Games marked <strong>“Counts toward scheduling”</strong> can change
          when a card is next due; <strong>“Practice only”</strong> games never touch your schedule.
        </p>
      </div>

      <div className="st-row">
        <div className="st-row__info">
          <span className="st-row__label">Enable minigames</span>
          <span className="st-row__meta">
            When off, Smart Practice uses the classic flashcard for every card — exactly as it works today.
          </span>
        </div>
        <label className="st-switch">
          <input
            type="checkbox"
            checked={minigames.enabled}
            onChange={() => persistMinigames({ ...minigames, enabled: !minigames.enabled })}
            aria-label="Toggle minigames"
          />
          <span className="st-switch__track" aria-hidden="true" />
        </label>
      </div>

      <label className="st-field">
        <span className="st-field__label">How often games appear</span>
        <select
          className="st-input"
          value={minigames.frequency}
          onChange={(event) => persistMinigames({ ...minigames, frequency: event.target.value })}
          disabled={!minigames.enabled}
        >
          {MINIGAME_FREQUENCY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>

      <div>
        <h3 className="st-subtitle">Games</h3>
        {gameEntries.length === 0 ? (
          <p className="st-note">
            No minigames yet — they’ll appear here as they’re added, each labeled with whether it counts toward
            scheduling. Your preferences are saved and ready.
          </p>
        ) : (
          <ul className={`st-minigame-list${minigames.enabled ? '' : ' st-minigame-list--disabled'}`}>
            {gameEntries.map(([key, isOn]) => {
              const meta = MINIGAME_META[key] ?? { label: key, description: '', counts: false };
              return (
                <li className="st-row" key={key}>
                  <div className="st-row__info">
                    <span className="st-row__label">{meta.label}</span>
                    {meta.description ? <span className="st-row__meta">{meta.description}</span> : null}
                    <span className={`st-chip st-minigame-badge${meta.counts ? '' : ' st-chip--muted'}`}>
                      {meta.counts ? 'Counts toward scheduling' : 'Practice only'}
                    </span>
                  </div>
                  <label className="st-switch">
                    <input
                      type="checkbox"
                      checked={Boolean(isOn)}
                      disabled={!minigames.enabled}
                      onChange={() =>
                        persistMinigames({
                          ...minigames,
                          games: { ...minigames.games, [key]: !isOn },
                        })
                      }
                      aria-label={`Toggle ${meta.label}`}
                    />
                    <span className="st-switch__track" aria-hidden="true" />
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

function DataSection() {
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');

  async function handleExport() {
    setStatus('working');
    setError('');
    try {
      const data = await exportAccountData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `duocards-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setStatus('done');
    } catch (exportError) {
      setError(exportError.message);
      setStatus('error');
    }
  }

  return (
    <section className="panel st-section" aria-labelledby="st-data-title">
      <div>
        <h2 className="st-section__title" id="st-data-title">Your data</h2>
        <p className="st-section__hint">
          Download a copy of your decks, cards and learning progress as a JSON file.
        </p>
      </div>
      <div className="st-actions">
        <button
          type="button"
          className="button button--secondary"
          onClick={handleExport}
          disabled={status === 'working'}
        >
          {status === 'working' ? 'Preparing export…' : 'Export my data'}
        </button>
        {status === 'done' ? <span className="st-success">Export downloaded.</span> : null}
        {status === 'error' ? <span className="st-error">{error}</span> : null}
      </div>
    </section>
  );
}

function DangerSection({ email }) {
  const navigate = useNavigate();
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');

  const isConfirmed = confirmText.trim().toUpperCase() === 'DELETE';

  async function handleDeleteAccount() {
    setStatus('deleting');
    setError('');
    try {
      await deleteAccount();
      try {
        // The server session died with the account; only clear local state.
        await supabase.auth.signOut({ scope: 'local' });
      } catch {
        /* already signed out */
      }
      navigate('/login', { replace: true });
    } catch (deleteError) {
      setError(deleteError.message);
      setStatus('idle');
    }
  }

  return (
    <section className="panel st-section st-section--danger" aria-labelledby="st-danger-title">
      <div>
        <h2 className="st-section__title st-section__title--danger" id="st-danger-title">Danger zone</h2>
        <p className="st-section__hint">
          Deleting your account removes your profile, decks, cards and all learning progress
          for <strong>{email}</strong>. This cannot be undone — consider exporting your data first.
        </p>
      </div>

      {isConfirmOpen ? (
        <div className="st-confirm">
          <label className="st-field">
            <span className="st-field__label">Type DELETE to confirm</span>
            <input
              className="st-input"
              type="text"
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value)}
              placeholder="DELETE"
              autoComplete="off"
            />
          </label>
          <div className="st-actions">
            <button
              type="button"
              className="button button--danger"
              onClick={handleDeleteAccount}
              disabled={!isConfirmed || status === 'deleting'}
            >
              {status === 'deleting' ? 'Deleting…' : 'Permanently delete my account'}
            </button>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => {
                setIsConfirmOpen(false);
                setConfirmText('');
                setError('');
              }}
              disabled={status === 'deleting'}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="st-actions">
          <button type="button" className="button button--danger" onClick={() => setIsConfirmOpen(true)}>
            Delete account…
          </button>
        </div>
      )}
      {error ? <p className="st-error">{error}</p> : null}
    </section>
  );
}

function SettingsPage() {
  const [me, setMe] = useState(null);
  const [identities, setIdentities] = useState([]);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  // Read once per mount; the params disappear on the next in-app navigation.
  const [oauthError] = useState(readOAuthErrorFromUrl);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [nextMe, nextIdentities] = await Promise.all([fetchMe(), fetchUserIdentities()]);
        if (!cancelled) {
          setMe(nextMe);
          setIdentities(nextIdentities);
          setStatus('ready');
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError.message);
          setStatus('error');
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function refreshIdentities() {
    setIdentities(await fetchUserIdentities());
  }

  if (status === 'loading') {
    return <p className="h-empty-state">Loading your settings…</p>;
  }

  if (status === 'error') {
    return <p className="h-empty-state h-empty-state--error">Unable to load settings: {error}</p>;
  }

  return (
    <div className="st-page">
      <div className="st-header">
        <p className="st-kicker">YOUR ACCOUNT</p>
        <h1 className="st-header__title">Settings</h1>
      </div>

      {oauthError ? (
        <p className="st-banner st-banner--error">Sign-in linking failed: {oauthError}</p>
      ) : null}

      <AccountSection
        me={me}
        onNicknameSaved={(name) => setMe((current) => ({ ...current, full_name: name }))}
      />
      <SecuritySection me={me} identities={identities} onIdentitiesChanged={refreshIdentities} />
      <NotificationsSection />
      <MinigamesSection />
      <DataSection />
      <DangerSection email={me.email} />
    </div>
  );
}

export default SettingsPage;
