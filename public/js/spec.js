// The part-list format: what the AI returns, what the builder draws, what undo stores.
// Plain JS (no three.js, no DOM) so the server imports it too.

export const SHAPES = ['box', 'sphere', 'cylinder', 'cone', 'torus', 'capsule', 'lathe', 'extrude'];

// what each number in `dims` means, per shape
export const DIMS = {
  box: ['width', 'height', 'depth'],
  sphere: ['radius'],
  cylinder: ['radiusTop', 'radiusBottom', 'height'],
  cone: ['radius', 'height'],
  torus: ['ringRadius', 'tubeRadius', 'arcDegrees'],
  capsule: ['radius', 'length'],
  lathe: [],
  extrude: ['depth'],
};

export const LIMITS = { parts: 80, points: 96, size: 100000 };

const nums = { type: 'array', items: { type: 'number' } };

// Kept to the JSON-schema subset every provider's strict mode accepts (no min/max/pattern);
// sanitizeSpec() enforces the rest.
export const MODEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'parts'],
  properties: {
    name: { type: 'string', description: 'What the object is, 1-4 words, e.g. "coffee mug".' },
    parts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'shape', 'dims', 'points', 'position', 'rotation', 'color'],
        properties: {
          name: { type: 'string', description: 'Unique snake_case part name, e.g. "left_front_leg".' },
          shape: { type: 'string', enum: SHAPES },
          dims: { ...nums, description: 'box [w,h,d] | sphere [r] | cylinder [rTop,rBottom,h] | cone [r,h] | torus [ringR,tubeR,arcDeg] | capsule [r,length] | extrude [depth] | lathe []' },
          points: { type: 'array', items: nums, description: '[[x,y],...]: profile for lathe, outline for extrude, [] for other shapes.' },
          position: { ...nums, description: '[x,y,z] centre of the part, cm' },
          rotation: { ...nums, description: '[x,y,z] degrees' },
          color: { type: 'string', description: '#rrggbb' },
        },
      },
    },
  },
};

const finite = v => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const length = v => clamp(Math.abs(v), 0.01, LIMITS.size);

// Repairs what it can, drops parts it can't. Returns { spec: null } when nothing usable is left.
export function sanitizeSpec(input) {
  const warnings = [];
  if (!input || typeof input !== 'object' || !Array.isArray(input.parts)) {
    return { spec: null, warnings: ['no parts list'] };
  }
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 60) : 'model';
  if (input.parts.length > LIMITS.parts) warnings.push(`kept the first ${LIMITS.parts} parts`);
  const parts = [], used = new Set();
  input.parts.slice(0, LIMITS.parts).forEach((raw, i) => {
    const part = sanitizePart(raw, i, warnings);
    if (!part) return;
    let n = part.name, k = 2;
    while (used.has(n)) n = `${part.name}_${k++}`;
    used.add(n); part.name = n;
    parts.push(part);
  });
  if (!parts.length) return { spec: null, warnings: [...warnings, 'no usable parts'] };
  return { spec: { name, parts }, warnings };
}

function sanitizePart(p, i, warnings) {
  if (!p || typeof p !== 'object' || !SHAPES.includes(p.shape)) {
    warnings.push(`part ${i + 1}: unknown shape "${p?.shape}", dropped`);
    return null;
  }
  const shape = p.shape;
  const label = `part ${i + 1} (${shape})`;
  let raw = Array.isArray(p.dims) ? p.dims.filter(finite) : [];
  if (shape === 'cylinder' && raw.length === 2) raw = [raw[0], raw[0], raw[1]];   // [r, h] is a common slip
  if (shape === 'torus' && raw.length === 2) raw = [raw[0], raw[1], 360];
  const dims = DIMS[shape].map((_, j) => {
    if (shape === 'torus' && j === 2) return clamp(finite(raw[2]) ? raw[2] : 360, 1, 360);
    if (!finite(raw[j])) { warnings.push(`${label}: missing ${DIMS[shape][j]}, used 1`); return 1; }
    return length(raw[j]);
  });

  let points = [];
  if (shape === 'lathe' || shape === 'extrude') {
    points = (Array.isArray(p.points) ? p.points : [])
      .filter(q => Array.isArray(q) && finite(q[0]) && finite(q[1]))
      .slice(0, LIMITS.points)
      .map(([x, y]) => [shape === 'lathe' ? clamp(Math.abs(x), 0, LIMITS.size) : clamp(x, -LIMITS.size, LIMITS.size),
                        clamp(y, -LIMITS.size, LIMITS.size)]);
    if (points.length < (shape === 'lathe' ? 2 : 3)) {
      warnings.push(`${label}: not enough points, dropped`);
      return null;
    }
  }

  const vec = (v, lim) => [0, 1, 2].map(j => (Array.isArray(v) && finite(v[j]) ? clamp(v[j], -lim, lim) : 0));
  const name = (typeof p.name === 'string' ? p.name : '').toLowerCase().trim()
    .replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '').slice(0, 40) || `${shape}_${i + 1}`;
  return {
    name, shape, dims, points,
    position: vec(p.position, LIMITS.size),
    rotation: vec(p.rotation, 3600),
    color: color(p.color),
  };
}

function color(c) {
  if (typeof c !== 'string') return '#b8b8b8';
  const s = c.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return '#' + [...s.slice(1)].map(h => h + h).join('');
  return '#b8b8b8';
}
