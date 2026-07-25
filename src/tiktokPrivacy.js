'use strict';

// Canonical TikTok privacy-level vocabulary (P0). This is the ONE privacy model
// shared by every layer that reads, edits, persists, or dispatches a post's
// privacy: the batch-review edit surface, the storage write chokepoint
// (postsMapper.mapPatchToFirestore), and the TikTok provider payload
// (tiktok.resolvePrivacyLevel / the pre-publish fail-closed checks). It is pure
// (no I/O, no provider calls) so those layers can never disagree on what a
// privacy value means or which values are valid. The values are TikTok's own
// `privacy_level` enum — no second vocabulary is introduced.
//
// Levels (widest → narrowest audience):
//   PUBLIC_TO_EVERYONE     — anyone can see the post.
//   MUTUAL_FOLLOW_FRIENDS  — accounts that mutually follow the creator.
//   FOLLOWER_OF_CREATOR    — the creator's followers.
//   SELF_ONLY              — only the creator (private). The proof-safe value.
//
// Which of these a given connected account may actually use is decided by
// TikTok per account (creator_info.privacy_level_options) and enforced
// fail-closed at publish; this module only defines the vocabulary and the safe
// default. An unaudited app is limited to SELF_ONLY, which is exactly why a
// controlled proof must be able to select SELF_ONLY explicitly.

const PUBLIC_TO_EVERYONE = 'PUBLIC_TO_EVERYONE';
const MUTUAL_FOLLOW_FRIENDS = 'MUTUAL_FOLLOW_FRIENDS';
const FOLLOWER_OF_CREATOR = 'FOLLOWER_OF_CREATOR';
const SELF_ONLY = 'SELF_ONLY';

const TIKTOK_PRIVACY_LEVELS = Object.freeze([
  PUBLIC_TO_EVERYONE,
  MUTUAL_FOLLOW_FRIENDS,
  FOLLOWER_OF_CREATOR,
  SELF_ONLY
]);
const PRIVACY_LEVEL_SET = new Set(TIKTOK_PRIVACY_LEVELS);

// Compatibility default: legacy drafts and any missing/unknown value resolve to
// SELF_ONLY — the narrowest, never-public audience. This matches the existing
// read default in postsMapper.postFromDoc (`data.privacyLevel || 'SELF_ONLY'`)
// and guarantees no fallback can silently make a proof-intended item public.
const DEFAULT_TIKTOK_PRIVACY_LEVEL = SELF_ONLY;

function isTikTokPrivacyLevel(value) {
  return PRIVACY_LEVEL_SET.has(String(value == null ? '' : value).trim().toUpperCase());
}

function normalizeTikTokPrivacyLevel(value) {
  const raw = String(value == null ? '' : value).trim().toUpperCase();
  return PRIVACY_LEVEL_SET.has(raw) ? raw : DEFAULT_TIKTOK_PRIVACY_LEVEL;
}

module.exports = {
  PUBLIC_TO_EVERYONE,
  MUTUAL_FOLLOW_FRIENDS,
  FOLLOWER_OF_CREATOR,
  SELF_ONLY,
  TIKTOK_PRIVACY_LEVELS,
  PRIVACY_LEVEL_SET,
  DEFAULT_TIKTOK_PRIVACY_LEVEL,
  isTikTokPrivacyLevel,
  normalizeTikTokPrivacyLevel
};
