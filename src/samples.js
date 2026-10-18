// Built-in sample courses. Each is a list of [type, position, overrides]; part defaults fill in the rest when one is
// opened or merged, so samples stay short and pick up improvements to the parts.
import { TYPES } from './pieces.js';
import { DEMO } from './demo.js';

const S = (name, desc, camera, list) => ({ name, desc, camera, list });
export const SAMPLES = [
  S('Spiral starter', 'Funnel into a two-turn spiral and a ramp to the finish. The track the app opens with.',
    DEMO.camera, DEMO.pieces.map(({ id, type, pos, ...o }) => [type, pos, o])),
  S('Plinko', 'A spawner drops marbles into the peg board\'s funnel top; they bounce down through the pegs to the finish.',
    { pos: [0, 7, 15], target: [0, 6, 0] }, [
      ['spawner', [0, 7.8, 0], { count: 20, interval: 1, spread: 0.1 }],
      ['pegboard', [0, 0, 0], {}],
      ['finish', [0, -0.6, 0], { sx: 6, sy: 0.8, sz: 2 }],
    ]),
  S('Lift loop', 'A feed ramp into the lift\'s gated inlet; the lift carries marbles up and tips them onto the exit ramp.',
    { pos: [14, 8, 12], target: [2, 3, 0] }, [
      ['spawner', [7, 2.4, 0], { count: 6, interval: 1.2 }],
      ['path', [7.5, 1.7, 0], { points: [[0, 0, 0], [-4.9, -1, 0]] }],
      ['lift', [0, 0, 0], { height: 5 }],
      ['path', [0.5, 4.6, 0], { points: [[0, 0, 0], [5, -1, 0]] }],
      ['finish', [6.2, 3.4, 0], {}],
    ]),
  S('Loop-the-loop', 'A booster gets marbles up to speed for a vertical loop.',
    { pos: [3, 4, 10], target: [-1, 1, 1] }, [
      ['spawner', [-4.6, 0.9, 0], { count: 4, interval: 2 }],
      ['booster', [-5, 0.15, 0], { length: 3, accel: 40, maxSpeed: 11 }],
      ['loop', [0, 0, 0], {}],
      ['finish', [2.6, -0.2, 1.667], { sx: 0.8, sy: 1, sz: 1.2 }],
    ]),
  S('Splitter race', 'The splitter\'s flap flips after every marble, sending them alternately to two finish lanes.',
    { pos: [4, 7, 12], target: [2, 0, 0] }, [
      ['spawner', [-3.6, 1.8, 0], { count: 8, interval: 1.5 }],
      ['path', [-4, 1, 0], { points: [[0, 0, 0], [3.9, -0.94, 0]] }],
      ['splitter', [0, 0, 0], {}],
      ['path', [2.1, -0.65, -0.5], { points: [[0, 0, 0], [2, -0.4, -0.6], [5, -1, -1.5]] }],
      ['path', [2.1, -0.65, 0.5], { points: [[0, 0, 0], [2, -0.4, 0.6], [5, -1, 1.5]] }],
      ['checkpoint', [7.4, -1.4, -2], { name: 'Left', sx: 0.8 }],
      ['finish', [7.6, -1.8, -2], { sx: 1, sy: 1.2, sz: 1.4 }],
      ['finish', [7.6, -1.8, 2], { sx: 1, sy: 1.2, sz: 1.4 }],
    ]),
  S('Portal hop', 'Marbles fly off a ramp into an entry portal and come out of the exit portal on a higher track.',
    { pos: [2, 8, 14], target: [1, 3, 3] }, [
      ['spawner', [-5.6, 1.8, 0], { count: 5, interval: 1.5 }],
      ['path', [-6, 1.2, 0], { points: [[0, 0, 0], [6, -1.2, 0]] }],
      ['portal', [0.3, -0.1, 0], { role: 'entry', link: 'exit' }],
      ['portal', [0, 6, 6], { role: 'exit', key: 'exit' }],
      ['path', [0, 6, 6], { points: [[0, 0, 0], [6, -1.2, 0]] }],
      ['finish', [6.6, 4.6, 6], {}],
    ]),
];

// Turn a sample into pieces with fresh ids starting at firstId. Portal links written as a key name are resolved here.
export function instantiate(sample, firstId) {
  let id = firstId; const keyed = {};
  const pieces = sample.list.map(([type, pos, o]) => {
    const { key, ...over } = o;
    const p = { id: id++, type, pos: [...pos], rotX: 0, rotY: 0, rotZ: 0, scale: [1, 1, 1], ...TYPES[type].defaults(), ...structuredClone(over) };
    if (key) keyed[key] = p.id;
    return p;
  });
  for (const p of pieces) if (typeof p.link === 'string') p.link = keyed[p.link] || 0;
  return pieces;
}
