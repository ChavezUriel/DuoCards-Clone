# Market deck sync & change proposals

Migration: `supabase/migrations/0017_market_sync_and_proposals.sql`

Market decks (`decks.user_id IS NULL`) and personal copies (`user_id` set,
`base_deck_id` pointing at the market deck) already existed. This feature adds
three capabilities on top:

1. **Sync down** — a personal copy can see what changed in its market deck and
   selectively pull those updates.
2. **Change proposals** — a subscriber can propose their local card edits back
   to the market deck, GitHub-PR style; the maintainer approves or rejects.
3. **Ownership** — `decks.owner_id` designates a market deck's maintainer, who
   reviews proposals and can edit the market deck directly.

## 1. Data model

| Column | Purpose |
| --- | --- |
| `decks.owner_id` | Maintainer of a market deck (`null` = unmaintained, claimable). |
| `cards.base_card_id` | Which market card a personal card was cloned from. **No FK on purpose** — a deleted market card must stay detectable as "removed". |
| `cards.base_version_hash` | md5 of the market card's canonical content *as of the last sync*. |
| `cards.content_updated_at` | Bumped by trigger only when synced content actually changes (no-op saves and seed re-runs don't flag updates). |

Canonical content = the 12 fields sync moves between decks
(`_card_sync_content`): spanish/english text, section, part of speech,
definition, translations, collocations, synonyms, three example fields,
mnemonic. Explicitly **not** included: `is_enabled` (a per-user preference)
and generation bookkeeping.

### Three-hash classification (no timestamps needed)

For a personal card `u` linked to market card `b`:

| Condition | Meaning |
| --- | --- |
| `hash(b) ≠ u.base_version_hash` | The market changed since my last sync → **update available** |
| `hash(u) ≠ u.base_version_hash` | I edited my copy → **locally modified** (conflict flag when both hold) |
| `content(u) = content(b)` but hashes drifted | No real difference → silently **fast-forwarded** (re-baselined) |

Added = enabled market card with no linked personal card. Removed = linked
personal card whose market card is gone **or** disabled. Deck meta =
title/description differ (users can't edit those, so any difference is
upstream).

## 2. Sync flow

- `get_home_decks` now returns `updates_available` per deck; the home deck
  card shows an "N market updates" pill that opens `DeckSyncModal`.
- `get_deck_sync_status(deck_id)` → `{ added, changed, removed, deck_meta,
  total_updates }` with full card JSON on both sides for diff rendering.
- `apply_deck_sync(deck_id, changes)` applies a user-selected subset:
  - `add` → clones the market card in (with provenance + baseline hash),
  - `update` → overwrites content from market, re-baselines the hash,
  - `remove` → **disables** the personal card (never deletes; progress
    survives; refused while the market card is still live),
  - `deck_meta` → copies title/description.
- Conflicted updates (`locally_modified: true`) start **unchecked** in the
  modal so a sync never silently overwrites local work.
- The deck explorer of a linked personal deck has a "Market updates (N)"
  toolbar button for the same modal.

## 3. Change proposals

Tables `deck_change_proposals` (+ status open/approved/rejected/withdrawn) and
`deck_change_proposal_items` (`edit_card` / `add_card` / `remove_card`,
`payload`, `base_snapshot`, `source_card_id`). RLS: readable by proposer and
deck maintainer; all writes via SECURITY DEFINER RPCs.

- `get_deck_outgoing_changes(deck_id)` — cards **I edited** (`hash(u) ≠
  stored`) that still differ from the live market card; each flagged
  `already_proposed` when sitting in one of my open proposals.
- `create_deck_change_proposal(market_deck_id, message, user_card_ids)` — the
  server derives every item from the caller's real cards (payload can't be
  forged). A card without a market counterpart becomes an `add_card` item.
- `list_deck_proposals()` → `{ to_review, mine }` with per-item
  `current_base` + `is_stale` (market card changed since proposal).
- `resolve_deck_change_proposal(id, 'approve'|'reject', note)` — maintainer
  only. Approval writes items into the market deck (missing targets are
  skipped and reported). The content trigger then flags updates for every
  subscriber. Approving an `add_card` also links the proposer's own card to
  the new market card (via `source_card_id`) so it doesn't bounce back to them
  as "added".
- `withdraw_deck_change_proposal(id)` — proposer cancels an open proposal.
- The proposer's copy needs no sync after approval: content matches the new
  market state, and the fast-forward re-baselines the hash.

UI: "Propose to market (N)" in the deck explorer opens `ProposeChangesModal`;
`/market/proposals` (`ProposalsPage`) has **To review** / **My proposals**
tabs, per-field diffs, approve/reject with an optional note, withdraw, and a
"Decks you maintain" section with email-based ownership transfer.

## 4. Ownership

- `claim_market_deck(deck_id)` — first come, first served on unmaintained
  decks (market page and market deck explorer show "Become maintainer").
- `transfer_market_deck_ownership(deck_id, email)` — case-insensitive lookup
  in `auth.users`; only the current maintainer may transfer.
- Maintainers may call `update_card` / `update_card_visibility` on market
  decks (ownership check extended; everyone else is still rejected — note the
  `coalesce(...)` guards: a NULL comparison must not skip the raise).
- `get_market_decks` returns `owner_id/owner_name/is_owner/open_proposals/
  my_open_proposals`; `get_deck_preview` returns `is_market/is_owner/can_edit/
  base_deck_id/base_deck_available/updates_available/outgoing_changes/
  open_proposals` — the explorer hides edit controls when `can_edit` is false.

## 5. Backfill decisions (one-time, in 0017)

- Existing personal cards are linked to market cards by normalized
  `spanish_text`, only when the match is unambiguous in both directions.
- `base_version_hash` is seeded from the **user card's own content**, meaning
  any pre-existing divergence shows up as *pullable market updates* (visible,
  optional) rather than as *proposable user edits*. This is deliberate: the
  pre-0017 clone function dropped `mnemonic_en`/`synonyms_en` (added in
  0006/0008 but never added to `_duplicate_base_deck_to_user`), so nearly
  every cloned card differed from its base. The other choice would have
  offered users "proposals" that strip mnemonics from market decks.
- `_duplicate_base_deck_to_user` now copies all content fields and records
  provenance, so fresh clones are complete and start clean.

## 6. Frontend degradation before the migration is pushed

All new UI keys are read with fallbacks (`?? 0`, `?? true`, `=== null`
checks), so against a pre-0017 backend the app behaves exactly as before:
no pills, no maintainer rows, no sync buttons; `/market/proposals` shows a
plain error panel.

## 7. Deploying

```
supabase db push
```

(Also pushes 0016 if the remote doesn't have it yet — check with
`supabase migration list --linked`.)

Validated locally by `supabase/tests/market_sync/run.sh`: migrations
0001→0017 on a throwaway Postgres 18 cluster with an `auth` shim, plus a
14-scenario RPC test (backfill, badge counts, selective apply, conflicts, full
proposal lifecycle, claim/transfer, permission guards).
