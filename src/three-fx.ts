import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

export interface FxPoint {
  x: number;
  y: number;
}

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
const EXPLOSION_SECONDS = 4.15;
const SPARK_COUNT = 520;
const DEBRIS_COUNT = 110;
const SMOKE_COUNT = 380;
const TRAIL_COUNT = 56;

const ballisticVertexShader = `
uniform float uTime;
uniform float uGravity;
attribute vec3 aVelocity;
attribute float aDelay;
attribute float aLife;
attribute float aSize;
attribute vec3 aColor;
varying vec3 vColor;
varying float vAlpha;

void main() {
  float rawAge = uTime - aDelay;
  float age = max(rawAge, 0.0);
  vec3 transformed = position + aVelocity * age;
  transformed.y -= 0.5 * uGravity * age * age;

  float alive = step(0.0, rawAge) * (1.0 - step(aLife, age));
  vAlpha = alive * (1.0 - smoothstep(aLife * 0.54, aLife, age));
  vColor = aColor;

  vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = aSize * (590.0 / max(1.0, -mvPosition.z));
}
`;

const sparkFragmentShader = `
varying vec3 vColor;
varying float vAlpha;

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float radius = length(uv);
  float alpha = (1.0 - smoothstep(0.08, 0.5, radius)) * vAlpha;
  float core = 1.0 - smoothstep(0.0, 0.18, radius);
  gl_FragColor = vec4(mix(vColor, vec3(1.0, 0.96, 0.70), core), alpha);
}
`;

const debrisFragmentShader = `
varying vec3 vColor;
varying float vAlpha;

void main() {
  vec2 edge = abs(gl_PointCoord - 0.5);
  float shape = 1.0 - smoothstep(0.34, 0.49, max(edge.x * 0.82, edge.y));
  float ember = 1.0 - smoothstep(0.16, 0.48, length(gl_PointCoord - vec2(0.32, 0.30)));
  vec3 color = mix(vColor, vec3(0.95, 0.18, 0.015), ember * 0.48);
  gl_FragColor = vec4(color, shape * vAlpha);
}
`;

const smokeVertexShader = `
uniform float uTime;
attribute vec3 aVelocity;
attribute float aDelay;
attribute float aLife;
attribute float aSize;
attribute float aKind;
attribute float aSeed;
varying float vAlpha;
varying float vSeed;
varying float vHeat;
varying vec3 vSmokeColor;

void main() {
  float rawAge = uTime - aDelay;
  float age = max(rawAge, 0.0);
  float normalizedAge = clamp(age / aLife, 0.0, 1.0);
  vec3 transformed = position + aVelocity * age;

  float turbulence = sin(age * 2.7 + aSeed * 31.0);
  transformed.x += turbulence * (4.0 + 8.0 * aKind) * age;
  transformed.y += cos(age * 2.1 + aSeed * 19.0) * (3.0 + 7.0 * aKind) * age;

  // The map is viewed from above: XY is the ground plane and Z is cloud height.
  // Rotating XY creates the rolling circular crown seen from a top-down camera.
  float swirl = age * mix(1.18, 0.46, aKind) + (aSeed - 0.5) * 0.16;
  float swirlCos = cos(swirl);
  float swirlSin = sin(swirl);
  transformed.xy = mat2(swirlCos, -swirlSin, swirlSin, swirlCos) * transformed.xy;
  if (aKind > 0.5) {
    transformed.z += 72.0 * (1.0 - exp(-age * 1.45));
  }

  float alive = step(0.0, rawAge) * (1.0 - step(aLife, age));
  vAlpha = alive * smoothstep(0.0, 0.14, normalizedAge) *
           (1.0 - smoothstep(0.62, 1.0, normalizedAge));
  vSeed = aSeed;
  vHeat = (1.0 - normalizedAge) * (1.0 - aKind * 0.38);
  vSmokeColor = mix(vec3(0.32, 0.13, 0.045), vec3(0.17, 0.18, 0.19),
                    smoothstep(0.08, 0.68, normalizedAge));

  vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = aSize * (1.0 + age * 0.34) * (650.0 / max(1.0, -mvPosition.z));
}
`;

const smokeFragmentShader = `
varying float vAlpha;
varying float vSeed;
varying float vHeat;
varying vec3 vSmokeColor;

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float radius = length(uv);
  float breakup = sin((uv.x + vSeed) * 23.0) * sin((uv.y - vSeed) * 19.0) * 0.035;
  float cloud = 1.0 - smoothstep(0.27, 0.51, radius + breakup);
  float innerGlow = 1.0 - smoothstep(0.0, 0.40, radius);
  vec3 color = mix(vSmokeColor, vec3(0.92, 0.20, 0.025), innerGlow * vHeat * 0.34);
  gl_FragColor = vec4(color, cloud * vAlpha * 0.58);
}
`;

const fireVertexShader = `
uniform float uTime;
varying float vPulse;

void main() {
  vec3 transformed = position;
  float wave = sin(position.x * 0.19 + uTime * 13.0) *
               sin(position.y * 0.17 - uTime * 9.0) * 0.11;
  transformed *= 1.0 + wave;
  vPulse = 0.82 + 0.18 * sin(uTime * 17.0 + position.z * 0.14);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
}
`;

const fireFragmentShader = `
varying float vPulse;

void main() {
  vec3 color = mix(vec3(1.0, 0.10, 0.005), vec3(1.0, 0.83, 0.16), vPulse);
  gl_FragColor = vec4(color, 0.72);
}
`;

const filmShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uStrength: { value: 0.028 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uStrength;
    varying vec2 vUv;

    float random(vec2 p) {
      return fract(sin(dot(p + uTime, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec4 source = texture2D(tDiffuse, vUv);
      float grain = (random(vUv * vec2(1280.0, 720.0)) - 0.5) * uStrength;
      source.rgb += grain * source.a;
      gl_FragColor = source;
    }
  `,
};

export class ThreeFireballPrototype {
  readonly particleCount = SPARK_COUNT + DEBRIS_COUNT + SMOKE_COUNT + TRAIL_COUNT;
  lastAverageFps = 0;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(45, 1, 1, 3000);
  private readonly composer: EffectComposer;
  private readonly bloomPass: UnrealBloomPass;
  private readonly filmPass: ShaderPass;
  private readonly fireball = new THREE.Group();
  private readonly explosion = new THREE.Group();
  private readonly fireMaterial: THREE.ShaderMaterial;
  private readonly fireCoreMaterial: THREE.MeshBasicMaterial;
  private readonly fireGlowMaterial: THREE.SpriteMaterial;
  private readonly explosionCoreMaterial: THREE.MeshBasicMaterial;
  private readonly explosionShellMaterial: THREE.MeshBasicMaterial;
  private readonly explosionGlowMaterial: THREE.SpriteMaterial;
  private readonly shockwaveMaterial: THREE.MeshBasicMaterial;
  private readonly explosionCore: THREE.Mesh;
  private readonly explosionShell: THREE.Mesh;
  private readonly explosionGlow: THREE.Sprite;
  private readonly shockwave: THREE.Mesh;
  private readonly sparks: THREE.Points;
  private readonly debris: THREE.Points;
  private readonly smoke: THREE.Points;
  private readonly trail: THREE.Points;
  private readonly trailPositions = new Float32Array(TRAIL_COUNT * 3);
  private readonly trailHistory: THREE.Vector3[] = [];
  private activeCast: ActiveCast | null = null;
  private animationFrame = 0;
  private width = 1;
  private height = 1;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: false,
      powerPreference: "high-performance",
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.4));
    this.renderer.domElement.className = "three-fx-canvas";
    this.renderer.domElement.setAttribute("aria-hidden", "true");
    container.append(this.renderer.domElement);

    this.camera.position.z = 1000;

    const renderPass = new RenderPass(this.scene, this.camera);
    renderPass.clearAlpha = 0;
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(renderPass);
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 1.35, 0.72, 0.08);
    this.composer.addPass(this.bloomPass);
    this.filmPass = new ShaderPass(filmShader);
    this.composer.addPass(this.filmPass);
    this.composer.addPass(new OutputPass());

    const glowTexture = createGlowTexture();

    this.fireCoreMaterial = new THREE.MeshBasicMaterial({ color: 0xfff5a3 });
    this.fireMaterial = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: fireVertexShader,
      fragmentShader: fireFragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.fireGlowMaterial = new THREE.SpriteMaterial({
      map: glowTexture,
      color: 0xff4b08,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const fireCore = new THREE.Mesh(new THREE.IcosahedronGeometry(12, 3), this.fireCoreMaterial);
    const fireShell = new THREE.Mesh(new THREE.IcosahedronGeometry(21, 4), this.fireMaterial);
    const fireGlow = new THREE.Sprite(this.fireGlowMaterial);
    fireGlow.scale.set(118, 118, 1);
    this.fireball.add(fireGlow, fireShell, fireCore);
    this.fireball.visible = false;
    this.scene.add(this.fireball);

    const trailGeometry = new THREE.BufferGeometry();
    trailGeometry.setAttribute("position", new THREE.BufferAttribute(this.trailPositions, 3));
    const trailMaterial = new THREE.PointsMaterial({
      map: glowTexture,
      color: 0xff5a08,
      size: 28,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.58,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.trail = new THREE.Points(trailGeometry, trailMaterial);
    this.trail.visible = false;
    this.trail.frustumCulled = false;
    this.scene.add(this.trail);

    this.explosionCoreMaterial = new THREE.MeshBasicMaterial({
      color: 0xfff8c9,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.explosionShellMaterial = new THREE.MeshBasicMaterial({
      color: 0xff3f04,
      transparent: true,
      opacity: 0.72,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      wireframe: true,
    });
    this.explosionGlowMaterial = new THREE.SpriteMaterial({
      map: glowTexture,
      color: 0xff4b08,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.shockwaveMaterial = new THREE.MeshBasicMaterial({
      color: 0xffc85a,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.explosionCore = new THREE.Mesh(
      new THREE.IcosahedronGeometry(20, 4),
      this.explosionCoreMaterial,
    );
    this.explosionShell = new THREE.Mesh(
      new THREE.IcosahedronGeometry(38, 3),
      this.explosionShellMaterial,
    );
    this.explosionGlow = new THREE.Sprite(this.explosionGlowMaterial);
    this.explosionGlow.scale.set(220, 220, 1);
    this.shockwave = new THREE.Mesh(
      new THREE.RingGeometry(43, 48, 128),
      this.shockwaveMaterial,
    );
    this.explosion.add(
      this.explosionGlow,
      this.explosionShell,
      this.explosionCore,
      this.shockwave,
    );
    this.explosion.visible = false;
    this.scene.add(this.explosion);

    this.sparks = createBallisticPoints(SPARK_COUNT, false, 0x51f15e);
    this.debris = createBallisticPoints(DEBRIS_COUNT, true, 0xd3b74a);
    this.smoke = createSmokePoints(SMOKE_COUNT, 0x9e3779);
    this.sparks.renderOrder = 5;
    this.debris.renderOrder = 4;
    this.smoke.renderOrder = 3;
    this.explosion.add(this.smoke, this.debris, this.sparks);

    this.resize();
    window.addEventListener("resize", this.resize);
  }

  play(from: FxPoint, to: FxPoint, onImpact: () => void): Promise<void> {
    if (this.activeCast) return Promise.resolve();

    const fromWorld = this.screenToWorld(from);
    const toWorld = this.screenToWorld(to);
    this.fireball.visible = true;
    this.trail.visible = true;
    this.explosion.visible = false;
    this.trailHistory.length = 0;
    this.fireball.position.copy(fromWorld);
    this.setParticleTime(this.sparks, -10);
    this.setParticleTime(this.debris, -10);
    this.setParticleTime(this.smoke, -10);

    return new Promise((resolve) => {
      this.activeCast = {
        from: fromWorld,
        to: toWorld,
        startedAt: performance.now(),
        impacted: false,
        onImpact,
        resolve,
        frameCount: 0,
      };
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = requestAnimationFrame(this.animate);
    });
  }

  private readonly animate = (now: number): void => {
    const cast = this.activeCast;
    if (!cast) return;
    cast.frameCount += 1;

    const totalTime = (now - cast.startedAt) / 1000;
    this.filmPass.uniforms.uTime!.value = totalTime;

    if (totalTime < FLIGHT_SECONDS) {
      this.updateFlight(cast, totalTime);
    } else {
      if (!cast.impacted) this.beginExplosion(cast);
      this.updateExplosion(totalTime - FLIGHT_SECONDS);
    }

    this.composer.render();

    if (totalTime >= FLIGHT_SECONDS + EXPLOSION_SECONDS) {
      this.finishCast(cast);
      return;
    }

    this.animationFrame = requestAnimationFrame(this.animate);
  };

  private updateFlight(cast: ActiveCast, elapsed: number): void {
    const t = Math.min(1, elapsed / FLIGHT_SECONDS);
    const eased = t * t * t;
    const midpoint = cast.from.clone().lerp(cast.to, 0.5);
    midpoint.y += 82;
    const inverse = 1 - eased;
    const position = cast.from
      .clone()
      .multiplyScalar(inverse * inverse)
      .add(midpoint.clone().multiplyScalar(2 * inverse * eased))
      .add(cast.to.clone().multiplyScalar(eased * eased));

    this.fireball.position.copy(position);
    const pulse = 0.88 + Math.sin(elapsed * 24) * 0.09;
    this.fireball.scale.setScalar(pulse);
    this.fireMaterial.uniforms.uTime!.value = elapsed;
    this.fireGlowMaterial.opacity = 0.74 + Math.sin(elapsed * 19) * 0.12;
    this.bloomPass.strength = 1.15;

    this.trailHistory.unshift(position.clone());
    if (this.trailHistory.length > TRAIL_COUNT) this.trailHistory.pop();
    for (let index = 0; index < TRAIL_COUNT; index += 1) {
      const point = this.trailHistory[Math.min(index, this.trailHistory.length - 1)] ?? position;
      const offset = index * 3;
      this.trailPositions[offset] = point.x;
      this.trailPositions[offset + 1] = point.y;
      this.trailPositions[offset + 2] = point.z - index * 0.42;
    }
    const positionAttribute = this.trail.geometry.getAttribute("position") as THREE.BufferAttribute;
    positionAttribute.needsUpdate = true;
  }

  private beginExplosion(cast: ActiveCast): void {
    cast.impacted = true;
    this.fireball.visible = false;
    this.trail.visible = false;
    this.explosion.visible = true;
    this.explosion.position.copy(cast.to);
    this.explosionCore.scale.setScalar(0.05);
    this.explosionShell.scale.setScalar(0.05);
    this.shockwave.scale.setScalar(0.08);
    this.setParticleTime(this.sparks, 0);
    this.setParticleTime(this.debris, 0);
    this.setParticleTime(this.smoke, 0);
    cast.onImpact();
  }

  private updateExplosion(time: number): void {
    this.setParticleTime(this.sparks, time);
    this.setParticleTime(this.debris, time);
    this.setParticleTime(this.smoke, time);

    const flash = Math.max(0, 1 - time / 0.82);
    const coreScale = 0.12 + 3.8 * (1 - Math.exp(-time * 6.4));
    this.explosionCore.scale.setScalar(coreScale);
    this.explosionShell.scale.setScalar(coreScale * (1.04 + Math.sin(time * 18) * 0.05));
    this.explosionCoreMaterial.opacity = Math.max(0, 1 - time / 0.72);
    this.explosionShellMaterial.opacity = Math.max(0, 0.85 - time / 1.18);
    this.explosionGlowMaterial.opacity = Math.max(0, 1 - time / 1.08);
    this.explosionGlow.scale.setScalar(210 + 330 * (1 - Math.exp(-time * 4.8)));

    const shockScale = 0.08 + 4.7 * (1 - Math.exp(-time * 4.1));
    this.shockwave.scale.setScalar(shockScale);
    this.shockwaveMaterial.opacity = Math.max(0, 0.92 - time / 0.72);

    const shake = Math.max(0, 1 - time / 0.56);
    this.camera.position.x = Math.sin(time * 92) * 5.2 * shake;
    this.camera.position.y = Math.cos(time * 73) * 3.8 * shake;
    this.camera.position.z = 1000;
    this.bloomPass.strength = 0.82 + flash * 1.72;
    this.bloomPass.radius = 0.58 + flash * 0.20;
    this.filmPass.uniforms.uStrength!.value = 0.018 + flash * 0.038;
  }

  private finishCast(cast: ActiveCast): void {
    this.explosion.visible = false;
    this.camera.position.set(0, 0, 1000);
    this.scene.updateMatrixWorld();
    this.composer.render();
    const elapsedSeconds = Math.max(0.001, (performance.now() - cast.startedAt) / 1000);
    this.lastAverageFps = Math.round(cast.frameCount / elapsedSeconds);
    this.activeCast = null;
    cast.resolve();
  }

  private setParticleTime(points: THREE.Points, time: number): void {
    const material = points.material as THREE.ShaderMaterial;
    material.uniforms.uTime!.value = time;
  }

  private screenToWorld(point: FxPoint): THREE.Vector3 {
    const distance = this.camera.position.z;
    const visibleHeight = 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * distance;
    const visibleWidth = visibleHeight * this.camera.aspect;
    return new THREE.Vector3(
      (point.x / this.width - 0.5) * visibleWidth,
      (0.5 - point.y / this.height) * visibleHeight,
      0,
    );
  }

  private readonly resize = (): void => {
    this.width = Math.max(1, window.innerWidth);
    this.height = Math.max(1, window.innerHeight);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.width, this.height, false);
    this.composer.setSize(this.width, this.height);
  };
}

function createBallisticPoints(count: number, isDebris: boolean, seed: number): THREE.Points {
  const random = mulberry32(seed);
  const positions = new Float32Array(count * 3);
  const velocities = new Float32Array(count * 3);
  const delays = new Float32Array(count);
  const lives = new Float32Array(count);
  const sizes = new Float32Array(count);
  const colors = new Float32Array(count * 3);

  for (let index = 0; index < count; index += 1) {
    const angle = random() * Math.PI * 2;
    const speed = isDebris ? 125 + random() * 185 : 175 + random() * 360;
    const offset = index * 3;
    velocities[offset] = Math.cos(angle) * speed;
    velocities[offset + 1] = Math.sin(angle) * speed + (isDebris ? 48 : 72);
    velocities[offset + 2] = (random() - 0.5) * speed * 0.52;
    delays[index] = random() * (isDebris ? 0.16 : 0.12);
    lives[index] = isDebris ? 1.05 + random() * 0.85 : 0.62 + random() * 0.84;
    sizes[index] = isDebris ? 8 + random() * 13 : 7 + random() * 15;

    const color = new THREE.Color();
    if (isDebris) {
      color.setRGB(0.10 + random() * 0.12, 0.035 + random() * 0.06, 0.012);
    } else {
      color.setHSL(0.035 + random() * 0.10, 1, 0.52 + random() * 0.30);
    }
    colors[offset] = color.r;
    colors[offset + 1] = color.g;
    colors[offset + 2] = color.b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aVelocity", new THREE.BufferAttribute(velocities, 3));
  geometry.setAttribute("aDelay", new THREE.BufferAttribute(delays, 1));
  geometry.setAttribute("aLife", new THREE.BufferAttribute(lives, 1));
  geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: -10 },
      uGravity: { value: isDebris ? 330 : 255 },
    },
    vertexShader: ballisticVertexShader,
    fragmentShader: isDebris ? debrisFragmentShader : sparkFragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: isDebris ? THREE.NormalBlending : THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return points;
}

function createSmokePoints(count: number, seed: number): THREE.Points {
  const random = mulberry32(seed);
  const positions = new Float32Array(count * 3);
  const velocities = new Float32Array(count * 3);
  const delays = new Float32Array(count);
  const lives = new Float32Array(count);
  const sizes = new Float32Array(count);
  const kinds = new Float32Array(count);
  const seeds = new Float32Array(count);
  const stemCount = Math.floor(count * 0.36);

  for (let index = 0; index < count; index += 1) {
    const isCap = index >= stemCount;
    const offset = index * 3;
    const angle = random() * Math.PI * 2;
    const radius = isCap ? 8 + random() * 14 : random() * 8;
    positions[offset] = Math.cos(angle) * radius;
    positions[offset + 1] = Math.sin(angle) * radius;
    positions[offset + 2] = isCap ? 28 + random() * 38 : -24 + random() * 30;

    if (isCap) {
      const spread = 20 + random() * 38;
      velocities[offset] = Math.cos(angle) * spread;
      velocities[offset + 1] = Math.sin(angle) * spread;
      velocities[offset + 2] = 26 + random() * 48;
      delays[index] = 0.54 + random() * 0.78;
      lives[index] = 2.35 + random() * 1.15;
      sizes[index] = 44 + random() * 48;
      kinds[index] = 1;
    } else {
      velocities[offset] = (random() - 0.5) * 22;
      velocities[offset + 1] = (random() - 0.5) * 22;
      velocities[offset + 2] = 88 + random() * 92;
      delays[index] = 0.18 + random() * 1.04;
      lives[index] = 2.0 + random() * 1.18;
      sizes[index] = 36 + random() * 40;
      kinds[index] = 0;
    }
    seeds[index] = random();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aVelocity", new THREE.BufferAttribute(velocities, 3));
  geometry.setAttribute("aDelay", new THREE.BufferAttribute(delays, 1));
  geometry.setAttribute("aLife", new THREE.BufferAttribute(lives, 1));
  geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute("aKind", new THREE.BufferAttribute(kinds, 1));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: -10 } },
    vertexShader: smokeVertexShader,
    fragmentShader: smokeFragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.NormalBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return points;
}

function createGlowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is unavailable");
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, "rgba(255,255,235,1)");
  gradient.addColorStop(0.12, "rgba(255,222,82,.98)");
  gradient.addColorStop(0.36, "rgba(255,74,5,.72)");
  gradient.addColorStop(1, "rgba(255,20,0,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
