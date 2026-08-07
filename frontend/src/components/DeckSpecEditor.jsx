import { useEffect, useRef, useState } from 'react';
import {
  CARD_COUNT_RANGE,
  DIFFICULTIES,
  SPEC_TEMPLATE_YAML,
  specFromYaml,
  specToYaml,
} from '../ai/deckSpec';

// Two views of one spec: a form for people who want fields, and a YAML document
// for people who want a file they can keep, diff and re-run. Switching tabs
// never loses work — the YAML is regenerated from the spec on entry, and valid
// YAML is pushed back into the spec on every keystroke.

function SectionEditor({ sections, onChange }) {
  function updateSection(index, patch) {
    onChange(sections.map((section, i) => (i === index ? { ...section, ...patch } : section)));
  }

  return (
    <div className="ai-sections">
      {sections.map((section, index) => (
        <div className="ai-section-row" key={index}>
          <div className="ai-section-row__head">
            <input
              className="st-input ai-section-row__name"
              value={section.name}
              onChange={(event) => updateSection(index, { name: event.target.value })}
              placeholder="Section name"
              aria-label={`Section ${index + 1} name`}
            />
            <label className="ai-section-row__count">
              <span className="sr-only">Cards in section {index + 1}</span>
              <input
                className="st-input"
                type="number"
                min="1"
                max={CARD_COUNT_RANGE.max}
                value={section.target_card_count}
                onChange={(event) => updateSection(index, { target_card_count: Number(event.target.value) })}
              />
              <span aria-hidden="true">cards</span>
            </label>
            <button
              type="button"
              className="ai-icon-button"
              onClick={() => onChange(sections.filter((_, i) => i !== index))}
              aria-label={`Remove section ${section.name || index + 1}`}
            >
              ×
            </button>
          </div>
          <input
            className="st-input"
            value={section.communicative_goal}
            onChange={(event) => updateSection(index, { communicative_goal: event.target.value })}
            placeholder="What a learner can do after this section"
            aria-label={`Section ${index + 1} goal`}
          />
          <input
            className="st-input"
            value={section.lexical_focus.join(', ')}
            onChange={(event) => updateSection(index, {
              lexical_focus: event.target.value.split(',').map((word) => word.trim()).filter(Boolean),
            })}
            placeholder="Keywords, comma separated"
            aria-label={`Section ${index + 1} keywords`}
          />
        </div>
      ))}
      <button
        type="button"
        className="button button--secondary st-button--compact"
        onClick={() => onChange([...sections, { name: '', communicative_goal: '', lexical_focus: [], target_card_count: 5 }])}
      >
        Add section
      </button>
    </div>
  );
}

function SpecForm({ spec, onChange }) {
  // A shallow merge on purpose: normalizeSpec trims strings, and running it on
  // every keystroke would eat the space the moment the user types it, making
  // multi-word titles impossible. The spec is normalized where it matters —
  // when it is serialized to YAML and when a run starts.
  const patch = (fields) => onChange({ ...spec, ...fields });

  return (
    <div className="st-form">
      <div className="st-form__grid">
        <label className="st-field">
          <span className="st-field__label">Deck title</span>
          <input
            className="st-input"
            value={spec.title}
            onChange={(event) => patch({ title: event.target.value })}
            placeholder="Pharmacy Basics"
          />
        </label>
        <label className="st-field">
          <span className="st-field__label">Difficulty</span>
          <select
            className="st-input"
            value={spec.difficulty}
            onChange={(event) => patch({ difficulty: event.target.value })}
          >
            {DIFFICULTIES.map((level) => (
              <option key={level} value={level}>{level}</option>
            ))}
          </select>
        </label>
      </div>

      <label className="st-field">
        <span className="st-field__label">Description</span>
        <input
          className="st-input"
          value={spec.description}
          onChange={(event) => patch({ description: event.target.value })}
          placeholder="Practical English for buying medicine and describing simple symptoms."
        />
        <span className="ai-provider__hint">Shown on the deck card — and given to the model as deck context.</span>
      </label>

      <label className="st-field">
        <span className="st-field__label">Topic</span>
        <input
          className="st-input"
          value={spec.topic}
          onChange={(event) => patch({ topic: event.target.value })}
          placeholder="beginner English for pharmacy visits"
        />
      </label>

      <label className="st-field">
        <span className="st-field__label">Who is this for</span>
        <input
          className="st-input"
          value={spec.learner_profile}
          onChange={(event) => patch({ learner_profile: event.target.value })}
          placeholder="Spanish-speaking beginners who need practical English in a pharmacy"
        />
      </label>

      <label className="st-field">
        <span className="st-field__label">Notes for the model (optional)</span>
        <textarea
          className="st-input ai-textarea"
          rows={2}
          value={spec.generation_notes}
          onChange={(event) => patch({ generation_notes: event.target.value })}
          placeholder="Keep vocabulary concrete, high-frequency, and immediately useful. Latin American Spanish."
        />
      </label>

      <label className="st-field">
        <span className="st-field__label">Cards to generate — {spec.target_card_count}</span>
        <input
          className="ai-range"
          type="range"
          min={CARD_COUNT_RANGE.min}
          max={CARD_COUNT_RANGE.max}
          step="1"
          value={spec.target_card_count}
          onChange={(event) => patch({ target_card_count: Number(event.target.value) })}
        />
        <span className="ai-provider__hint">
          Each card costs roughly 12–18 model calls (draft, enrich, then the audits that gate quality).
        </span>
      </label>

      <div className="st-field">
        <span className="st-field__label">Sections</span>
        {spec.sections.length === 0 ? (
          <div className="ai-empty-inline">
            <p className="st-section__hint">
              The AI will plan 2–6 sections from the topic before drafting any words.
            </p>
            <button
              type="button"
              className="button button--secondary st-button--compact"
              onClick={() => patch({
                sections: [{ name: '', communicative_goal: '', lexical_focus: [], target_card_count: 5 }],
              })}
            >
              Plan them myself
            </button>
          </div>
        ) : (
          <>
            <SectionEditor sections={spec.sections} onChange={(sections) => patch({ sections })} />
            <button
              type="button"
              className="ai-link"
              onClick={() => patch({ sections: [] })}
            >
              Let the AI plan the sections instead
            </button>
          </>
        )}
      </div>

      <details className="ai-details">
        <summary>Quality gates and languages</summary>
        <div className="ai-details__body">
          <div className="st-row">
            <div className="st-row__info">
              <span className="st-row__label">Audit every example sentence</span>
              <span className="st-row__meta">
                A judge pass checks each example fits the deck and that the blanked answer is
                actually inferable. Rejected sentences are rewritten.
              </span>
            </div>
            <label className="st-switch">
              <input
                type="checkbox"
                checked={spec.quality.example_audit}
                onChange={(event) => patch({ quality: { ...spec.quality, example_audit: event.target.checked } })}
                aria-label="Audit every example sentence"
              />
              <span className="st-switch__track" aria-hidden="true" />
            </label>
          </div>
          <div className="st-row">
            <div className="st-row__info">
              <span className="st-row__label">Curated word-bank options</span>
              <span className="st-row__meta">
                Wrong answers written against this card's own sentences, then blind-solved so only
                the real answer fits the blank.
              </span>
            </div>
            <label className="st-switch">
              <input
                type="checkbox"
                checked={spec.quality.cloze_options}
                onChange={(event) => patch({
                  quality: {
                    ...spec.quality,
                    cloze_options: event.target.checked,
                    cloze_audit: event.target.checked && spec.quality.cloze_audit,
                  },
                })}
                aria-label="Curated word-bank options"
              />
              <span className="st-switch__track" aria-hidden="true" />
            </label>
          </div>
          <div className="st-row">
            <div className="st-row__info">
              <span className="st-row__label">Blind-solve the cloze options</span>
              <span className="st-row__meta">
                Costs one call per example sentence, and is what stops two options from both being
                right. Turning it off makes runs noticeably cheaper.
              </span>
            </div>
            <label className="st-switch">
              <input
                type="checkbox"
                checked={spec.quality.cloze_audit}
                disabled={!spec.quality.cloze_options}
                onChange={(event) => patch({ quality: { ...spec.quality, cloze_audit: event.target.checked } })}
                aria-label="Blind-solve the cloze options"
              />
              <span className="st-switch__track" aria-hidden="true" />
            </label>
          </div>
          <div className="st-form__grid">
            <label className="st-field">
              <span className="st-field__label">Repair attempts per failed audit</span>
              <input
                className="st-input"
                type="number"
                min="0"
                max="4"
                value={spec.quality.max_repairs}
                onChange={(event) => patch({ quality: { ...spec.quality, max_repairs: Number(event.target.value) } })}
              />
            </label>
            <label className="st-field">
              <span className="st-field__label">Prompt language</span>
              <input
                className="st-input"
                value={spec.language_from}
                onChange={(event) => patch({ language_from: event.target.value })}
                maxLength={5}
              />
            </label>
            <label className="st-field">
              <span className="st-field__label">Answer language</span>
              <input
                className="st-input"
                value={spec.language_to}
                onChange={(event) => patch({ language_to: event.target.value })}
                maxLength={5}
              />
            </label>
          </div>
        </div>
      </details>
    </div>
  );
}

function SpecYaml({ spec, onChange }) {
  const [text, setText] = useState(() => specToYaml(spec));
  const [error, setError] = useState(null);
  const fileInput = useRef(null);
  // Only re-seed the editor from the spec when the change came from elsewhere
  // (the form, the assistant), never while the user is typing YAML.
  const lastEmitted = useRef(text);

  useEffect(() => {
    const next = specToYaml(spec);
    if (next !== lastEmitted.current) {
      lastEmitted.current = next;
      setText(next);
      setError(null);
    }
  }, [spec]);

  function handleText(nextText) {
    setText(nextText);
    const { spec: parsed, error: parseError } = specFromYaml(nextText);
    setError(parseError);
    if (parsed) {
      lastEmitted.current = specToYaml(parsed);
      onChange(parsed);
    }
  }

  function handleDownload() {
    const blob = new Blob([text], { type: 'text/yaml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${(spec.title || 'deck').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.deck.yaml`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  async function handleUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    handleText(await file.text());
    event.target.value = '';
  }

  return (
    <div className="ai-yaml">
      <textarea
        className="st-input ai-yaml__editor"
        value={text}
        spellCheck="false"
        onChange={(event) => handleText(event.target.value)}
        aria-label="Deck specification as YAML"
        aria-invalid={Boolean(error)}
      />
      {error ? <p className="st-error">YAML error: {error}</p> : <p className="st-success">Valid — the form is in sync.</p>}
      <div className="st-actions">
        <button type="button" className="button button--secondary st-button--compact" onClick={handleDownload}>
          Download .yaml
        </button>
        <button
          type="button"
          className="button button--secondary st-button--compact"
          onClick={() => fileInput.current?.click()}
        >
          Load a file…
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".yaml,.yml,.json,text/yaml,application/json"
          className="sr-only"
          onChange={handleUpload}
        />
        <button type="button" className="ai-link" onClick={() => handleText(SPEC_TEMPLATE_YAML)}>
          Start from the annotated template
        </button>
      </div>
    </div>
  );
}

function DeckSpecEditor({ spec, onChange }) {
  const [tab, setTab] = useState('form');

  return (
    <div className="ai-spec-editor">
      <div className="ai-tabs" role="tablist" aria-label="Specification view">
        {[['form', 'Form'], ['yaml', 'YAML']].map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`ai-tab${tab === id ? ' ai-tab--active' : ''}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'form'
        ? <SpecForm spec={spec} onChange={onChange} />
        : <SpecYaml spec={spec} onChange={onChange} />}
    </div>
  );
}

export default DeckSpecEditor;
