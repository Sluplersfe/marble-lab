// Test (simulation) settings that apply to the whole track; saved with the file.
export const SETTINGS = [
  ['World', [
    { key: 'gravity', label: 'Gravity m/s²', min: 0, max: 50, step: 0.1 },
    { key: 'stepRate', label: 'Physics Hz', min: 60, max: 1000, step: 10 },
    { key: 'solverIterations', label: 'Solver iters', min: 1, max: 32, step: 1 },
    { key: 'ccd', label: 'Anti-tunnelling', type: 'bool' },
  ]],
  ['Marbles', [
    { key: 'marblesHit', label: 'Hit each other (not in lifts/funnels)', type: 'bool' },
    { key: 'rollingResistance', label: 'Rolling resist.', min: 0, max: 5, step: 0.01 },
    { key: 'airDrag', label: 'Air drag', min: 0, max: 5, step: 0.01 },
    { key: 'marbleRoughness', label: 'Look: roughness', min: 0, max: 1, step: 0.05 },
    { key: 'marbleMetalness', label: 'Look: metalness', min: 0, max: 1, step: 0.05 },
  ]],
  ['Test run', [
    { key: 'stuckSpeed', label: 'Stuck below m/s', min: 0, max: 1, step: 0.01 },
    { key: 'stuckTime', label: 'Stuck after s', min: 0.5, max: 60, step: 0.5 },
    { key: 'fallDepth', label: 'Lost below (m)', min: 1, max: 200, step: 1 },
    { key: 'trailLength', label: 'Trail points', min: 10, max: 5000, step: 10 },
    { key: 'removeFinished', label: 'Remove finished', type: 'bool' },
    { key: 'steerAccel', label: 'Ride push m/s²', min: 0, max: 20, step: 0.5 },
  ]],
];
export const defaultSettings = () => ({
  gravity: 9.81, stepRate: 240, solverIterations: 8, ccd: true,
  marblesHit: true, rollingResistance: 0.05, airDrag: 0, marbleRoughness: 0.15, marbleMetalness: 0.3,
  stuckSpeed: 0.03, stuckTime: 4, fallDepth: 15, trailLength: 600, removeFinished: true, steerAccel: 4,
});
