import * as THREE from 'three';

export interface BuildingUniforms {
  uCell: { value: number };
  uNight: { value: number };
  uHacker: { value: number };
  uTime: { value: number };
  uGlyphs: { value: THREE.Texture | null };
  uGlyphScale: { value: number };
}

/**
 * MeshStandardMaterial for instanced unit boxes (building tiers).
 * Per instance:
 * - aGlow: emissive glow for hotspots and selection;
 * - aFacade: (style, irregularity, age, seed) — see architecture.ts. Style is the facade
 *   (concrete grid, glass curtain wall, brick with arched windows, steel bracing,
 *   storefront, library columns, utility louvres, test lattice, glass box, colonnade;
 *   +0.5 = ribbon windows); irregularity (complexity) makes windows wander and glyphs
 *   glitch; age weathers the facade and dims the glow; seed shifts the window rhythm.
 * Normal modes: procedural windows sized in world units, lit at night. Hacker mode:
 * near-black glass with glowing scrolling text tinted by the color mode and glowing
 * edges, with the facade setting the panel rhythm and neon structure.
 * The diffuse color always carries the color mode; facades only modulate it.
 */
export function buildingMaterial(): { material: THREE.MeshStandardMaterial; uniforms: BuildingUniforms } {
  const uniforms: BuildingUniforms = {
    uCell: { value: 1 }, uNight: { value: 1 }, uHacker: { value: 0 }, uTime: { value: 0 },
    uGlyphs: { value: null }, uGlyphScale: { value: 10 },
  };
  const material = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.15 });
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aGlow;
attribute vec4 aFacade;
varying float vGlow;
varying vec4 vFacade;
varying vec3 vLocal;
varying vec3 vObjNormal;
varying vec3 vSize;
varying float vWY;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vGlow = aGlow;
vFacade = aFacade;
vObjNormal = normal;
#ifdef USE_INSTANCING
vSize = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
vWY = (modelMatrix * instanceMatrix * vec4(position, 1.0)).y;
#else
vSize = vec3(1.0);
vWY = (modelMatrix * vec4(position, 1.0)).y;
#endif
vLocal = position * vSize;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uCell;
uniform float uNight;
uniform float uHacker;
uniform float uTime;
uniform float uGlyphScale;
uniform sampler2D uGlyphs;
varying float vGlow;
varying vec4 vFacade;
varying vec3 vLocal;
varying vec3 vObjNormal;
varying vec3 vSize;
varying float vWY;
float h13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
// anti-aliased line at the integer crossings of x (fades out when finer than a pixel)
float aline(float x, float w) { float fw = max(fwidth(x), 1e-4); float d = abs(fract(x - 0.5) - 0.5); return (1.0 - smoothstep(w, w + fw * 1.5, d)) * (1.0 - smoothstep(0.08, 0.22, fw)); }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  float side = 1.0 - step(0.5, abs(vObjNormal.y));
  float top = step(0.5, vObjNormal.y);
  bool xFace = abs(vObjNormal.x) > 0.5;
  float halfW = (xFace ? vSize.z : vSize.x) * 0.5;
  vec2 wc = vec2(xFace ? vLocal.z : vLocal.x, vLocal.y + vSize.y * 0.5);
  float faceSeed = dot(vObjNormal, vec3(1.0, 3.0, 7.0));
  float st = floor(vFacade.x + 0.01);
  float ribbon = step(0.25, fract(vFacade.x));
  float irr = clamp(vFacade.y, 0.0, 1.0);
  float age = clamp(vFacade.z, 0.0, 1.0);
  float vSeed = vFacade.w * 977.0;
  vec2 g = vec2(wc.x + halfW, vWY) / uCell; // facade grid: cells across, storeys up (aligned between tiers)
  if (uHacker > 0.5) {
    vec3 c = diffuseColor.rgb;
    float m = max(max(c.r, c.g), max(c.b, 1e-3));
    float alive = smoothstep(0.03, 0.2, m) * (1.0 - 0.55 * age); // dimmed buildings go dark; old code glows less
    vec3 tint = mix(vec3(0.3, 0.85, 1.0), c / m, 0.45);
    diffuseColor.rgb = c * 0.03 + vec3(0.002, 0.004, 0.012); // black glass
    // the facade sets the rhythm of the text panels
    float sy = st == 1.0 ? 0.6 : st == 2.0 ? 1.6 : st == 6.0 ? 2.0 : st == 7.0 ? 0.5 : 1.0;
    float sx = st == 1.0 ? 0.6 : st == 2.0 ? 0.8 : st == 6.0 ? 0.45 : st == 3.0 ? 0.75 : 1.0;
    float speed = st == 1.0 ? 0.0 : st == 2.0 ? 0.05 : st == 3.0 ? 0.008 : (fract(vSeed * 0.618) < 0.5 ? 0.0 : 0.012 + 0.02 * fract(vSeed * 0.37));
    vec2 uv = vec2(wc.x + vSeed * 3.17 + faceSeed * 5.3, wc.y) / uGlyphScale;
    uv.y -= uTime * speed;
    float row = floor(uv.y * 64.0);
    // complex code glitches: rows jump sideways now and then
    uv.x += (h13(vec3(row, floor(uTime * 6.0), vSeed)) - 0.5) * 2.0 * irr * step(1.0 - irr * 0.35, h13(vec3(row, floor(uTime * 3.0), vSeed + 1.0)));
    float t = texture2D(uGlyphs, uv).r;
    t *= 0.45 + 0.55 * step(0.25, h13(vec3(row, vSeed, faceSeed)));
    t *= side * smoothstep(0.0, uCell * 0.6, vSize.y - wc.y);
    if (st == 9.0) t *= 0.25; // glass box: mostly clear
    if (st == 8.0) t *= 0.55; // tests: the lattice carries the face
    float storey = uCell * 2.6 * sy;
    float fy = fract(wc.y / storey);
    float panel = smoothstep(0.12, 0.18, fy) * (1.0 - smoothstep(0.82, 0.88, fy));
    float colW = uCell * 3.2 * sx;
    float fx = fract((wc.x + halfW) / colW);
    panel *= smoothstep(0.06, 0.12, fx) * (1.0 - smoothstep(0.88, 0.94, fx));
    if (st == 7.0) panel *= step(0.5, fract(wc.y / (storey * 0.5))); // data blocks: thin strips
    totalEmissiveRadiance += tint * t * 0.95 * panel * alive;
    float band = 1.0 - smoothstep(0.0, 0.012, abs(fy - 0.0)) + (1.0 - smoothstep(0.0, 0.012, abs(fy - 1.0)));
    totalEmissiveRadiance += tint * band * side * 0.35 * step(storey, vSize.y) * alive;
    totalEmissiveRadiance += vec3(0.0, 0.015, 0.04) * side * alive;
    // neon structure per facade
    float neon = 0.0;
    if (st == 4.0) { // steel: X bracing per bay
      vec2 b = vec2((wc.x + halfW) / (uCell * 2.0), wc.y / (uCell * 2.0));
      neon = max(aline(b.x - b.y, 0.03), aline(b.x + b.y, 0.03));
    } else if (st == 8.0) { // tests: diamond lattice
      vec2 q = g * 1.2;
      neon = max(aline(q.x + q.y, 0.04), aline(q.x - q.y, 0.04)) * 0.45;
    } else if (st == 6.0 || st == 10.0) { // library / colonnade: columns
      neon = aline((wc.x + halfW) / (uCell * (st == 6.0 ? 0.8 : 0.55)), 0.06) * 0.8;
    } else if (st == 9.0) {
      neon = 0.12;
    } else if (st == 5.0) { // storefront: lit shop windows at the base
      neon = (1.0 - smoothstep(uCell * 1.2, uCell * 1.3, wc.y)) * 0.5;
    }
    totalEmissiveRadiance += tint * neon * side * 0.9 * alive;
    // glowing edges (every tier is outlined)
    float ew = max(uCell * 0.045, 0.02);
    float d;
    if (side > 0.5) d = min(halfW - abs(wc.x), min(wc.y, vSize.y - wc.y));
    else d = min(vSize.x * 0.5 - abs(vLocal.x), vSize.z * 0.5 - abs(vLocal.z));
    float edge = 1.0 - smoothstep(0.0, ew, d);
    totalEmissiveRadiance += mix(vec3(0.35, 0.9, 1.0), tint, 0.3) * edge * 2.0 * alive;
    float scanY = fract(uTime * (0.08 + 0.06 * fract(vSeed * 0.731)) + fract(vSeed * 0.377)) * vSize.y;
    float scan = exp(-abs(wc.y - scanY) / max(uCell * 0.25, 0.05));
    totalEmissiveRadiance += tint * scan * side * 0.9 * alive;
    totalEmissiveRadiance += tint * vGlow * 0.8;
  } else {
    vec3 base = diffuseColor.rgb;
    vec2 rep = vec2(1.0);
    vec4 bx = vec4(0.2, 0.8, 0.28, 0.78); // window x0, x1, y0, y1 within a cell
    float glassy = 0.0, arch = 0.0, noWin = 0.0, frame = 0.0;
    vec3 frameCol = base * 0.55;
    if (st == 1.0) { // concrete grid
      rep = vec2(0.8, 1.0); bx = vec4(0.27, 0.73, 0.3, 0.7);
      base = mix(base, vec3(0.6), 0.22);
      frame = aline(g.y, 0.02) * 0.5;
      frameCol = base * 0.8;
    } else if (st == 2.0) { // glass curtain wall
      rep = vec2(0.7, 1.0); bx = vec4(0.05, 0.95, 0.06, 0.94); glassy = 1.0;
    } else if (st == 3.0) { // brick, arched windows
      rep = vec2(1.1, 1.25); bx = vec4(0.32, 0.68, 0.18, 0.56); arch = 1.0;
      vec2 bc = vec2(g.x * 3.5 + 0.5 * mod(floor(g.y * 8.0), 2.0), g.y * 8.0);
      frame = max(aline(bc.y, 0.06), aline(bc.x, 0.04) * 0.8) * 0.6;
      base = mix(base, vec3(0.55, 0.3, 0.22), 0.18);
      frameCol = mix(base, vec3(0.75), 0.5);
    } else if (st == 4.0) { // steel: X bracing per bay
      vec2 b = vec2((wc.x + halfW) / (uCell * 2.0), wc.y / (uCell * 2.0));
      frame = max(max(aline(b.x - b.y, 0.025), aline(b.x + b.y, 0.025)), aline(b.x, 0.03));
      frameCol = mix(base, vec3(0.2, 0.22, 0.25), 0.6);
      bx = vec4(0.15, 0.85, 0.2, 0.8);
    } else if (st == 5.0) { // storefront: shop windows at the base, shutters above
      if (wc.y < uCell * 1.3) { rep = vec2(1.6, 1.3); bx = vec4(0.06, 0.94, 0.05, 0.85); }
      float awning = step(uCell * 1.3, wc.y) * (1.0 - step(uCell * 1.5, wc.y));
      frame = awning * step(0.5, fract(g.x * 2.0));
      frameCol = mix(base, vec3(1.0), 0.6);
    } else if (st == 6.0) { // library: pilasters, tall windows, cornice
      rep = vec2(0.8, 1.6); bx = vec4(0.38, 0.62, 0.15, 0.85);
      base = mix(base, vec3(0.86, 0.83, 0.76), 0.3);
      float fx = fract((wc.x + halfW) / (uCell * 0.8));
      frame = max(step(fx, 0.18), 1.0 - smoothstep(uCell * 0.25, uCell * 0.3, vSize.y - wc.y)) * 0.6;
      frameCol = mix(base, vec3(1.0), 0.35);
    } else if (st == 7.0) { // utility: louvres, no windows
      noWin = 1.0;
      base = mix(base, vec3(dot(base, vec3(0.33))), 0.35);
      frame = aline(g.y * 4.0, 0.08) * 0.7;
      frameCol = base * 0.6;
    } else if (st == 8.0) { // tests: diamond lattice over glass
      rep = vec2(0.75, 1.0); bx = vec4(0.0, 1.0, 0.0, 1.0); glassy = 1.0;
      vec2 q = g * 0.9;
      frame = max(aline(q.x + q.y, 0.035), aline(q.x - q.y, 0.035));
      frameCol = mix(base, vec3(0.92), 0.4);
    } else if (st == 9.0) { // glass box
      rep = vec2(1.4, 1.4); bx = vec4(0.03, 0.97, 0.03, 0.97); glassy = 1.0;
      base = mix(base, vec3(0.8, 0.92, 1.0), 0.3);
    } else if (st == 10.0) { // colonnade
      float fx = fract((wc.x + halfW) / (uCell * 0.55));
      frame = step(fx, 0.3);
      frameCol = mix(base, vec3(0.9, 0.88, 0.82), 0.6);
      rep = vec2(0.55, 50.0); bx = vec4(0.36, 0.96, 0.0, 0.85);
    }
    if (ribbon > 0.5) { rep.x = 1.6; bx.x = 0.02; bx.y = 0.98; bx.z = 0.34; bx.w = 0.68; }
    vec2 cg = g / rep;
    if (st == 10.0) cg.y = wc.y / (vSize.y + 1e-3);
    vec2 id = floor(cg);
    vec2 f = fract(cg);
    float r = h13(vec3(id, vSeed * 1.37 + faceSeed * 17.0));
    float r2 = h13(vec3(id.yx, vSeed + 3.1));
    // complexity: windows wander off the grid and change size
    f.x += (r2 - 0.5) * irr * 0.3;
    f.y += (r - 0.5) * irr * 0.2;
    float sz = 1.0 + (h13(vec3(id, vSeed + 7.0)) - 0.5) * irr * 0.9;
    vec2 cc = vec2(bx.x + bx.y, bx.z + bx.w) * 0.5, hw = vec2(bx.y - bx.x, bx.w - bx.z) * 0.5 * sz;
    float win = step(abs(f.x - cc.x), hw.x) * step(abs(f.y - cc.y), hw.y);
    if (arch > 0.5) win = max(win, step(length((f - vec2(cc.x, cc.y + hw.y)) / hw.x), 1.0) * step(cc.y + hw.y, f.y));
    float tall = st == 10.0 ? 0.0 : uCell * 0.4;
    win *= side * (1.0 - noWin) * step(uCell * (st == 10.0 ? 0.1 : 0.8), vSize.y) * step(wc.y, vSize.y - tall);
    win *= 1.0 - frame;
    float litP = 0.52 + 0.3 * age; // old buildings: fewer lights on
    float lit = step(litP, r);
    vec3 warm = mix(vec3(1.0, 0.78, 0.45), vec3(0.75, 0.88, 1.0), step(0.8, r2));
    if (glassy > 0.5) {
      vec3 sky = mix(vec3(0.16, 0.22, 0.32), vec3(0.42, 0.55, 0.7), clamp(wc.y / max(vSize.y, 1e-3), 0.0, 1.0));
      vec3 glass = mix(base * 0.38, sky * (0.3 + 0.7 * (1.0 - uNight)), 0.35 + 0.25 * (1.0 - uNight));
      diffuseColor.rgb = mix(base, glass, win);
      float litG = step(0.74 + 0.2 * age, r); // big panes: fewer lit, softer
      totalEmissiveRadiance += win * litG * mix(warm, vec3(0.7, 0.85, 1.0), 0.6) * (0.25 + 0.4 * r2) * uNight * 0.7;
    } else {
      diffuseColor.rgb = mix(base, base * 0.45 + vec3(0.12, 0.16, 0.24), win * (0.55 - 0.15 * uNight));
      totalEmissiveRadiance += win * lit * warm * (0.55 + 0.9 * r2) * uNight * 0.7;
    }
    if (st == 10.0) totalEmissiveRadiance += (1.0 - frame) * side * vec3(1.0, 0.8, 0.55) * 0.35 * uNight; // lit lobby
    diffuseColor.rgb = mix(diffuseColor.rgb, frameCol, frame * side);
    // weathering: darker streaks running down from the roof
    float streak = smoothstep(0.55, 1.0, h13(vec3(floor(g.x * 3.0), vSeed, faceSeed))) * (0.5 + 0.5 * smoothstep(0.0, vSize.y, wc.y));
    diffuseColor.rgb *= 1.0 - age * (0.18 + 0.35 * streak * side) ;
    // roofs: a parapet rim
    float rim = 1.0 - smoothstep(0.0, uCell * 0.08, min(vSize.x * 0.5 - abs(vLocal.x), vSize.z * 0.5 - abs(vLocal.z)));
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.35 + 0.04, rim * top * 0.6);
    totalEmissiveRadiance += diffuseColor.rgb * vGlow;
  }
}`);
  };
  material.customProgramCacheKey = () => 'codecity-building-v3';
  return { material, uniforms };
}

/**
 * Standard material that, in hacker mode, lays a circuit-board texture over
 * upward faces in world space (so traces keep one scale across plots of any size).
 */
export function circuitMaterial(color: string, topOnly: boolean): { material: THREE.MeshStandardMaterial; uniforms: CircuitUniforms } {
  const uniforms: CircuitUniforms = { uHacker: { value: 0 }, uCircuit: { value: null }, uTile: { value: 50 }, uTime: { value: 0 },
    uCenter: { value: new THREE.Vector2() }, uRadius: { value: 100 } };
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.95, metalness: 0.05 });
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
varying vec3 vWorldP;
varying vec3 vObjN;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vObjN = normal;
#ifdef USE_INSTANCING
vWorldP = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
#else
vWorldP = (modelMatrix * vec4(transformed, 1.0)).xyz;
#endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uHacker;
uniform float uTile;
uniform float uTime;
uniform sampler2D uCircuit;
uniform vec2 uCenter;
uniform float uRadius;
varying vec3 vWorldP;
varying vec3 vObjN;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
if (uHacker > 0.5) {
  float up = ${topOnly ? 'step(0.5, vObjN.y)' : '1.0'};
  vec3 tr = texture2D(uCircuit, vWorldP.xz / uTile).rgb;
  float pulse = 0.75 + 0.25 * sin(uTime * 1.3 + (vWorldP.x + vWorldP.z) / uTile * 6.2831);
  float dist = distance(vWorldP.xz, uCenter);
  float fade = 1.0 - smoothstep(uRadius * 0.6, uRadius * 1.5, dist); // traces die out beyond the city
  totalEmissiveRadiance += tr * up * 0.45 * pulse * fade;
  // neon grid: fine lines every cell, brighter every 5th, anti-aliased, fading into the distance
  vec2 g = vWorldP.xz / (uTile * 0.125);
  vec2 gw = fwidth(g);
  vec2 l1 = 1.0 - smoothstep(vec2(0.0), gw * 1.5, abs(fract(g - 0.5) - 0.5));
  vec2 g5 = g / 5.0;
  vec2 gw5 = fwidth(g5);
  vec2 l5 = 1.0 - smoothstep(vec2(0.0), gw5 * 2.0, abs(fract(g5 - 0.5) - 0.5));
  float grid = max(max(l1.x, l1.y) * 0.18, max(l5.x, l5.y) * 0.6);
  float far = 1.0 - smoothstep(uRadius * 1.2, uRadius * 4.0, dist);
  totalEmissiveRadiance += vec3(0.1, 0.7, 1.0) * grid * up * far * 0.55;
}`);
  };
  material.customProgramCacheKey = () => `codecity-circuit-${topOnly ? 1 : 0}`;
  return { material, uniforms };
}

export interface CircuitUniforms {
  uHacker: { value: number };
  uCircuit: { value: THREE.Texture | null };
  uTile: { value: number };
  uTime: { value: number };
  uCenter: { value: THREE.Vector2 };
  uRadius: { value: number };
}
