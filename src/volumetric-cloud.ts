import * as THREE from "three";

const vertex = `varying vec2 vUv; void main(){vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;
const fragment = `
uniform sampler3D uNoise;
uniform float uTime;
uniform float uLow;
uniform float uReduced;
uniform vec4 uShape;
uniform vec4 uLobes[7];
varying vec2 vUv;
float noise3(vec3 p){ return texture(uNoise,(p+.5)/32.).r; }
float turbulence(vec3 p){
  float n=noise3(p)*.64+noise3(p*2.07+11.7)*.36;
  if(uLow<.5) n=n*.86+noise3(p*4.11-4.8)*.14;
  return n;
}
float density(vec3 p){
  float t=uTime;
  float capZ=uShape.x,capR=uShape.y,thick=uShape.z,rise=uShape.w;
  vec3 q=p-vec3(0.,0.,capZ);
  float radial=length(q.xy);
  // Outward rolling motion of the cap and upward advection of the stem.
  vec3 flow=p*7.;
  flow.z-=t*1.75;
  flow.xy+=q.xy/max(radial,.01)*sin(q.z*5.-t*2.)*.65;
  float n=turbulence(flow);
  float cap=length(vec3(q.xy/(capR*.86),q.z/(thick*1.06)));
  // Cauliflower billows around the rolling cap, joined to a central volume (not a flat doughnut).
  float rolled=cap;
  for(int lobe=0;lobe<7;lobe++){
    vec3 puff=(q-uLobes[lobe].xyz)/vec3(capR*.47,capR*.47,uLobes[lobe].w);
    rolled=min(rolled,length(puff));
  }
  float head=max(0.,(1.-rolled)*2.1+(n-.48)*2.35);
  float stemR=.105+.07*exp(-p.z*5.)+.045*rise;
  float column=max(0.,1.-length(p.xy)/stemR+(n-.5)*.72);
  column*=smoothstep(-.02,.08,p.z)*(1.-smoothstep(capZ*.55,capZ+.05,p.z));
  float d=max(head,column*.95);
  // A soft lower boundary keeps the explosion on the map, with no permanent ground mark.
  d*=smoothstep(-.03,.05,p.z);
  d*=smoothstep(0.,.09,t)*(1.-smoothstep(2.0,3.78,t));
  return d;
}
void main(){
  vec2 xy=(vUv-.5)*2.5;
  // Bound the expensive work to the impact region, not the full viewport.
  if(dot(xy,xy)>1.18 || uTime>=3.8){gl_FragColor=vec4(0.);return;}
  float steps=uLow>.5?10.:20.;
  float stepSize=1.55/steps;
  float jitter=fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453);
  vec3 sum=vec3(0.); float alpha=0.;
  float heat=exp(-uTime*1.65);
  for(int i=0;i<20;i++){
    if(float(i)>=steps || alpha>.985)break;
    float z=1.45-(float(i)+jitter)*stepSize;
    // High-angle overhead projection; rising cap reveals a little of the central stem.
    vec3 p=vec3(xy.x,xy.y-z*.20,z);
    float d=density(p);
    if(d<.018)continue;
    float lighting;
    if(uLow>.5){
      float sun=density(p+vec3(-.095,.075,.11));
      lighting=clamp(.33+(d-sun)*1.35+p.z*.17,.10,1.);
    } else {
      vec3 grad=vec3(d-density(p+vec3(.055,0,0)),d-density(p+vec3(0,.055,0)),d-density(p+vec3(0,0,.055)));
      vec3 normal=grad/max(length(grad),.001);
      lighting=.16+.84*max(0.,dot(normal,normalize(vec3(-.6,.45,.8))));
    }
    float a=1.-exp(-d*stepSize*6.7);
    vec3 soot=mix(vec3(.045,.05,.055),vec3(.47,.46,.435),lighting);
    float n=noise3(p*8.+vec3(0,0,-uTime));
    float fire=heat*(.68+n*.56)*(1.-smoothstep(.28,1.15,p.z));
    vec3 flame=mix(vec3(.9,.12,.008),vec3(1.,.73,.21),clamp(fire*1.4,0.,1.));
    vec3 color=mix(soot,flame,clamp(fire*(1.-uReduced*.32),0.,1.));
    sum+=(1.-alpha)*a*color;
    alpha+=(1.-alpha)*a;
  }
  float edge=1.-smoothstep(.92,1.08,length(xy));
  gl_FragColor=vec4(sum/max(alpha,.0001),alpha*edge);
}`;

/** One bounded volume draw. The 32 KiB noise texture replaces expensive per-sample hash FBM. */
export class VolumetricCloud extends THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> {
  readonly noiseTexture: THREE.Data3DTexture;
  constructor() {
    const data = new Uint8Array(32 * 32 * 32);
    let state = 0x7e57a19;
    for (let i = 0; i < data.length; i++) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      data[i] = (state >>> 0) & 255;
    }
    const noiseTexture = new THREE.Data3DTexture(data, 32, 32, 32);
    noiseTexture.format = THREE.RedFormat;
    noiseTexture.type = THREE.UnsignedByteType;
    noiseTexture.minFilter = noiseTexture.magFilter = THREE.LinearFilter;
    noiseTexture.wrapS = noiseTexture.wrapT = noiseTexture.wrapR = THREE.RepeatWrapping;
    noiseTexture.unpackAlignment = 1;
    noiseTexture.needsUpdate = true;
    super(new THREE.PlaneGeometry(400, 400), new THREE.ShaderMaterial({
      uniforms: { uNoise: { value: noiseTexture }, uTime: { value: 0 }, uLow: { value: 0 }, uReduced: { value: 0 },
        uShape: { value: new THREE.Vector4() }, uLobes: { value: Array.from({length:7},()=>new THREE.Vector4()) } },
      vertexShader: vertex, fragmentShader: fragment,
      transparent: true, depthWrite: false, depthTest: false,
    }));
    this.noiseTexture = noiseTexture;
    this.frustumCulled = false;
    this.update(0,false,false);
  }
  update(age: number, low: boolean, reducedMotion: boolean): void {
    // Uniform-only shape motion is calculated once per frame, not for every ray sample.
    const rise=1-Math.exp(-Math.max(0,age-.10)*1.65);
    const capZ=.13+rise*.65;
    const capR=.12+(1-Math.exp(-age*4.4))*.47+rise*.075;
    const thick=.09+rise*.25;
    (this.material.uniforms.uShape!.value as THREE.Vector4).set(capZ,capR,thick,rise);
    const lobes=this.material.uniforms.uLobes!.value as THREE.Vector4[];
    for(let i=0;i<7;i++){
      const angle=i*.8976+age*.15;
      lobes[i]!.set(Math.cos(angle)*capR*.60,Math.sin(angle)*capR*.60,thick*.12*Math.sin(angle*3),thick*(.76+.09*Math.cos(angle*2)));
    }
    this.material.uniforms.uTime!.value = age;
    this.material.uniforms.uLow!.value = low ? 1 : 0;
    this.material.uniforms.uReduced!.value = reducedMotion ? 1 : 0;
    this.visible = age >= 0 && age < 3.8;
  }
  dispose(): void { this.noiseTexture.dispose(); this.geometry.dispose(); this.material.dispose(); }
}
