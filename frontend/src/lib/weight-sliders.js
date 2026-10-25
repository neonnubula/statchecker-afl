export const DEFAULT_WEIGHT_MULTIPLIER = 100;
export const DEFAULT_LAST_SEASON_MULTIPLIER = 0;
export const MAX_WEIGHT_MULTIPLIER = 1000;
export const DETENT_SNAP_MIN = 96;
export const DETENT_SNAP_MAX = 104;

export const clampWeightMultiplier = (value) =>
  Math.min(MAX_WEIGHT_MULTIPLIER, Math.max(0, Math.round(value)));

export const applyWeightSliderDetent = (value) => {
  const rounded = clampWeightMultiplier(value);
  if (rounded >= DETENT_SNAP_MIN && rounded <= DETENT_SNAP_MAX) {
    return DEFAULT_WEIGHT_MULTIPLIER;
  }
  return rounded;
};

export const computeEffectiveWeight = (sampleCount, multiplier) => {
  if (!Number.isFinite(sampleCount) || sampleCount <= 0) {
    return 0;
  }
  return (sampleCount * clampWeightMultiplier(multiplier)) / 100;
};

export const toWeightMultiplierFromTarget = (targetWeight, sampleCount) => {
  if (!Number.isFinite(sampleCount) || sampleCount <= 0) {
    return DEFAULT_WEIGHT_MULTIPLIER;
  }
  return clampWeightMultiplier((targetWeight / sampleCount) * 100);
};
