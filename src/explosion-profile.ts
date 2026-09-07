/** Art-directed timing, not a fluid simulation. All ages are seconds after impact. */
export const TAIL_DISSIPATION_SECONDS = 0.32;
export const BURST_END_SECONDS = 0.72;
export const DUST_START_SECONDS = 0.12;
export const DUST_END_SECONDS = 1.12;
export const EMBER_END_SECONDS = 2.2;

export function explosionLayers(age: number) {
  return {
    trail: age < TAIL_DISSIPATION_SECONDS,
    burst: age >= 0 && age < BURST_END_SECONDS,
    dust: age >= DUST_START_SECONDS && age < DUST_END_SECONDS,
    embers: age >= 0 && age < EMBER_END_SECONDS,
  };
}

export function normalizeEffectSeed(seed: number): number {
  return Number.isFinite(seed) ? seed >>> 0 : 0xf1b411;
}

/** Created once per cast; no random numbers or allocations in the volume sampling loop. */
export function createExplosionProfile(seed: number) {
  let state = normalizeEffectSeed(seed);
  const random = () => {
    state += 0x6d2b79f5;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const rotation = random() * Math.PI * 2;
  const offset: [number, number, number] = [random() * 24, random() * 24, random() * 24];
  const lobes = Array.from({ length: 7 }, (_, i) => ({
    angle: rotation + i * Math.PI * 2 / 7 + (random() - .5) * .52,
    distance: .40 + random() * .21,
    width: .34 + random() * .18,
    height: .63 + random() * .40,
    lift: (random() - .5) * .48,
    speed: .07 + random() * .15,
    roll: random() * Math.PI * 2,
  }));
  return { rotation, offset, lobes };
}

export type ExplosionProfile = ReturnType<typeof createExplosionProfile>;
