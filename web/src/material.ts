import * as THREE from 'three';

export interface BuildingUniforms {
  uCell: { value: number };
  uNight: { value: number };
}

/**
 * MeshStandardMaterial for instanced unit boxes with procedural windows on the
 * side faces (sized in world units, so they don't stretch with the building),
 * lit at night, plus a per-instance emissive glow (attribute aGlow) used for
 * hotspots and selection.
 */
export function buildingMaterial(): { material: THREE.MeshStandardMaterial; uniforms: BuildingUniforms } {
  const uniforms: BuildingUniforms = { uCell: { value: 1 }, uNight: { value: 1 } };
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
varying float vGlow;
varying vec3 vLocal;
varying vec3 vObjNormal;
varying vec3 vSize;
varying float vSeed;
float h13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  float side = 1.0 - step(0.5, abs(vObjNormal.y));
  vec2 wc = vec2(abs(vObjNormal.x) > 0.5 ? vLocal.z : vLocal.x, vLocal.y + vSize.y * 0.5);
  vec2 cell = wc / uCell;
  vec2 id = floor(cell);
  vec2 f = fract(cell);
  float win = step(0.2, f.x) * step(f.x, 0.8) * step(0.28, f.y) * step(f.y, 0.78);
  win *= side * step(uCell * 1.2, vSize.y) * step(wc.y, vSize.y - uCell * 0.4);
  float faceSeed = dot(vObjNormal, vec3(1.0, 3.0, 7.0));
  float r = h13(vec3(id, vSeed * 1.37 + faceSeed * 17.0));
  float r2 = h13(vec3(id.yx, vSeed + 3.1));
  float lit = step(0.52, r);
  vec3 warm = mix(vec3(1.0, 0.78, 0.45), vec3(0.75, 0.88, 1.0), step(0.8, r2));
  // day: windows are darker, bluish glass; night: dark glass, some panes lit
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.45 + vec3(0.12, 0.16, 0.24), win * (0.55 - 0.15 * uNight));
  totalEmissiveRadiance += win * lit * warm * (0.55 + 0.9 * r2) * uNight;
  totalEmissiveRadiance += diffuseColor.rgb * vGlow;
}`);
  };
  // the injected code depends on these uniforms only, so all buildings share one program
  material.customProgramCacheKey = () => 'codecity-building-v1';
  return { material, uniforms };
}
