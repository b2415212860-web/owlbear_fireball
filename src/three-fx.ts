import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import {
  EXPLOSION_SECONDS, EXPLOSION_VOLUME, VOLUME_NOISE,
  fireVertexShader, fireFragmentShader,
} from "./cinematic-shaders";

export interface FxPoint { x: number; y: number }

interface ActiveCast {
  from: THREE.Vector3;
  to: THREE.Vector3;
  startedAt: number;
  impacted: boolean;
  onImpact: () => void;
  resolve: () => void;
  frameCount: number;
}

const FLIGHT_SECONDS = 0.82;
const SPARK_COUNT = 720;
const DEBRIS_COUNT = 88;
const DUST_COUNT = 64;
const TRAIL_COUNT = 96;

const planeVertexShader = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const particleVertexShader = `
uniform float uTime;
uniform float uPixelRatio;
uniform float uScale;
attribute vec3 aVelocity;
attribute float aDelay;
attribute float aLife;
attribute float aSize;
attribute float aKind;
varying float vAlpha;
varying float vHeat;
varying float vKind;
varying vec2 vDirection;
void main() {
  float age = max(0.0, uTime - aDelay);
  float life = age / aLife;
  float travel = (1.0 - exp(-age * 2.5)) / 2.5;
  vec3 p = position + vec3(aVelocity.xy * travel, 0.0);
  // XY is the map. Gravity acts along Z, not toward the bottom of the screen.
  p.z = max(0.0, aVelocity.z * age - 145.0 * age * age);
  vAlpha = step(aDelay, uTime) * (1.0 - smoothstep(0.4, 1.0, life));
  vHeat = 1.0 - clamp(life, 0.0, 1.0);
  vKind = aKind;
  vDirection = normalize(aVelocity.xy + vec2(0.001));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = aSize * uPixelRatio * uScale * mix(0.45, 1.0, vHeat);
  if (aKind > 1.5) gl_PointSize = aSize * uPixelRatio * uScale * (0.7 + age * 0.14);
}
`;

const particleFragmentShader = `
varying float vAlpha;
varying float vHeat;
varying float vKind;
varying vec2 vDirection;
${VOLUME_NOISE}
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  uv.y = -uv.y;
  vec2 p = vec2(dot(uv, vDirection), dot(uv, vec2(-vDirection.y, vDirection.x)));
  float streak = 1.0 - smoothstep(0.14, 0.5, length(p * vec2(1.1, 5.5)));
  vec3 color = fireColor(vHeat * 0.52 + 0.15);
  streak *= 0.38;
  if (vKind > 0.5) {
    streak = 1.0 - smoothstep(0.21, 0.46, length(p * vec2(1.0, 1.7)));
    color = mix(vec3(0.08, 0.065, 0.05), fireColor(vHeat * 0.52), vHeat * 0.7);
  }
  if (vKind > 1.5) {
    float breakup = fbm(vec3(uv * 6.0, vHeat * 2.0));
    streak = (1.0 - smoothstep(0.15, 0.5, length(uv))) * smoothstep(0.15, 0.75, breakup) * 0.11;
    color = vec3(0.20, 0.17, 0.13);
  }
  gl_FragColor = vec4(color, streak * vAlpha);
}
`;

const trailVertexShader = `
uniform float uPixelRatio;
uniform float uFade;
attribute float aAge;
varying float vAlpha;
varying float vHeat;
void main() {
  vHeat = 1.0 - aAge;
  vAlpha = pow(vHeat, 1.5) * uFade * 0.52;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = (4.0 + 22.0 * vHeat) * uPixelRatio;
}
`;

const trailFragmentShader = `
varying float vAlpha;
varying float vHeat;
${VOLUME_NOISE}
void main() {
  float edge = 1.0 - smoothstep(0.05, 0.5, length(gl_PointCoord - 0.5));
  gl_FragColor = vec4(fireColor(vHeat * 0.68 + 0.1), edge * vAlpha);
}
`;

const shockFragmentShader = `
uniform float uTime;
varying vec2 vUv;
void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float radius = length(p);
  float angle = atan(p.y, p.x);
  float front = 0.035 + 0.83 * (1.0 - exp(-uTime * 5.5));
  float breakup = sin(angle * 13.0 + uTime * 3.0) * 0.007;
  float ring = exp(-pow((radius - front - breakup) / 0.015, 2.0));
  float dust = exp(-pow((radius - front + 0.035) / 0.075, 2.0));
  float fade = (1.0 - smoothstep(0.08, 0.78, uTime)) * smoothstep(0.0, 0.035, uTime);
  gl_FragColor = vec4(mix(vec3(0.65, 0.29, 0.09), vec3(2.0, 1.1, 0.44), ring),
                      (ring * 0.40 + dust * 0.10) * fade);
}
`;

const lensFragmentShader = `
uniform float uTime;
varying vec2 vUv;
void main() {
  vec2 p = vUv - 0.5;
  float line = exp(-abs(p.y) * 150.0) * exp(-abs(p.x) * 8.0);
  float flash = exp(-uTime * 15.0);
  gl_FragColor = vec4(2.0, 0.72, 0.20, line * flash * 0.5);
}
`;

const filmShader = {
  uniforms: {
    tDiffuse: { value: null }, uTime: { value: 0 },
    uCenter: { value: new THREE.Vector2() }, uImpulse: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: planeVertexShader,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uCenter;
    uniform float uImpulse;
    uniform vec2 uResolution;
    varying vec2 vUv;
    void main() {
      vec2 delta = (vUv - uCenter) * uResolution;
      float r = length(delta);
      float localMask = exp(-r * r / 68000.0);
      vec2 displacement = delta / max(r, 1.0) / uResolution;
      displacement *= sin(r * 0.09 - uTime * 22.0) * uImpulse * localMask * 2.0;
      vec4 source = texture2D(tDiffuse, vUv + displacement);
      float fringe = uImpulse * localMask * 0.65;
      source.r = mix(source.r, texture2D(tDiffuse, vUv + displacement * 1.65).r, fringe);
      source.b = mix(source.b, texture2D(tDiffuse, vUv - displacement * 0.4).b, fringe);
      // Restore coverage after Bloom. Empty pixels stay transparent over the map.
      float glow = max(source.r, max(source.g, source.b));
      float alpha = max(source.a, clamp(glow * 0.42, 0.0, 0.9));
      vec3 color = source.rgb / max(alpha, 0.001);
      float grain = fract(sin(dot(vUv * uResolution + uTime, vec2(12.9898,78.233))) * 43758.5453);
      color *= 1.0 + (grain - 0.5) * 0.024;
      gl_FragColor = vec4(color, alpha);
    }
  `,
};

export class ThreeFireballPrototype {
  readonly particleCount = SPARK_COUNT + DEBRIS_COUNT + DUST_COUNT + TRAIL_COUNT;
  lastAverageFps = 0;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 3000);
  private readonly composer: EffectComposer;
  private readonly bloomPass: UnrealBloomPass;
  private readonly filmPass: ShaderPass;
  private readonly fireball = new THREE.Group();
  private readonly explosion = new THREE.Group();
  private readonly fireMaterial: THREE.ShaderMaterial;
  private readonly cloudMaterial: THREE.ShaderMaterial;
  private readonly shockMaterial: THREE.ShaderMaterial;
  private readonly lensMaterial: THREE.ShaderMaterial;
  private readonly glowMaterial: THREE.SpriteMaterial;
  private readonly glow: THREE.Sprite;
  private readonly particles: THREE.Points[];
  private readonly trail: THREE.Points;
  private readonly trailMaterial: THREE.ShaderMaterial;
  private readonly trailPositions = new Float32Array(TRAIL_COUNT * 3);
  private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  private activeCast: ActiveCast | null = null;
  private animationFrame = 0;
  private width = 1;
  private height = 1;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      alpha: true, premultipliedAlpha: false, antialias: false, powerPreference: "high-performance",
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.domElement.className = "three-fx-canvas";
    this.renderer.domElement.setAttribute("aria-hidden", "true");
    container.append(this.renderer.domElement);
    this.camera.position.z = 1000;

    this.composer = new EffectComposer(this.renderer);
    const renderPass = new RenderPass(this.scene, this.camera);
    renderPass.clearAlpha = 0;
    this.composer.addPass(renderPass);
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.42, 0.42, 1.1);
    // The stock Bloom blur emits opaque alpha. Preserve scene coverage when adding it.
    this.bloomPass.blendMaterial.blending = THREE.CustomBlending;
    this.bloomPass.blendMaterial.blendSrc = THREE.OneFactor;
    this.bloomPass.blendMaterial.blendDst = THREE.OneFactor;
    this.bloomPass.blendMaterial.blendSrcAlpha = THREE.ZeroFactor;
    this.bloomPass.blendMaterial.blendDstAlpha = THREE.OneFactor;
    this.composer.addPass(this.bloomPass);
    this.filmPass = new ShaderPass(filmShader);
    this.composer.addPass(this.filmPass);
    this.composer.addPass(new OutputPass());

    const texture = createGlowTexture();
    this.fireMaterial = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } }, vertexShader: fireVertexShader,
      fragmentShader: fireFragmentShader, transparent: true, depthWrite: false,
    });
    const fire = new THREE.Mesh(new THREE.IcosahedronGeometry(19, 4), this.fireMaterial);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texture, color: 0xff4b0a, opacity: 0.4, transparent: true,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    halo.scale.set(96, 96, 1);
    fire.renderOrder = 4;
    this.fireball.add(halo, fire);
    this.fireball.visible = false;
    this.scene.add(this.fireball);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(this.trailPositions, 3));
    geometry.setAttribute("aAge", new THREE.BufferAttribute(
      Float32Array.from({ length: TRAIL_COUNT }, (_, i) => i / TRAIL_COUNT), 1,
    ));
    this.trailMaterial = new THREE.ShaderMaterial({
      uniforms: { uPixelRatio: { value: this.renderer.getPixelRatio() }, uFade: { value: 1 } },
      vertexShader: trailVertexShader, fragmentShader: trailFragmentShader,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.trail = new THREE.Points(geometry, this.trailMaterial);
    this.trail.frustumCulled = false;
    this.trail.visible = false;
    this.scene.add(this.trail);

    this.cloudMaterial = makePlaneMaterial(`
      uniform float uTime;
      varying vec2 vUv;
      ${EXPLOSION_VOLUME}
      void main() { gl_FragColor = explosionVolume(vUv, uTime); }
    `);
    const cloud = new THREE.Mesh(new THREE.PlaneGeometry(360, 360), this.cloudMaterial);
    cloud.renderOrder = 3;
    this.shockMaterial = makePlaneMaterial(shockFragmentShader, true);
    const shock = new THREE.Mesh(new THREE.PlaneGeometry(384, 384), this.shockMaterial);
    shock.renderOrder = 1;
    this.lensMaterial = makePlaneMaterial(lensFragmentShader, true);
    const lens = new THREE.Mesh(new THREE.PlaneGeometry(820, 110), this.lensMaterial);
    lens.renderOrder = 6;
    this.glowMaterial = new THREE.SpriteMaterial({
      map: texture, color: 0xff670e, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.glow = new THREE.Sprite(this.glowMaterial);
    this.glow.renderOrder = 0;
    this.explosion.add(this.glow, shock, cloud, lens);
    this.particles = [
      createParticles(SPARK_COUNT, 0, 0x51f15e),
      createParticles(DEBRIS_COUNT, 1, 0xd3b74a),
      createParticles(DUST_COUNT, 2, 0x9e3779),
    ];
    for (const points of this.particles) {
      points.renderOrder = points === this.particles[2] ? 2 : 5;
      this.explosion.add(points);
    }
    this.explosion.visible = false;
    this.scene.add(this.explosion);
    this.resize();
    window.addEventListener("resize", this.resize);
  }

  play(from: FxPoint, to: FxPoint, onImpact: () => void, radius = 208): Promise<void> {
    if (this.activeCast) return Promise.resolve();
    this.fireball.visible = true;
    this.trail.visible = true;
    this.trailMaterial.uniforms.uFade!.value = 1;
    this.explosion.visible = false;
    this.explosion.scale.setScalar(radius / 160);
    this.filmPass.uniforms.uCenter!.value.set(to.x / this.width, 1 - to.y / this.height);
    this.filmPass.uniforms.uImpulse!.value = 0;
    for (const points of this.particles) {
      (points.material as THREE.ShaderMaterial).uniforms.uScale!.value = radius / 160;
    }
    return new Promise((resolve) => {
      this.activeCast = {
        from: this.screenToWorld(from), to: this.screenToWorld(to),
        startedAt: performance.now(), impacted: false, onImpact, resolve, frameCount: 0,
      };
      this.animationFrame = requestAnimationFrame(this.animate);
    });
  }

  private readonly animate = (now: number): void => {
    const cast = this.activeCast;
    if (!cast) return;
    cast.frameCount++;
    const time = (now - cast.startedAt) / 1000;
    this.filmPass.uniforms.uTime!.value = time;
    if (time < FLIGHT_SECONDS) {
      this.updateFlight(cast, time);
    } else {
      if (!cast.impacted) {
        cast.impacted = true;
        this.fireball.visible = false;
        this.explosion.visible = true;
        this.explosion.position.copy(cast.to);
        cast.onImpact();
      }
      this.updateExplosion(time - FLIGHT_SECONDS);
    }
    this.composer.render();
    if (time >= FLIGHT_SECONDS + EXPLOSION_SECONDS) {
      this.finishCast(cast);
    } else {
      this.animationFrame = requestAnimationFrame(this.animate);
    }
  };

  private updateFlight(cast: ActiveCast, time: number): void {
    const position = flightPosition(cast, time);
    const ahead = flightPosition(cast, Math.min(FLIGHT_SECONDS, time + 0.005));
    this.fireball.position.copy(position);
    this.fireball.rotation.z = Math.atan2(ahead.y - position.y, ahead.x - position.x);
    this.fireball.scale.set(1.12 + time * 0.20, 0.89, 1.0);
    this.fireMaterial.uniforms.uTime!.value = time;
    this.bloomPass.strength = 0.42;
    // Sample the trajectory in seconds so 30 Hz and 144 Hz have the same tail.
    for (let index = 0; index < TRAIL_COUNT; index++) {
      const age = index * 0.004;
      const point = flightPosition(cast, Math.max(0, time - age));
      const spread = age * 14;
      this.trailPositions[index * 3] = point.x + Math.sin(index * 2.4 + time * 8) * spread;
      this.trailPositions[index * 3 + 1] = point.y + Math.cos(index * 1.7 + time * 9) * spread;
      this.trailPositions[index * 3 + 2] = point.z;
    }
    this.trail.geometry.getAttribute("position").needsUpdate = true;
  }

  private updateExplosion(time: number): void {
    for (const material of [this.cloudMaterial, this.shockMaterial, this.lensMaterial]) {
      material.uniforms.uTime!.value = time;
    }
    for (const points of this.particles) {
      (points.material as THREE.ShaderMaterial).uniforms.uTime!.value = time;
    }
    this.trailMaterial.uniforms.uFade!.value = Math.max(0, 1 - time / 0.22);
    this.trail.visible = time < 0.22;
    this.glow.scale.setScalar(160 + 220 * (1 - Math.exp(-time * 9)));
    this.glowMaterial.opacity = 0.60 * Math.exp(-time * 3.8);
    const impact = Math.exp(-time * 7);
    this.bloomPass.strength = 0.28 + impact * 0.40;
    this.filmPass.uniforms.uImpulse!.value = this.reducedMotion ? 0 : Math.exp(-time * 3.8);
    if (this.reducedMotion) this.lensMaterial.uniforms.uTime!.value = 10;
  }

  private finishCast(cast: ActiveCast): void {
    this.fireball.visible = this.explosion.visible = this.trail.visible = false;
    this.renderer.setRenderTarget(null);
    this.renderer.clear();
    const elapsed = Math.max(0.001, (performance.now() - cast.startedAt) / 1000);
    this.lastAverageFps = Math.round(cast.frameCount / elapsed);
    this.activeCast = null;
    cast.resolve();
  }

  private screenToWorld(point: FxPoint): THREE.Vector3 {
    return new THREE.Vector3(point.x - this.width / 2, this.height / 2 - point.y, 0);
  }

  private readonly resize = (): void => {
    const oldWidth = this.width;
    const oldHeight = this.height;
    this.width = Math.max(1, window.innerWidth);
    this.height = Math.max(1, window.innerHeight);
    this.camera.left = -this.width / 2;
    this.camera.right = this.width / 2;
    this.camera.top = this.height / 2;
    this.camera.bottom = -this.height / 2;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.width, this.height, false);
    this.composer.setSize(this.width, this.height);
    this.filmPass.uniforms.uResolution!.value.set(this.width, this.height);
    if (this.activeCast) {
      const delta = new THREE.Vector3((oldWidth - this.width) / 2, (this.height - oldHeight) / 2, 0);
      this.activeCast.from.add(delta);
      this.activeCast.to.add(delta);
      this.explosion.position.copy(this.activeCast.to);
      this.filmPass.uniforms.uCenter!.value.set(
        this.activeCast.to.x / this.width + 0.5, this.activeCast.to.y / this.height + 0.5,
      );
    }
    for (const points of this.particles) {
      (points.material as THREE.ShaderMaterial).uniforms.uPixelRatio!.value = this.renderer.getPixelRatio();
    }
  };

  dispose(): void {
    cancelAnimationFrame(this.animationFrame);
    window.removeEventListener("resize", this.resize);
    this.activeCast?.resolve();
    this.activeCast = null;
    const textures = new Set<THREE.Texture>();
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.Sprite) {
        if (!(object instanceof THREE.Sprite)) object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          if ("map" in material && material.map instanceof THREE.Texture) textures.add(material.map);
          material.dispose();
        }
      }
    });
    textures.forEach((texture) => texture.dispose());
    this.composer.passes.forEach((pass) => pass.dispose());
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

function flightPosition(cast: ActiveCast, time: number): THREE.Vector3 {
  const t = Math.min(1, time / FLIGHT_SECONDS);
  const eased = t * t * (0.65 + 0.35 * t);
  const position = cast.from.clone().lerp(cast.to, eased);
  position.y += Math.sin(eased * Math.PI) * Math.min(46, cast.from.distanceTo(cast.to) * 0.08);
  position.z = Math.sin(eased * Math.PI) * 24;
  return position;
}

function makePlaneMaterial(fragmentShader: string, additive = false): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } }, vertexShader: planeVertexShader, fragmentShader,
    transparent: true, depthWrite: false, depthTest: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}

function createParticles(count: number, kind: number, seed: number): THREE.Points {
  const random = mulberry32(seed);
  const positions = new Float32Array(count * 3);
  const velocities = new Float32Array(count * 3);
  const delays = new Float32Array(count);
  const lives = new Float32Array(count);
  const sizes = new Float32Array(count);
  const kinds = new Float32Array(count).fill(kind);
  for (let i = 0; i < count; i++) {
    const angle = random() * Math.PI * 2;
    const speed = kind === 2 ? 130 + random() * 160 : 100 + Math.pow(random(), 0.55) * 290;
    velocities[i * 3] = Math.cos(angle) * speed;
    velocities[i * 3 + 1] = Math.sin(angle) * speed;
    velocities[i * 3 + 2] = 35 + random() * 140;
    delays[i] = random() * (kind === 2 ? 0.3 : 0.22);
    lives[i] = kind === 2 ? 1.1 + random() * 0.9 : 0.45 + random() * (kind === 1 ? 1.25 : 1.8);
    sizes[i] = kind === 2 ? 30 + random() * 46 : kind === 1 ? 3 + random() * 6 : 3 + random() * 10;
  }
  const geometry = new THREE.BufferGeometry();
  for (const [name, data, itemSize] of [
    ["position", positions, 3], ["aVelocity", velocities, 3], ["aDelay", delays, 1],
    ["aLife", lives, 1], ["aSize", sizes, 1], ["aKind", kinds, 1],
  ] as const) geometry.setAttribute(name, new THREE.BufferAttribute(data, itemSize));
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: -10 }, uPixelRatio: { value: 1 }, uScale: { value: 1 } },
    vertexShader: particleVertexShader, fragmentShader: particleFragmentShader,
    transparent: true, depthWrite: false, depthTest: false,
    blending: kind === 0 ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return points;
}

function createGlowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is unavailable");
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.15, "rgba(255,255,255,.7)");
  gradient.addColorStop(0.45, "rgba(255,255,255,.15)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(canvas);
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
