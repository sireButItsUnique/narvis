import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSpec, MODEL_SCHEMA, SHAPES } from '../public/js/spec.js';

const mug = {
  name: 'coffee mug',
  parts: [
    { name: 'body', shape: 'lathe', dims: [], points: [[4, 0], [4.3, 9], [4, 9.5]], position: [0, 0, 0], rotation: [0, 0, 0], color: '#E8E2D6' },
    { name: 'handle', shape: 'torus', dims: [2.6, 0.5, 180], points: [], position: [4.6, 5, 0], rotation: [0, 0, -90], color: '#e8e2d6' },
  ],
};

test('a good spec passes through, colours normalised', () => {
  const { spec, warnings } = sanitizeSpec(mug);
  assert.equal(warnings.length, 0);
  assert.equal(spec.parts.length, 2);
  assert.equal(spec.parts[0].color, '#e8e2d6');
  assert.deepEqual(spec.parts[1].dims, [2.6, 0.5, 180]);
});

test('bad parts are dropped, fixable ones repaired', () => {
  const { spec, warnings } = sanitizeSpec({
    name: '  ',
    parts: [
      { name: 'Leg One', shape: 'cylinder', dims: [1, 40], position: [1, 2], color: 'red' },   // [r,h] -> [r,r,h]
      { name: 'x', shape: 'pyramid', dims: [1] },                                            // unknown shape
      { name: 'x', shape: 'lathe', points: [[1, 1]] },                                       // too few points
      { name: 'dup', shape: 'box', dims: [-2, 0, 'a'] },
      { name: 'dup', shape: 'sphere', dims: [3] },
    ],
  });
  assert.equal(spec.name, 'model');
  assert.deepEqual(spec.parts.map(p => p.name), ['leg_one', 'dup', 'dup_2']);
  assert.deepEqual(spec.parts[0].dims, [1, 1, 40]);
  assert.deepEqual(spec.parts[0].position, [1, 2, 0]);
  assert.equal(spec.parts[0].color, '#b8b8b8');
  assert.deepEqual(spec.parts[1].dims, [2, 0.01, 1]);   // abs, clamped, missing -> 1
  assert.ok(warnings.length >= 3);
});

test('nothing usable returns null', () => {
  assert.equal(sanitizeSpec(null).spec, null);
  assert.equal(sanitizeSpec({ parts: [] }).spec, null);
  assert.equal(sanitizeSpec({ parts: [{ shape: 'blob' }] }).spec, null);
});

test('schema is strict-mode friendly: every object closed, every property required', () => {
  const walk = s => {
    if (s.type === 'object') {
      assert.equal(s.additionalProperties, false);
      assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort());
      Object.values(s.properties).forEach(walk);
    }
    if (s.type === 'array') walk(s.items);
  };
  walk(MODEL_SCHEMA);
  assert.deepEqual(MODEL_SCHEMA.properties.parts.items.properties.shape.enum, SHAPES);
});
