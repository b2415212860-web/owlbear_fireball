import * as THREE from "three";

// Small, spatially coherent turbulence. No full-screen buffers or postprocessing passes.
const noise = `
float hash31(vec3 p) {
  p = fract(p * .1031); p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
float noise3(vec3 p) {
  vec3 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(mix(hash31(i),hash31(i+vec3(1,0,0)),f.x),
                 mix(hash31(i+vec3(0,1,0)),hash31(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash31(i+vec3(0,0,1)),hash31(i+vec3(1,0,1)),f.x),
                 mix(hash31(i+vec3(0,1,1)),hash31(i+vec3(1,1,1)),f.x),f.y),f.z);
}
float fbm(vec3 p) { return noise3(p)*.57 + noise3(p*2.03+7.1)*.28 + noise3(p*4.07-3.7)*.15; }
vec3 flameColor(float heat) {
  vec3 red=vec3(.62,.024,.002), orange=vec3(1.,.22,.009), yellow=vec3(1.,.73,.16), white=vec3(1.,.98,.78);
  vec3 c=mix(red,orange,smoothstep(.08,.42,heat));
  c=mix(c,yellow,smoothstep(.4,.76,heat));
  return mix(c,white,smoothstep(.78,1.,heat));
}`;

export const sphereVertex = `
uniform float uTime;
varying vec3 vLocal; varying vec3 vNormal;
${noise}
void main(){
  vLocal=position;
  float n=fbm(position*3.8+vec3(-uTime*1.2,uTime*.8,uTime*.5));
  // Keep a round silhouette. Small gas-surface deformation is not projectile elongation.
  vec3 p=position*(.975+.052*n);
  vNormal=normalize(normalMatrix*normal);
  gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);
}`;
export const sphereFragment = `
uniform float uTime;
varying vec3 vLocal; varying vec3 vNormal;
${noise}
void main(){
  vec3 p=vLocal*4.2;
  p.xy+=vec2(sin(p.z+uTime*.9),cos(p.x-uTime*1.1))*.48;
  vec3 flow=p+vec3(-uTime*1.6,uTime*.65,uTime*.35);
  float n=fbm(flow);
  float filament=1.-smoothstep(.025,.17,abs(n-.51));
  float pockets=fbm(flow*1.9+vec3(2,0,-uTime*.6));
  float facing=max(0.,vNormal.z);
  float heat=clamp(.25+n*.60+filament*.27+pockets*.14,0.,1.);
  vec3 color=flameColor(heat);
  color*=.62+.38*pow(facing,.35);
  color+=vec3(.28,.055,.001)*pow(1.-facing,1.8);
  gl_FragColor=vec4(color,1.);
}`;

const planeVertex = `varying vec2 vUv; void main(){vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;

/** Thin turbulent gas sheath preserves the spherical head instead of drawing a solid orange dot. */
export function makeFireCorona(): THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> {
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } }, vertexShader: planeVertex,
    fragmentShader: `
      uniform float uTime; varying vec2 vUv; ${noise}
      void main(){
        vec2 p=(vUv-.5)*2.; float r=length(p);
        float n=fbm(vec3(p*5.,uTime*1.7));
        float front=.66+(n-.5)*.18;
        float edge=1.-smoothstep(front-.08,front+.16,r);
        float rim=smoothstep(.39,.61,r)*edge;
        float wisps=pow(max(0.,n-.24),1.5);
        gl_FragColor=vec4(flameColor(.3+n*.5),rim*wisps*.72);
      }`,
    transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), material);
  mesh.renderOrder = 5;
  return mesh;
}

/** Batched soft flame tongues, positioned behind (never stretched through) the spherical head. */
export function makeFlameTrail(count: number): THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial> {
  const plane = new THREE.PlaneGeometry(1, 1);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = plane.index; geometry.attributes = plane.attributes;
  geometry.setAttribute("aAge", new THREE.InstancedBufferAttribute(
    Float32Array.from({ length: count }, (_, i) => ((i % 16) * 2 + Math.floor(i / 16)) / count), 1));
  geometry.instanceCount = count;
  const material = new THREE.ShaderMaterial({
    uniforms: { uFrom: { value: new THREE.Vector2() }, uTo: { value: new THREE.Vector2() },
      uProgress: { value: 0 }, uTime: { value: 0 }, uSize: { value: 20 } },
    vertexShader: `
      uniform vec2 uFrom,uTo; uniform float uProgress,uTime,uSize;
      attribute float aAge; varying vec2 vUv; varying float vAge; varying float vAlpha;
      void main(){
        vUv=uv; vAge=aAge;
        float t=max(0.,uProgress-aAge*.29);
        float eased=t*t*(.65+t*.35);
        vec2 delta=uTo-uFrom;
        vec2 axis=delta/max(length(delta),.001); vec2 across=vec2(-axis.y,axis.x);
        vec2 center=mix(uFrom,uTo,eased)-axis*uSize*.28;
        center+=across*sin(aAge*27.-uTime*9.)*uSize*aAge*.43;
        float size=uSize*(1.75-aAge*1.15);
        vec2 local=axis*position.x*size*1.25+across*position.y*size;
        vAlpha=(1.-aAge)*smoothstep(0.,.025,t);
        gl_Position=projectionMatrix*modelViewMatrix*vec4(center+local,1.,1.);
      }`,
    fragmentShader: `
      uniform float uTime; varying vec2 vUv; varying float vAge,vAlpha; ${noise}
      void main(){
        vec2 p=(vUv-.5)*2.;
        float n=fbm(vec3(p*2.5+vec2(uTime*-3.,vAge*7.),vAge*8.-uTime));
        float density=(1.-smoothstep(.23,.95,length(p)+(.5-n)*.5));
        float heat=clamp(.88-vAge*.56+(n-.5)*.5,0.,1.);
        float alpha=density*vAlpha*(.28+n*.25);
        gl_FragColor=vec4(flameColor(heat),alpha);
      }`,
    transparent: true, depthWrite: false, depthTest: false,
  });
  const trail = new THREE.Mesh(geometry, material);
  trail.frustumCulled = false; trail.renderOrder = 2;
  return trail;
}

/** Fast fire-front breakup at impact, followed by a distinct pressure/dust front. */
export function makeDetonation(): THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> {
  return new THREE.Mesh(new THREE.PlaneGeometry(320, 320), new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uReduced: { value: 0 } }, vertexShader: planeVertex,
    fragmentShader: `
      uniform float uTime,uReduced; varying vec2 vUv; ${noise}
      void main(){
        vec2 p=(vUv-.5)*2.; float r=length(p);
        float t=max(0.,uTime);
        float n=fbm(vec3(p*6.,t*2.1));
        float radius=.08+.61*(1.-exp(-t*15.));
        float boundary=radius+(n-.5)*.2;
        float body=1.-smoothstep(boundary-.17,boundary+.045,r);
        float heat=clamp(.77+n*.42-r*.25-t*.7,0.,1.);
        float flash=exp(-r*r*42.)*exp(-t*25.)*(1.-uReduced*.8);
        float fade=1.-smoothstep(.17,.64,t);
        vec3 color=mix(flameColor(heat),vec3(1.,.98,.88),flash);
        gl_FragColor=vec4(color,clamp(body*fade+flash*.7,0.,.97));
      }`, transparent: true, depthWrite: false, depthTest: false,
  }));
}

export function makePressureWave(): THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> {
  return new THREE.Mesh(new THREE.PlaneGeometry(352, 352), new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uReduced: { value: 0 } }, vertexShader: planeVertex,
    fragmentShader: `
      uniform float uTime,uReduced; varying vec2 vUv; ${noise}
      void main(){
        vec2 p=(vUv-.5)*2.; float r=length(p);
        float t=max(0.,uTime-.045);
        float n=noise3(vec3(p*18.,0.));
        float front=.1+.84*(1.-exp(-t*6.));
        float d=r-front-(n-.5)*.015;
        float pressure=(1.-smoothstep(.005,.019,abs(d)))*.42;
        float dust=(1.-smoothstep(.02,.10,abs(d+.036)))*(.28+n*.28);
        float fade=smoothstep(0.,.035,t)*(1.-smoothstep(.23,1.0,t));
        float heat=exp(-t*9.);
        vec3 color=mix(vec3(.50,.44,.36),vec3(1.,.84,.56),heat);
        color=mix(color,vec3(.88,.9,.87),pressure);
        float glow=exp(-r*r*5.)*exp(-uTime*7.)*.16;
        gl_FragColor=vec4(color,((pressure+dust)*fade+glow)*(1.-uReduced*.65));
      }`, transparent: true, depthWrite: false, depthTest: false,
  }));
}
