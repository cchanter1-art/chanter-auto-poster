'use strict';

const config = require('./config');
const bundledFfmpegPath = require('ffmpeg-static');
const bundledFfprobePath = require('ffprobe-static').path;

function resolveFfmpegPath() {
  return config.autoCaption.ffmpegPath || bundledFfmpegPath || 'ffmpeg';
}

function resolveFfprobePath() {
  return config.autoCaption.ffprobePath || bundledFfprobePath || 'ffprobe';
}

module.exports = { resolveFfmpegPath, resolveFfprobePath };
