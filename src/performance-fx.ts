import * as THREE from "three";
import { sphereVertex, sphereFragment, makeFireCorona, makeFlameTrail, makeDetonation, makePressureWave } from "./cinematic-visuals";
import { VolumetricCloud } from "./volumetric-cloud";
import { createExplosionProfile, explosionLayers, normalizeEffectSeed, TAIL_DISSIPATION_SECONDS } from "./explosion-profile";

export interface FxPoint { x: number; y: number }
export type FxQuality = "auto" | "standard" | "low";
export interface FxRenderer {
  readonly kind: "webgl" | "canvas";
  readonly particleCount: number;
  readonly currentQuality: "standard" | "low";
  lastAverageFps: number;
  ready(): Promise<void>;
  play(from: FxPoint, to: FxPoint, onImpact: () => void, radius?: number, onStarted?: () => void, seed?: number): Promise<void>;
  setProjection(from: FxPoint, to: FxPoint, radius: number): void;
  setQuality(quality: FxQuality): void;
  cancel(): void;
  dispose(): void;
}

interface ActiveCast {
  from: FxPoint;
  to: FxPoint;
  radius: number;
  seed: number;
  startedAt: number;
  previousFrame: number;
  frames: number;
  slowFrames: number;
  impacted: boolean;
  onImpact: () => void;
  onStarted?: () => void;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

export const FLIGHT_SECONDS = 0.9;
export const EXPLOSION_SECONDS = 3.8;
export const TOTAL_SECONDS = FLIGHT_SECONDS + EXPLOSION_SECONDS;
const BUDGETS = {
  standard: { sparks: 320, trail: 32, width: 1280, height: 720 },
  low: { sparks: 120, trail: 16, width: 960, height: 540 },
};

/** Rendering owns no Owlbear state. Projection updates only replace a few numbers. */
abstract class FireballRendererBase implements FxRenderer {
  abstract readonly kind: "webgl" | "canvas";
  abstract get particleCount(): number;
  lastAverageFps = 0;
  protected active: ActiveCast | null = null;
  protected disposed = false;
  protected failure: Error | null = null;
  protected width = 1;
  protected height = 1;
  protected resolutionScale = 1;
  protected readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  protected quality: FxQuality;
  private effectiveQuality: "standard" | "low";
  private animationFrame = 0;
  private watchdog = 0;

  constructor(protected readonly canvas: HTMLCanvasElement, container: HTMLElement, quality: FxQuality) {
    this.quality = quality;
    this.effectiveQuality = chooseQuality(quality, this.reducedMotion);
    canvas.className = "three-fx-canvas";
    canvas.setAttribute("aria-hidden", "true");
    Object.assign(canvas.style, {
      position: "fixed", inset: "0", width: "100%", height: "100%", pointerEvents: "none",
    });
    container.append(canvas);
    window.addEventListener("resize", this.resize);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  get currentQuality(): "standard" | "low" { return this.effectiveQuality; }
  protected get budget() { return BUDGETS[this.effectiveQuality]; }
  abstract ready(): Promise<void>;
  protected abstract resizeSurface(): void;
  protected abstract draw(cast: ActiveCast, seconds: number): void;
  protected abstract clearSurface(): void;
  protected abstract destroySurface(): void;

  setQuality(quality: FxQuality): void {
    if (this.disposed) return;
    this.quality = quality;
    this.effectiveQuality = chooseQuality(quality, this.reducedMotion);
    this.resize();
  }

  setProjection(from: FxPoint, to: FxPoint, radius: number): void {
    validateProjection(from, to, radius);
    if (!this.active) return;
    this.active.from.x = from.x;
    this.active.from.y = from.y;
    this.active.to.x = to.x;
    this.active.to.y = to.y;
    this.active.radius = radius;
    const pixelRadius = this.currentQuality === "low" ? 220 : 300;
    const desiredScale = Math.min(1, this.budget.width / this.width, this.budget.height / this.height, pixelRadius / radius);
    if (Math.abs(desiredScale - this.resolutionScale) / this.resolutionScale > .08) this.resize();
  }

  play(from: FxPoint, to: FxPoint, onImpact: () => void, radius = 160, onStarted?: () => void, seed = 0xf1b411): Promise<void> {
    try {
      this.checkAvailable();
      validateProjection(from, to, radius);
      if (this.active) throw new Error("Fireball renderer is already playing");
      if (document.hidden) throw new Error("Fireball renderer is not visible");
    } catch (error) { return Promise.reject(error); }

    return new Promise<void>((resolve, reject) => {
      const cast: ActiveCast = {
        from: { ...from }, to: { ...to }, radius, seed: normalizeEffectSeed(seed), startedAt: 0, previousFrame: 0,
        frames: 0, slowFrames: 0, impacted: false, onImpact, onStarted, resolve, reject,
      };
      this.active = cast;
      void this.ready().then(() => {
        if (this.active !== cast || this.disposed) return;
        this.resize();
        cast.startedAt = performance.now();
        cast.previousFrame = cast.startedAt;
        // An iframe whose frames stop must never leave the calling workflow locked.
        this.watchdog = window.setTimeout(() => {
          if (this.active === cast) this.finish(new Error("Fireball rendering timed out"));
        }, 6500);
        this.animationFrame = requestAnimationFrame(this.animate);
      }).catch((error: unknown) => {
        if (this.active === cast) this.finish(error);
      });
    });
  }

  cancel(): void { this.finish(); }

  dispose(): void {
    if (this.disposed) return;
    this.cancel();
    this.disposed = true;
    window.removeEventListener("resize", this.resize);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.destroySurface();
    this.canvas.remove();
  }

  protected checkAvailable(): void {
    if (this.disposed) throw new Error("Fireball renderer has been disposed");
    if (this.failure) throw this.failure;
  }

  protected fail(error: Error): void {
    this.failure = error;
    this.finish(error);
  }

  protected readonly resize = (): void => {
    if (this.disposed) return;
    this.width = Math.max(1, window.innerWidth);
    this.height = Math.max(1, window.innerHeight);
    // Cap both dimensions, including high-DPI and portrait displays; CSS pixels stay unchanged.
    const impactPixelRadius = this.currentQuality === "low" ? 220 : 300;
    const volumeScale = this.active ? impactPixelRadius / this.active.radius : 1;
    this.resolutionScale = Math.min(1, this.budget.width / this.width, this.budget.height / this.height, volumeScale);
    this.resizeSurface();
  };

  private readonly onVisibilityChange = (): void => {
    if (document.hidden) this.cancel();
  };

  private readonly animate = (now: number): void => {
    const cast = this.active;
    if (!cast || this.disposed) return;
    // Returning from a suspended iframe must not replay a stale impact.
    if (now - cast.previousFrame > 750) { this.cancel(); return; }
    // Warmup/scheduling latency is not flight time: the first drawn frame starts at the caster.
    if (cast.frames === 0) cast.startedAt = now;
    const seconds = (now - cast.startedAt) / 1000;
    const elapsedFrame = now - cast.previousFrame;
    cast.previousFrame = now;
    cast.frames++;
    // React to current explosion load; cheap flight frames must not dilute this signal.
    cast.slowFrames = elapsedFrame > 34 ? cast.slowFrames + 1 : Math.max(0, cast.slowFrames - 1);
    if (this.quality === "auto" && this.effectiveQuality === "standard" &&
        cast.slowFrames >= 5) {
      this.effectiveQuality = "low";
      this.resize();
    }
    try {
      if (seconds >= TOTAL_SECONDS) { this.finish(); return; }
      this.draw(cast, seconds);
      if (this.active !== cast) return;
      if (cast.frames === 1) {
        cast.onStarted?.();
        if (this.active !== cast) return;
      }
      if (seconds >= FLIGHT_SECONDS && !cast.impacted) {
        cast.impacted = true;
        cast.onImpact();
        if (this.active !== cast) return;
      }
    } catch (error) { this.finish(error); return; }
    this.animationFrame = requestAnimationFrame(this.animate);
  };

  private finish(error?: unknown): void {
    cancelAnimationFrame(this.animationFrame);
    window.clearTimeout(this.watchdog);
    this.animationFrame = 0;
    this.watchdog = 0;
    const cast = this.active;
    this.active = null;
    try { this.clearSurface(); } catch { /* A lost context may no longer support clear(). */ }
    if (!cast) return;
    if (cast.startedAt) {
      this.lastAverageFps = Math.round(cast.frames * 1000 / Math.max(1, performance.now() - cast.startedAt));
    }
    if (error !== undefined) cast.reject(error);
    else cast.resolve();
  }
}

const sparkVertex = `
uniform float uTime;
uniform float uPixelScale;
uniform float uRadiusScale;
uniform vec2 uSpin;
attribute vec3 aVelocity;
attribute float aLife;
attribute float aSize;
attribute float aKind;
varying float vHeat;
varying float vKind;
varying float vVisibility;
void main() {
  float age = max(0.0, uTime);
  vKind = aKind;
  vHeat = max(0.0, 1.0 - age / aLife);
  float drag = mix(2.8, 4.3, aKind);
  float travel = (1.0 - exp(-age * drag)) / drag;
  vec3 p = aVelocity * travel;
  p.xy=mat2(uSpin.x,uSpin.y,-uSpin.y,uSpin.x)*p.xy;
  p.z = max(0.0, aVelocity.z * age - 85.0 * age * age);
  // Overhead projection reveals a small airborne arc without increasing the footprint.
  p.y += p.z * .20;
  vVisibility=mix(1.,.22,smoothstep(.20,.60,age)*(1.-smoothstep(45.,95.,length(p.xy))));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = clamp(aSize * uPixelScale * uRadiusScale * (0.45 + vHeat), 1.0, 14.0);
}`;
const sparkFragment = `
varying float vHeat;
varying float vKind;
varying float vVisibility;
void main() {
  float r = length(gl_PointCoord - 0.5);
  float alpha = (1.0 - smoothstep(mix(.05,.23,vKind), .5, r)) * smoothstep(0.0, 0.25, vHeat)*vVisibility;
  vec3 hot=mix(vec3(.95,.09,.003),vec3(1.,.96,.72),vHeat);
  vec3 ember=mix(vec3(.075,.047,.034),hot,smoothstep(.25,.9,vHeat));
  gl_FragColor=vec4(mix(hot,ember,vKind),alpha);
}`;

/** A spherical fireball, batched flowing trail and bounded local volumetric explosion. */
export class ThreeFireballPrototype extends FireballRendererBase {
  readonly kind = "webgl" as const;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 3000);
  private readonly fireball = new THREE.Group();
  private readonly explosion = new THREE.Group();
  private fire!: THREE.Mesh<THREE.IcosahedronGeometry, THREE.ShaderMaterial>;
  private sparks!: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private trail!: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private smoke!: VolumetricCloud;
  private shock!: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private burst!: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private corona!: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private glowTexture!: THREE.CanvasTexture;
  private warmup: Promise<void> | null = null;
  private visualSeed: number | undefined;

  constructor(container: HTMLElement, quality: FxQuality = "auto") {
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: "default" });
    super(renderer.domElement, container, quality);
    this.renderer = renderer;
    try {
      renderer.setClearColor(0, 0);
      renderer.setPixelRatio(1);
      renderer.debug.onShaderError = () => { this.fail(new Error("Fireball shader could not be compiled")); };
      this.camera.position.z = 1000;
      this.glowTexture = new THREE.CanvasTexture(createTextureCanvas(false));
      this.glowTexture.generateMipmaps = false;
      this.glowTexture.minFilter = THREE.LinearFilter;
      this.fire = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 3), new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 } }, vertexShader: sphereVertex, fragmentShader: sphereFragment,
        depthTest: false, depthWrite: false,
      }));
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.glowTexture, color: 0xff650b, transparent: true, opacity: 0.26,
        depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      halo.scale.set(4.3, 4.3, 1);
      halo.renderOrder = 1;
      this.fire.renderOrder = 3;
      this.corona = makeFireCorona();
      this.fireball.add(halo, this.fire, this.corona);
      this.scene.add(this.fireball);

      this.sparks = makeSparks();
      this.sparks.renderOrder = 8;
      this.trail = makeFlameTrail(BUDGETS.standard.trail);
      this.trail.renderOrder = 2;
      this.scene.add(this.trail);
      this.smoke = new VolumetricCloud();
      this.smoke.renderOrder = 6;
      this.shock = makePressureWave();
      this.shock.renderOrder = 4;
      this.burst = makeDetonation();
      this.burst.renderOrder = 5;
      this.explosion.add(this.sparks, this.smoke, this.shock, this.burst);
      this.scene.add(this.explosion);
      this.fireball.visible = this.trail.visible = this.explosion.visible = false;
      this.canvas.addEventListener("webglcontextlost", this.onContextLost);
      this.resize();
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  get particleCount(): number { return this.budget.sparks + this.budget.trail; }

  ready(): Promise<void> {
    try { this.checkAvailable(); } catch (error) { return Promise.reject(error); }
    if (this.warmup) return this.warmup;
    this.warmup = withDeadline((async () => {
      this.renderer.initTexture(this.glowTexture);
      this.renderer.initTexture(this.smoke.noiseTexture);
      this.fireball.visible = this.trail.visible = this.explosion.visible = true;
      try {
        await this.renderer.compileAsync(this.scene, this.camera);
        this.checkAvailable();
        if (this.renderer.getContext().isContextLost()) throw new Error("Fireball WebGL context is lost");
      } finally {
        this.fireball.visible = this.trail.visible = this.explosion.visible = false;
      }
    })(), 6000).catch((error: unknown) => {
      this.failure = error instanceof Error ? error : new Error(String(error));
      throw this.failure;
    });
    return this.warmup;
  }

  protected resizeSurface(): void {
    this.renderer.setSize(Math.max(1, Math.floor(this.width * this.resolutionScale)),
      Math.max(1, Math.floor(this.height * this.resolutionScale)), false);
    this.camera.left = -this.width / 2;
    this.camera.right = this.width / 2;
    this.camera.top = this.height / 2;
    this.camera.bottom = -this.height / 2;
    this.camera.updateProjectionMatrix();
    this.sparks.geometry.setDrawRange(0, this.budget.sparks);
    this.trail.geometry.instanceCount = this.budget.trail;
    this.sparks.material.uniforms.uPixelScale!.value = this.resolutionScale;
  }

  protected draw(cast: ActiveCast, seconds: number): void {
    this.checkAvailable();
    const radiusScale = cast.radius / 160;
    const fx = cast.from.x - this.width / 2;
    const fy = this.height / 2 - cast.from.y;
    const tx = cast.to.x - this.width / 2;
    const ty = this.height / 2 - cast.to.y;
    const orbSize = Math.max(3, cast.radius * 0.125);
    const seed = normalizeEffectSeed(cast.seed);
    if (this.visualSeed !== seed) {
      this.visualSeed = seed;
      const profile = createExplosionProfile(seed);
      this.smoke.setProfile(profile);
      for (const mesh of [this.trail, this.shock, this.burst]) {
        (mesh.material.uniforms.uSeed!.value as THREE.Vector3).set(...profile.offset);
      }
      this.sparks.material.uniforms.uSpin!.value.set(Math.cos(profile.rotation), Math.sin(profile.rotation));
    }
    const age = seconds - FLIGHT_SECONDS;
    const layers = explosionLayers(age);
    this.trail.visible = layers.trail;
    if (layers.trail) {
      const uniforms = this.trail.material.uniforms;
      uniforms.uFrom!.value.set(fx, fy);
      uniforms.uTo!.value.set(tx, ty);
      uniforms.uProgress!.value = Math.min(1, seconds / FLIGHT_SECONDS);
      uniforms.uTime!.value = seconds;
      uniforms.uSize!.value = orbSize;
      uniforms.uAfterImpact!.value = Math.max(0, age);
    }
    if (seconds < FLIGHT_SECONDS) {
      const progress = seconds / FLIGHT_SECONDS;
      const eased = easeFlight(progress);
      this.fireball.visible = this.trail.visible = true;
      this.explosion.visible = false;
      this.fireball.position.set(fx + (tx - fx) * eased, fy + (ty - fy) * eased, 3);
      this.fireball.rotation.z = Math.atan2(ty - fy, tx - fx);
      this.fireball.scale.setScalar(orbSize);
      this.fire.rotation.x = seconds * 1.7;
      this.fire.rotation.y = seconds * 2.2;
      this.fire.material.uniforms.uTime!.value = seconds;
      this.corona.material.uniforms.uTime!.value = seconds;
    } else {
      this.fireball.visible = false;
      this.explosion.visible = true;
      this.explosion.position.set(tx, ty, 0);
      this.explosion.scale.setScalar(radiusScale);
      this.sparks.material.uniforms.uTime!.value = age;
      this.sparks.material.uniforms.uRadiusScale!.value = radiusScale;
      this.smoke.update(age, this.currentQuality === "low", this.reducedMotion);
      this.shock.material.uniforms.uTime!.value = age;
      this.shock.material.uniforms.uReduced!.value = this.reducedMotion ? 1 : 0;
      this.burst.material.uniforms.uTime!.value = age;
      this.burst.material.uniforms.uReduced!.value = this.reducedMotion ? 1 : 0;
      this.burst.visible = layers.burst;
      this.shock.visible = layers.dust;
      this.sparks.visible = layers.embers;
    }
    this.renderer.render(this.scene, this.camera);
  }

  protected clearSurface(): void {
    this.fireball.visible = this.trail.visible = this.explosion.visible = false;
    this.renderer.clear();
  }

  protected destroySurface(): void {
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.scene.traverse((object) => {
      if (object === this.smoke) return;
      if (object instanceof THREE.Mesh || object instanceof THREE.Points) object.geometry.dispose();
      if (object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.Sprite) {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) material.dispose();
      }
    });
    this.glowTexture?.dispose();
    this.smoke?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    this.fail(new Error("Fireball WebGL context was lost; use the lightweight fallback"));
  };
}

/** Small Canvas fallback retains the same timing and cleanup semantics as WebGL. */
export class CanvasFireballFallback extends FireballRendererBase {
  readonly kind = "canvas" as const;
  private readonly context: CanvasRenderingContext2D;
  private readonly puff = createTextureCanvas(true);

  constructor(container: HTMLElement, quality: FxQuality = "low") {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D is unavailable");
    super(canvas, container, quality);
    this.context = context;
    this.resize();
  }

  get particleCount(): number { return this.currentQuality === "low" ? 24 : 40; }
  ready(): Promise<void> {
    try { this.checkAvailable(); return Promise.resolve(); }
    catch (error) { return Promise.reject(error); }
  }

  protected resizeSurface(): void {
    this.canvas.width = Math.max(1, Math.floor(this.width * this.resolutionScale));
    this.canvas.height = Math.max(1, Math.floor(this.height * this.resolutionScale));
  }

  protected draw(cast: ActiveCast, seconds: number): void {
    const ctx = this.context;
    const radius = cast.radius;
    const age = seconds - FLIGHT_SECONDS;
    const seedAngle = normalizeEffectSeed(Math.imul(cast.seed, 0x9e3779b1)) / 4294967296 * Math.PI * 2;
    this.clearSurface();
    ctx.setTransform(this.resolutionScale, 0, 0, this.resolutionScale, 0, 0);
    if (age < TAIL_DISSIPATION_SECONDS) {
      const progress = Math.min(1, seconds / FLIGHT_SECONDS);
      const tailFade = Math.max(0, 1 - Math.max(0, age) / TAIL_DISSIPATION_SECONDS);
      for (let i = 7; i >= (age < 0 ? 0 : 1); i--) {
        const p = easeFlight(Math.max(0, progress - i * 0.025));
        const x = cast.from.x + (cast.to.x - cast.from.x) * p;
        const y = cast.from.y + (cast.to.y - cast.from.y) * p;
        ctx.globalAlpha = (1 - i / 8) * 0.85 * tailFade;
        ctx.fillStyle = i === 0 ? "#ffe394" : "#ff6918";
        ctx.beginPath();
        ctx.arc(x, y, Math.max(2, radius * 0.085 * (1 - i / 11)), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (age >= 0) {
      const expansion = 1 - Math.exp(-age * 5);
      if (!this.reducedMotion && explosionLayers(age).dust) {
        ctx.globalAlpha = Math.max(0, 1 - age / 0.85) * 0.55;
        ctx.strokeStyle = "#d8b793";
        ctx.lineWidth = Math.max(1, radius * 0.02);
        for (let i = 0; i < 6; i++) {
          const angle = seedAngle + i * 1.047;
          ctx.beginPath();
          ctx.arc(cast.to.x, cast.to.y, radius * expansion * (0.86 + Math.sin(i + seedAngle) * .035), angle, angle + .40 + (i % 3) * .10);
          ctx.stroke();
        }
      }
      for (let i = 0; i < 5; i++) {
        const theta = i * 2.399 + seedAngle;
        const x = cast.to.x + Math.cos(theta) * radius * 0.26 * expansion;
        const y = cast.to.y + Math.sin(theta) * radius * 0.26 * expansion;
        const size = radius * (0.22 + 0.43 * expansion) * (.86 + Math.sin(theta * 3.7) * .14);
        ctx.globalAlpha = Math.min(1, age * 6) * Math.max(0, 1 - age / 3.65) * 0.75;
        ctx.drawImage(this.puff, x - size / 2, y - size / 2, size, size);
      }
      ctx.globalAlpha = Math.exp(-age * 7) * 0.8;
      ctx.fillStyle = "#ffb54d";
      ctx.beginPath();
      ctx.arc(cast.to.x, cast.to.y, radius * (0.08 + expansion * 0.32), 0, Math.PI * 2);
      ctx.fill();
      for (let i = 0; i < this.particleCount; i++) {
        const angle = i * 2.399 + seedAngle;
        const reach = radius * expansion * (0.32 + (i % 7) * 0.075);
        ctx.globalAlpha = Math.max(0, 1 - age / (0.7 + (i % 5) * 0.15));
        ctx.fillStyle = i % 3 === 0 ? "#ffd479" : "#ee681c";
        ctx.fillRect(cast.to.x + Math.cos(angle) * reach, cast.to.y + Math.sin(angle) * reach, 2, 2);
      }
    }
    ctx.globalAlpha = 1;
  }

  protected clearSurface(): void {
    this.context.setTransform(1, 0, 0, 1, 0, 0);
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
  protected destroySurface(): void { this.canvas.width = this.canvas.height = 1; }
}

function makeSparks(): THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial> {
  const count = BUDGETS.standard.sparks;
  const random = seededRandom(0xf1b411);
  const velocity = new Float32Array(count * 3);
  const life = new Float32Array(count);
  const size = new Float32Array(count);
  const kind = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const heavy = i % 4 === 0;
    const angle = random() * Math.PI * 2;
    const speedSample = random();
    const speed = heavy ? 80 + speedSample * 300 : 35 + speedSample * speedSample * 325;
    velocity[i * 3] = Math.cos(angle) * speed;
    velocity[i * 3 + 1] = Math.sin(angle) * speed;
    velocity[i * 3 + 2] = (heavy ? 45 : 15) + random() * 75;
    life[i] = heavy ? 1.25 + random() * .90 : .25 + random() * .75;
    size[i] = heavy ? 2.5 + random() * 2.5 : 1.0 + random() * 1.8;
    kind[i] = heavy ? 1 : 0;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute("aVelocity", new THREE.BufferAttribute(velocity, 3));
  geometry.setAttribute("aLife", new THREE.BufferAttribute(life, 1));
  geometry.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
  geometry.setAttribute("aKind", new THREE.BufferAttribute(kind, 1));
  const points = new THREE.Points(geometry, new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPixelScale: { value: 1 }, uRadiusScale: { value: 1 }, uSpin: { value: new THREE.Vector2(1, 0) } },
    vertexShader: sparkVertex, fragmentShader: sparkFragment, transparent: true,
    depthWrite: false, depthTest: false,
  }));
  points.frustumCulled = false;
  return points;
}

function createTextureCanvas(smoke: boolean): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas texture creation is unavailable");
  if (smoke) {
    const random = seededRandom(0x5a0ce);
    for (let i = 0; i < 18; i++) {
      const angle = random() * Math.PI * 2;
      const distance = random() * 28;
      const x = 64 + Math.cos(angle) * distance;
      const y = 64 + Math.sin(angle) * distance;
      const radius = 17 + random() * 22;
      const gradient = context.createRadialGradient(x - 5, y - 7, 0, x, y, radius);
      gradient.addColorStop(0, "rgba(210,208,202,.8)");
      gradient.addColorStop(0.48, "rgba(117,114,110,.55)");
      gradient.addColorStop(1, "rgba(55,53,50,0)");
      context.fillStyle = gradient;
      context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }
  } else {
    const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, "rgba(255,255,255,.8)");
    gradient.addColorStop(0.28, "rgba(255,255,255,.4)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);
  }
  return canvas;
}

function chooseQuality(quality: FxQuality, reducedMotion: boolean): "standard" | "low" {
  if (reducedMotion || quality === "low") return "low";
  if (quality === "standard") return "standard";
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return navigator.hardwareConcurrency <= 4 || (memory !== undefined && memory <= 4) ? "low" : "standard";
}
function validateProjection(from: FxPoint, to: FxPoint, radius: number): void {
  if (![from.x, from.y, to.x, to.y, radius].every(Number.isFinite) || radius <= 0 || radius > 100000) {
    throw new Error("Fireball projection must contain finite coordinates and a positive radius");
  }
}
function easeFlight(t: number): number { return t * t * (0.65 + t * 0.35); }
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
function withDeadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("Fireball shader preparation timed out")), milliseconds);
    promise.then((value) => { window.clearTimeout(timeout); resolve(value); },
      (error: unknown) => { window.clearTimeout(timeout); reject(error); });
  });
}
