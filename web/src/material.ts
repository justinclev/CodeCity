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
 * MeshStandardMaterial for instanced unit boxes.
 * - normal modes: procedural windows on the side faces (sized in world units so
 *   they don't stretch), lit at night;
 * - hacker mode: near-black glass, glowing scrolling data text sampled from a
 *   glyph atlas and tinted by the color mode, plus glowing cyan edges;
 * - always: a per-instance emissive glow (attribute aGlow) for hotspots and selection.
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
varying float vGlow;
varying vec3 vLocal;
varying vec3 vObjNormal;
varying vec3 vSize;
varying float vSeed;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vGlow = aGlow;
vObjNormal = normal;
#ifdef USE_INSTANCING
vSize = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
vSeed = float(gl_InstanceID);
#else
vSize = vec3(1.0);
vSeed = 0.0;
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
varying vec3 vLocal;
varying vec3 vObjNormal;
varying vec3 vSize;
varying float vSeed;
float h13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  float side = 1.0 - step(0.5, abs(vObjNormal.y));
  bool xFace = abs(vObjNormal.x) > 0.5;
  float halfW = (xFace ? vSize.z : vSize.x) * 0.5;
  vec2 wc = vec2(xFace ? vLocal.z : vLocal.x, vLocal.y + vSize.y * 0.5);
  float faceSeed = dot(vObjNormal, vec3(1.0, 3.0, 7.0));
  if (uHacker > 0.5) {
    vec3 c = diffuseColor.rgb;
    float m = max(max(c.r, c.g), max(c.b, 1e-3));
    float alive = smoothstep(0.03, 0.2, m);          // dimmed (search/filter) buildings go dark
    vec3 tint = mix(vec3(0.3, 0.85, 1.0), c / m, 0.45);
    diffuseColor.rgb = c * 0.05 + vec3(0.004, 0.008, 0.02);
    // scrolling data text on the sides
    float speed = (fract(vSeed * 0.618) < 0.5 ? 0.0 : 0.012 + 0.02 * fract(vSeed * 0.37));
    vec2 uv = vec2(wc.x + vSeed * 3.17 + faceSeed * 5.3, wc.y) / uGlyphScale;
    uv.y -= uTime * speed;
    float t = texture2D(uGlyphs, uv).r;
    float row = floor(uv.y * 64.0);
    t *= 0.45 + 0.55 * step(0.25, h13(vec3(row, vSeed, faceSeed)));
    t *= side * smoothstep(0.0, uCell * 0.6, vSize.y - wc.y) ;
    totalEmissiveRadiance += tint * t * 2.2 * alive;
    totalEmissiveRadiance += vec3(0.0, 0.025, 0.06) * side * alive; // faint blue glass body
    // glowing edges
    float ew = max(uCell * 0.06, 0.02);
    float d;
    if (side > 0.5) d = min(halfW - abs(wc.x), min(wc.y, vSize.y - wc.y));
    else d = min(vSize.x * 0.5 - abs(vLocal.x), vSize.z * 0.5 - abs(vLocal.z));
    float edge = 1.0 - smoothstep(0.0, ew, d);
    totalEmissiveRadiance += mix(vec3(0.35, 0.9, 1.0), tint, 0.35) * edge * 1.2 * alive;
    totalEmissiveRadiance += tint * vGlow * 0.8;
  } else {
    vec2 cell = wc / uCell;
    vec2 id = floor(cell);
    vec2 f = fract(cell);
    float win = step(0.2, f.x) * step(f.x, 0.8) * step(0.28, f.y) * step(f.y, 0.78);
    win *= side * step(uCell * 1.2, vSize.y) * step(wc.y, vSize.y - uCell * 0.4);
    float r = h13(vec3(id, vSeed * 1.37 + faceSeed * 17.0));
    float r2 = h13(vec3(id.yx, vSeed + 3.1));
    float lit = step(0.52, r);
    vec3 warm = mix(vec3(1.0, 0.78, 0.45), vec3(0.75, 0.88, 1.0), step(0.8, r2));
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.45 + vec3(0.12, 0.16, 0.24), win * (0.55 - 0.15 * uNight));
    totalEmissiveRadiance += win * lit * warm * (0.55 + 0.9 * r2) * uNight;
    totalEmissiveRadiance += diffuseColor.rgb * vGlow;
  }
}`);
  };
  material.customProgramCacheKey = () => 'codecity-building-v2';
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
  float fade = 1.0 - smoothstep(uRadius * 0.6, uRadius * 1.5, distance(vWorldP.xz, uCenter)); // traces die out beyond the city
  totalEmissiveRadiance += tr * up * 0.85 * pulse * fade;
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
