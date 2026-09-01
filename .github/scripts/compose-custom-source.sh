#!/usr/bin/env bash
set -euo pipefail

# Compose the two fork-owned customization branches on top of an exact official
# Cindy commit. This script is intentionally usable from both the release build
# and the autofix workflow so that both paths enforce the same provenance rules.

: "${OFFICIAL_SHA:?OFFICIAL_SHA is required}"
: "${TRANSLATION_REF:?TRANSLATION_REF is required}"
: "${UPDATE_REF:?UPDATE_REF is required}"

CUSTOMIZATION_REMOTE_NAME="${CUSTOMIZATION_REMOTE_NAME:-customization}"
CUSTOMIZATION_REMOTE_URL="${CUSTOMIZATION_REMOTE_URL:-https://github.com/hbyq/Cindy.git}"
SKIP_CUSTOMIZATION_FETCH="${SKIP_CUSTOMIZATION_FETCH:-0}"

translation_allowed_paths=(
  'apps/desktop/src/main/__tests__/visibleTextTranslationService.test.ts'
  'apps/desktop/src/main/bootstrap-electron.ts'
  'apps/desktop/src/main/visible-text-translation-settings-store.ts'
  'apps/desktop/src/main/visibleTextTranslationService.ts'
  'apps/desktop/src/preload/preload.ts'
  'apps/desktop/src/renderer/__tests__/thinkingTextRendering.test.tsx'
  'apps/desktop/src/renderer/__tests__/workGroupBlockLivePreview.test.tsx'
  'apps/desktop/src/renderer/components/chat/ThinkingCard.tsx'
  'apps/desktop/src/renderer/components/chat/WorkGroupBlock.tsx'
  'apps/desktop/src/renderer/hooks/useVisibleTextTranslation.ts'
  'apps/desktop/src/renderer/vite-env.d.ts'
  'apps/desktop/src/shared/__tests__/visibleTextTranslation.test.ts'
  'apps/desktop/src/shared/visibleTextTranslation.ts'
  'packages/maker-shared/src/workActivityProjection.ts'
)

update_allowed_paths=(
  'apps/desktop/src/main/__tests__/customUpdateFeed.test.ts'
  'apps/desktop/src/main/__tests__/updateChannelStore.test.ts'
  'apps/desktop/src/main/__tests__/updateService.test.ts'
  'apps/desktop/src/main/customUpdateFeed.ts'
  'apps/desktop/src/main/forkUpdatePolicy.ts'
  'apps/desktop/src/main/updateChannelStore.ts'
  'apps/desktop/src/main/updateService.ts'
  'scripts/__tests__/log-upload-build-env.test.mjs'
  'scripts/shared/log-upload-build-env.mjs'
)

fail() {
  printf 'compose-custom-source: %s\n' "$*" >&2
  exit 1
}

emit_output() {
  local key="$1"
  local value="$2"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s=%s\n' "$key" "$value" >>"$GITHUB_OUTPUT"
  fi
  printf '%s=%s\n' "$key" "$value"
}

is_allowed_path() {
  local candidate="$1"
  shift
  local allowed
  for allowed in "$@"; do
    [[ "$candidate" == "$allowed" ]] && return 0
  done
  return 1
}

assert_clean_official_checkout() {
  local actual_sha
  actual_sha="$(git rev-parse HEAD)"
  [[ "$OFFICIAL_SHA" =~ ^[0-9a-f]{40}$ ]] || fail 'OFFICIAL_SHA is not a full lowercase SHA'
  [[ "$actual_sha" == "$OFFICIAL_SHA" ]] || fail "checkout is $actual_sha, expected official $OFFICIAL_SHA"
  git diff --quiet || fail 'checkout has unstaged changes before composition'
  git diff --cached --quiet || fail 'checkout has staged changes before composition'
  [[ -z "$(git status --porcelain --untracked-files=normal)" ]] || fail 'checkout is not clean before composition'
}

assert_dco() {
  local commit="$1"
  local label="$2"
  local author committer trailer value matched=0
  author="$(git show -s --format='%an <%ae>' "$commit")"
  committer="$(git show -s --format='%cn <%ce>' "$commit")"
  while IFS= read -r trailer; do
    if [[ "$trailer" =~ ^Signed-off-by:[[:space:]]+(.+)$ ]]; then
      value="${BASH_REMATCH[1]}"
      if [[ "$value" == "$author" || "$value" == "$committer" ]]; then
        matched=1
      fi
    fi
  done < <(git show -s --format='%B' "$commit" | git interpret-trailers --parse)
  (( matched == 1 )) || fail "$label commit $commit lacks a Signed-off-by matching its author or committer"
}

assert_commit_changes() {
  local label="$1"
  local parent="$2"
  local commit="$3"
  shift 3
  local -a allowed_paths=("$@")
  local status path old_mode new_mode add del
  while IFS=$'\t' read -r status path; do
    [[ -n "$status" ]] || continue
    [[ "$status" == 'A' || "$status" == 'M' ]] || fail "$label commit $commit uses forbidden status '$status' for '$path'"
    is_allowed_path "$path" "${allowed_paths[@]}" || fail "$label commit $commit changed non-allow-listed path '$path'"
  done < <(git diff --name-status --no-renames "$parent..$commit")
  while read -r old_mode new_mode _old_sha _new_sha status path; do
    [[ -n "${path:-}" ]] || continue
    [[ "$status" == 'A' || "$status" == 'M' ]] || fail "$label commit $commit has a forbidden raw change for '$path'"
    [[ "$new_mode" == '100644' ]] || fail "$label commit $commit path '$path' is not a regular non-executable file"
    if [[ "$status" == 'M' ]]; then
      [[ "$old_mode" == "$new_mode" ]] || fail "$label commit $commit changes the mode of '$path'"
    fi
  done < <(git diff --raw --no-abbrev --no-renames "$parent..$commit" | sed -E 's/^:([0-9]+) ([0-9]+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])[[:space:]]+/\1 \2 \3 \4 \5 /')
  while IFS=$'\t' read -r add del path; do
    [[ -n "${path:-}" ]] || continue
    [[ "$add" != '-' && "$del" != '-' ]] || fail "$label commit $commit contains binary change '$path'"
  done < <(git diff --numstat --no-renames "$parent..$commit")
}

assert_feature_and_compose() {
  local label="$1"
  local ref="$2"
  shift 2
  local -a allowed_paths=("$@")
  local head base count previous commit parents status path old_mode new_mode add del
  local -a commits=()

  head="$(git rev-parse "$ref^{commit}")"
  [[ "$head" =~ ^[0-9a-f]{40}$ ]] || fail "$label resolved to an invalid SHA"
  base="$(git merge-base "$OFFICIAL_SHA" "$head")"
  [[ "$base" =~ ^[0-9a-f]{40}$ ]] || fail "$label has no unique merge base with official source"
  git merge-base --is-ancestor "$base" "$OFFICIAL_SHA" || fail "$label base is not in official history"

  mapfile -t commits < <(git rev-list --reverse --topo-order "$base..$head")
  count="${#commits[@]}"
  (( count >= 1 && count <= 20 )) || fail "$label must contain 1-20 commits, found $count"

  previous="$base"
  for commit in "${commits[@]}"; do
    mapfile -t parents < <(git show -s --format='%P' "$commit" | tr ' ' '\n' | sed '/^$/d')
    (( ${#parents[@]} == 1 )) || fail "$label commit $commit is not single-parent"
    [[ "${parents[0]}" == "$previous" ]] || fail "$label history is not linear at $commit"
    assert_dco "$commit" "$label"
    assert_commit_changes "$label" "$previous" "$commit" "${allowed_paths[@]}"
    previous="$commit"
  done
  [[ "$previous" == "$head" ]] || fail "$label head is not the end of its linear commit chain"

  while IFS=$'\t' read -r status path; do
    [[ -n "$status" ]] || continue
    [[ "$status" == 'A' || "$status" == 'M' ]] || fail "$label uses forbidden change status '$status' for '$path'"
    is_allowed_path "$path" "${allowed_paths[@]}" || fail "$label changed non-allow-listed path '$path'"
  done < <(git diff --name-status --no-renames "$base..$head")

  while read -r old_mode new_mode _old_sha _new_sha status path; do
    [[ -n "${path:-}" ]] || continue
    [[ "$status" == 'A' || "$status" == 'M' ]] || fail "$label has a forbidden raw change for '$path'"
    [[ "$new_mode" == '100644' ]] || fail "$label path '$path' is not a regular non-executable file"
    if [[ "$status" == 'M' ]]; then
      [[ "$old_mode" == "$new_mode" ]] || fail "$label changes the file mode of '$path'"
    fi
  done < <(git diff --raw --no-abbrev --no-renames "$base..$head" | sed -E 's/^:([0-9]+) ([0-9]+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])[[:space:]]+/\1 \2 \3 \4 \5 /')

  while IFS=$'\t' read -r add del path; do
    [[ -n "${path:-}" ]] || continue
    [[ "$add" != '-' && "$del" != '-' ]] || fail "$label contains binary change '$path'"
  done < <(git diff --numstat --no-renames "$base..$head")

  for commit in "${commits[@]}"; do
    git -c user.name='github-actions[bot]' \
      -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
      cherry-pick "$commit"
  done

  case "$label" in
    translation)
      TRANSLATION_SHA="$head"
      TRANSLATION_BASE_SHA="$base"
      TRANSLATION_COMMIT_COUNT="$count"
      ;;
    update)
      UPDATE_SHA="$head"
      UPDATE_BASE_SHA="$base"
      UPDATE_COMMIT_COUNT="$count"
      ;;
    *) fail "unknown feature label '$label'" ;;
  esac
}

assert_clean_official_checkout

if [[ "$SKIP_CUSTOMIZATION_FETCH" != '1' ]]; then
  if git remote get-url "$CUSTOMIZATION_REMOTE_NAME" >/dev/null 2>&1; then
    [[ "$(git remote get-url "$CUSTOMIZATION_REMOTE_NAME")" == "$CUSTOMIZATION_REMOTE_URL" ]] \
      || fail "remote '$CUSTOMIZATION_REMOTE_NAME' has an unexpected URL"
  else
    git remote add "$CUSTOMIZATION_REMOTE_NAME" "$CUSTOMIZATION_REMOTE_URL"
  fi
  git fetch --no-tags "$CUSTOMIZATION_REMOTE_NAME" \
    "+${TRANSLATION_SOURCE_REF:-refs/heads/feature/visible-text-translation-v0.1.60}:$TRANSLATION_REF" \
    "+${UPDATE_SOURCE_REF:-refs/heads/feature/fork-update-and-build-v0.1.60}:$UPDATE_REF"
fi

assert_feature_and_compose translation "$TRANSLATION_REF" "${translation_allowed_paths[@]}"
assert_feature_and_compose update "$UPDATE_REF" "${update_allowed_paths[@]}"

COMPOSED_SHA="$(git rev-parse HEAD)"
emit_output official_sha "$OFFICIAL_SHA"
emit_output translation_sha "$TRANSLATION_SHA"
emit_output translation_base_sha "$TRANSLATION_BASE_SHA"
emit_output translation_commit_count "$TRANSLATION_COMMIT_COUNT"
emit_output update_sha "$UPDATE_SHA"
emit_output update_base_sha "$UPDATE_BASE_SHA"
emit_output update_commit_count "$UPDATE_COMMIT_COUNT"
emit_output composed_sha "$COMPOSED_SHA"
