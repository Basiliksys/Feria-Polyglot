'use strict';

// Defaults shipped in older campaigns. Used only to detect untouched presets
// so we can upgrade saved state without overwriting DM customisations.
const LEGACY_DSP_PRESETS = {
  "elvish": {
    "grainSizeMs": 155,
    "pitchRatio": 1.18,
    "formantShiftHz": 320,
    "subOctaveMix": 0,
    "ringModHz": 0,
    "ringModMix": 0,
    "reverbMix": 0.42,
    "chorusMix": 0.45,
    "filterType": "highshelf",
    "filterFreq": 2200,
    "atmosphereMix": 0.22
  },
  "dwarvish": {
    "grainSizeMs": 125,
    "pitchRatio": 0.84,
    "formantShiftHz": -260,
    "subOctaveMix": 0.22,
    "ringModHz": 0,
    "ringModMix": 0,
    "reverbMix": 0.28,
    "chorusMix": 0.1,
    "filterType": "lowshelf",
    "filterFreq": 320,
    "atmosphereMix": 0.2
  },
  "draconic": {
    "grainSizeMs": 165,
    "pitchRatio": 0.78,
    "formantShiftHz": -340,
    "subOctaveMix": 0.35,
    "ringModHz": 42,
    "ringModMix": 0.14,
    "reverbMix": 0.48,
    "chorusMix": 0.15,
    "filterType": "lowshelf",
    "filterFreq": 420,
    "atmosphereMix": 0.24
  },
  "infernal": {
    "grainSizeMs": 150,
    "pitchRatio": 0.74,
    "formantShiftHz": -380,
    "subOctaveMix": 0.45,
    "ringModHz": 58,
    "ringModMix": 0.26,
    "reverbMix": 0.52,
    "chorusMix": 0.2,
    "filterType": "bandpass",
    "filterFreq": 750,
    "atmosphereMix": 0.25
  },
  "abyssal": {
    "grainSizeMs": 115,
    "pitchRatio": 0.72,
    "formantShiftHz": -420,
    "subOctaveMix": 0.5,
    "ringModHz": 85,
    "ringModMix": 0.34,
    "reverbMix": 0.56,
    "chorusMix": 0.25,
    "filterType": "bandpass",
    "filterFreq": 620,
    "atmosphereMix": 0.25
  },
  "druidic": {
    "grainSizeMs": 170,
    "pitchRatio": 1.09,
    "formantShiftHz": 180,
    "subOctaveMix": 0.08,
    "ringModHz": 18,
    "ringModMix": 0.08,
    "reverbMix": 0.45,
    "chorusMix": 0.42,
    "filterType": "bandpass",
    "filterFreq": 1450,
    "atmosphereMix": 0.22
  },
  "primordial": {
    "grainSizeMs": 185,
    "pitchRatio": 0.91,
    "formantShiftHz": -150,
    "subOctaveMix": 0.25,
    "ringModHz": 28,
    "ringModMix": 0.16,
    "reverbMix": 0.62,
    "chorusMix": 0.5,
    "filterType": "lowpass",
    "filterFreq": 1950,
    "atmosphereMix": 0.24
  },
  "deep_speech": {
    "grainSizeMs": 195,
    "pitchRatio": 0.86,
    "formantShiftHz": -220,
    "subOctaveMix": 0.32,
    "ringModHz": 115,
    "ringModMix": 0.32,
    "reverbMix": 0.68,
    "chorusMix": 0.65,
    "filterType": "bandpass",
    "filterFreq": 1100,
    "atmosphereMix": 0.25
  },
  "celestial": {
    "grainSizeMs": 175,
    "pitchRatio": 1.24,
    "formantShiftHz": 420,
    "subOctaveMix": 0,
    "ringModHz": 0,
    "ringModMix": 0,
    "reverbMix": 0.64,
    "chorusMix": 0.6,
    "filterType": "highshelf",
    "filterFreq": 2600,
    "atmosphereMix": 0.22
  },
  "thieves_cant": {
    "grainSizeMs": 110,
    "pitchRatio": 1.04,
    "formantShiftHz": 90,
    "subOctaveMix": 0,
    "ringModHz": 0,
    "ringModMix": 0,
    "reverbMix": 0.14,
    "chorusMix": 0.12,
    "filterType": "bandpass",
    "filterFreq": 1600,
    "atmosphereMix": 0.18
  },
  "undercommon": {
    "grainSizeMs": 135,
    "pitchRatio": 0.94,
    "formantShiftHz": -120,
    "subOctaveMix": 0.15,
    "ringModHz": 36,
    "ringModMix": 0.12,
    "reverbMix": 0.55,
    "chorusMix": 0.3,
    "filterType": "lowpass",
    "filterFreq": 2100,
    "atmosphereMix": 0.2
  },
  "kiros_ancient": {
    "grainSizeMs": 205,
    "pitchRatio": 0.88,
    "formantShiftHz": -180,
    "subOctaveMix": 0.28,
    "ringModHz": 48,
    "ringModMix": 0.18,
    "reverbMix": 0.65,
    "chorusMix": 0.4,
    "filterType": "bandpass",
    "filterFreq": 980,
    "atmosphereMix": 0.24
  },
  "niman_cipher": {
    "grainSizeMs": 120,
    "pitchRatio": 0.96,
    "formantShiftHz": -60,
    "subOctaveMix": 0.12,
    "ringModHz": 140,
    "ringModMix": 0.22,
    "reverbMix": 0.2,
    "chorusMix": 0.08,
    "filterType": "bandpass",
    "filterFreq": 1500,
    "atmosphereMix": 0.2
  },
  "steppe_turs": {
    "grainSizeMs": 130,
    "pitchRatio": 0.92,
    "formantShiftHz": -140,
    "subOctaveMix": 0.1,
    "ringModHz": 0,
    "ringModMix": 0,
    "reverbMix": 0.24,
    "chorusMix": 0.15,
    "filterType": "lowshelf",
    "filterFreq": 520,
    "atmosphereMix": 0.18
  }
};

// Smoother, more natural fantasy voices: longer grains, minimal sub-octave
// buzz and much quieter ring modulation reduce clicking/knocking artefacts.
const NATURAL_DSP_PRESETS = {
  "elvish": {
    "grainSizeMs": 175,
    "pitchRatio": 1.14,
    "formantShiftHz": 260,
    "subOctaveMix": 0,
    "ringModHz": 0,
    "ringModMix": 0,
    "reverbMix": 0.3,
    "chorusMix": 0.25,
    "filterType": "highshelf",
    "filterFreq": 2400,
    "atmosphereMix": 0.18
  },
  "dwarvish": {
    "grainSizeMs": 190,
    "pitchRatio": 0.94,
    "formantShiftHz": -140,
    "subOctaveMix": 0.06,
    "ringModHz": 0,
    "ringModMix": 0,
    "reverbMix": 0.22,
    "chorusMix": 0.12,
    "filterType": "lowpass",
    "filterFreq": 1800,
    "atmosphereMix": 0.14
  },
  "draconic": {
    "grainSizeMs": 185,
    "pitchRatio": 0.88,
    "formantShiftHz": -240,
    "subOctaveMix": 0.08,
    "ringModHz": 24,
    "ringModMix": 0.05,
    "reverbMix": 0.32,
    "chorusMix": 0.12,
    "filterType": "lowshelf",
    "filterFreq": 650,
    "atmosphereMix": 0.18
  },
  "infernal": {
    "grainSizeMs": 180,
    "pitchRatio": 0.85,
    "formantShiftHz": -280,
    "subOctaveMix": 0.12,
    "ringModHz": 32,
    "ringModMix": 0.08,
    "reverbMix": 0.36,
    "chorusMix": 0.14,
    "filterType": "bandpass",
    "filterFreq": 900,
    "atmosphereMix": 0.2
  },
  "abyssal": {
    "grainSizeMs": 190,
    "pitchRatio": 0.82,
    "formantShiftHz": -320,
    "subOctaveMix": 0.16,
    "ringModHz": 44,
    "ringModMix": 0.1,
    "reverbMix": 0.4,
    "chorusMix": 0.16,
    "filterType": "bandpass",
    "filterFreq": 780,
    "atmosphereMix": 0.2
  },
  "druidic": {
    "grainSizeMs": 190,
    "pitchRatio": 1.06,
    "formantShiftHz": 140,
    "subOctaveMix": 0.03,
    "ringModHz": 12,
    "ringModMix": 0.03,
    "reverbMix": 0.32,
    "chorusMix": 0.25,
    "filterType": "bandpass",
    "filterFreq": 1600,
    "atmosphereMix": 0.18
  },
  "primordial": {
    "grainSizeMs": 205,
    "pitchRatio": 0.95,
    "formantShiftHz": -120,
    "subOctaveMix": 0.08,
    "ringModHz": 16,
    "ringModMix": 0.05,
    "reverbMix": 0.42,
    "chorusMix": 0.3,
    "filterType": "lowpass",
    "filterFreq": 2100,
    "atmosphereMix": 0.2
  },
  "deep_speech": {
    "grainSizeMs": 215,
    "pitchRatio": 0.9,
    "formantShiftHz": -180,
    "subOctaveMix": 0.12,
    "ringModHz": 48,
    "ringModMix": 0.08,
    "reverbMix": 0.48,
    "chorusMix": 0.35,
    "filterType": "bandpass",
    "filterFreq": 1250,
    "atmosphereMix": 0.2
  },
  "celestial": {
    "grainSizeMs": 195,
    "pitchRatio": 1.2,
    "formantShiftHz": 340,
    "subOctaveMix": 0,
    "ringModHz": 0,
    "ringModMix": 0,
    "reverbMix": 0.45,
    "chorusMix": 0.35,
    "filterType": "highshelf",
    "filterFreq": 2500,
    "atmosphereMix": 0.18
  },
  "thieves_cant": {
    "grainSizeMs": 150,
    "pitchRatio": 1.02,
    "formantShiftHz": 70,
    "subOctaveMix": 0,
    "ringModHz": 0,
    "ringModMix": 0,
    "reverbMix": 0.12,
    "chorusMix": 0.08,
    "filterType": "bandpass",
    "filterFreq": 1700,
    "atmosphereMix": 0.14
  },
  "undercommon": {
    "grainSizeMs": 175,
    "pitchRatio": 0.97,
    "formantShiftHz": -100,
    "subOctaveMix": 0.05,
    "ringModHz": 18,
    "ringModMix": 0.04,
    "reverbMix": 0.34,
    "chorusMix": 0.18,
    "filterType": "lowpass",
    "filterFreq": 2300,
    "atmosphereMix": 0.16
  },
  "kiros_ancient": {
    "grainSizeMs": 215,
    "pitchRatio": 0.93,
    "formantShiftHz": -150,
    "subOctaveMix": 0.1,
    "ringModHz": 24,
    "ringModMix": 0.07,
    "reverbMix": 0.45,
    "chorusMix": 0.25,
    "filterType": "bandpass",
    "filterFreq": 1150,
    "atmosphereMix": 0.2
  },
  "niman_cipher": {
    "grainSizeMs": 165,
    "pitchRatio": 0.98,
    "formantShiftHz": -50,
    "subOctaveMix": 0.04,
    "ringModHz": 60,
    "ringModMix": 0.08,
    "reverbMix": 0.16,
    "chorusMix": 0.06,
    "filterType": "bandpass",
    "filterFreq": 1600,
    "atmosphereMix": 0.16
  },
  "steppe_turs": {
    "grainSizeMs": 170,
    "pitchRatio": 0.96,
    "formantShiftHz": -110,
    "subOctaveMix": 0.04,
    "ringModHz": 0,
    "ringModMix": 0,
    "reverbMix": 0.18,
    "chorusMix": 0.1,
    "filterType": "lowshelf",
    "filterFreq": 700,
    "atmosphereMix": 0.14
  }
};

function presetEquals(a, b) {
  if (!a || !b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

module.exports = { LEGACY_DSP_PRESETS, NATURAL_DSP_PRESETS, presetEquals };
