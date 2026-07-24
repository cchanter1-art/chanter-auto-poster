'use strict';

// Destination-level TikTok sound mode contract (P0). A single canonical media
// asset can fan out to many destinations, each choosing independently how its
// audio is handled. This module is the ONLY authority on what each mode means;
// it is pure (no I/O, no provider calls) so every layer — intake, storage,
// mapper, and the TikTok provider — resolves the same honest capability.
//
// Modes:
//   keep_original     — publish the asset's own audio unchanged.
//   mute              — publish with audio removed (a derived, muted copy;
//                       the canonical asset is never mutated).
//   tiktok_recommended— ask TikTok to add a recommended track. Supported only
//                       for the Photo Direct Post path (post_info.auto_add_music).
//                       TikTok's video DIRECT_POST API has no equivalent switch,
//                       so a video in this mode is an honest manual-completion
//                       result, never a silent no-op that claims success.

const KEEP_ORIGINAL = 'keep_original';
const MUTE = 'mute';
const TIKTOK_RECOMMENDED = 'tiktok_recommended';

const SOUND_MODES = Object.freeze([KEEP_ORIGINAL, MUTE, TIKTOK_RECOMMENDED]);
const SOUND_MODE_SET = new Set(SOUND_MODES);

// Compatibility default: legacy records and any missing/unknown value resolve
// to keep_original — the mode that preserves exactly the pre-feature behavior
// (publish the asset unchanged).
const DEFAULT_SOUND_MODE = KEEP_ORIGINAL;

function normalizeSoundMode(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  return SOUND_MODE_SET.has(raw) ? raw : DEFAULT_SOUND_MODE;
}

function isSoundMode(value) {
  return SOUND_MODE_SET.has(String(value == null ? '' : value).trim().toLowerCase());
}

/**
 * Resolve what a (mediaType, soundMode) pair means for the CURRENT TikTok
 * provider implementation. Never invents unsupported provider behavior.
 *
 * Returns a closed shape:
 *   { media, mode, supported, autoAddMusic, requiresMutedDerivative,
 *     manualCompletionRequired }
 */
function resolveSoundCapability(mediaType, soundMode) {
  const media = String(mediaType || '').trim().toLowerCase() === 'video' ? 'video' : 'photo';
  const mode = normalizeSoundMode(soundMode);

  if (media === 'photo') {
    // A TikTok photo post carries no source audio, so keep_original and mute
    // are both simply silent (auto_add_music:false). Only tiktok_recommended
    // asks TikTok to add a recommended track (auto_add_music:true).
    return {
      media,
      mode,
      supported: true,
      autoAddMusic: mode === TIKTOK_RECOMMENDED,
      requiresMutedDerivative: false,
      manualCompletionRequired: false
    };
  }

  // Video.
  if (mode === TIKTOK_RECOMMENDED) {
    // No automatic recommended-sound switch exists for a directly published
    // video. Surface an explicit manual-completion requirement instead of
    // pretending the post carries TikTok-native sound.
    return {
      media,
      mode,
      supported: false,
      autoAddMusic: false,
      requiresMutedDerivative: false,
      manualCompletionRequired: true
    };
  }

  return {
    media,
    mode,
    supported: true,
    autoAddMusic: false,
    requiresMutedDerivative: mode === MUTE,
    manualCompletionRequired: false
  };
}

module.exports = {
  KEEP_ORIGINAL,
  MUTE,
  TIKTOK_RECOMMENDED,
  SOUND_MODES,
  DEFAULT_SOUND_MODE,
  normalizeSoundMode,
  isSoundMode,
  resolveSoundCapability
};
