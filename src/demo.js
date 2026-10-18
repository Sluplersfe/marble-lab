// Starter track: spawner -> funnel -> spiral -> ramp -> finish.
// The spiral is placed so the funnel's spout drops marbles a little way into its first turn, not onto its open start.
export const DEMO = {
  camera: { pos: [13, 12, 16], target: [0, 6, 3] },
  pieces: [
    { id: 1, type: 'spawner', pos: [0, 12.5, 0], rotY: 0, count: 6, interval: 1.5, radius: 0.35, density: 1, bounce: 0.3, color: '#e8e8f0', randomColors: true },
    { id: 2, type: 'funnel', pos: [0, 10, 0], rotY: 0, radius: 2.5, height: 1.6, hole: 0.45, spout: 0.6, friction: 0.3, color: '#bf8a4f' },
    { id: 3, type: 'spiral', pos: [0.306, 9.159, -1.199], rotY: 0, profile: 'gutter', width: 1.0, wall: 1.3, friction: 0.4, color: '#4f7dbf', radius: 2.5, turns: 2, drop: 4, clockwise: false },
    { id: 4, type: 'path', pos: [0.306, 5.009, -1.599], rotY: -90, profile: 'channel', width: 1.0, wall: 0.4, friction: 0.4, color: '#4f9fbf', points: [[0, 0, 0], [8, -1.6, 0]] },
    { id: 5, type: 'finish', pos: [0.306, 2.659, 7.401], rotY: 0, sx: 2, sy: 1.6, sz: 2 },
  ],
};
