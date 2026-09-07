import OBR, { buildImage, type ImageContent, type Vector2 } from "@owlbear-rodeo/sdk";
import { SCENE_KEY, type Cast } from "./protocol";

export const RESIDUE_KEY = "com.codex.owlbear-fireball/residue";
export interface ResidueTemplate {
  version: 1;
  name: string;
  image: ImageContent;
  dpi: number;
  scale: Vector2;
  rotation: number;
}

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object"; }
function bounded(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

/** Persist only the chosen media and its size, never token ownership, attachments or foreign metadata. */
export function readTemplate(value: unknown): ResidueTemplate | undefined {
  if (!object(value) || value.version !== 1 || typeof value.name !== "string" || !value.name.trim() || value.name.length > 120 ||
      !object(value.image) || !bounded(value.image.width, 1, 32768) || !bounded(value.image.height, 1, 32768) ||
      typeof value.image.mime !== "string" || !/^(image|video)\/[a-z0-9.+-]+$/i.test(value.image.mime) ||
      typeof value.image.url !== "string" || value.image.url.length > 8192 ||
      !bounded(value.dpi, 0.01, 100000) || !object(value.scale) ||
      !bounded(value.scale.x, -1000, 1000) || !bounded(value.scale.y, -1000, 1000) ||
      Math.abs(value.scale.x) < 0.001 || Math.abs(value.scale.y) < 0.001 || !bounded(value.rotation, -360000, 360000)) return;
  try {
    const url = new URL(value.image.url);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return;
  } catch { return; }
  return {
    version: 1, name: value.name,
    image: { width: value.image.width, height: value.image.height, mime: value.image.mime, url: value.image.url },
    dpi: value.dpi, scale: { x: value.scale.x, y: value.scale.y }, rotation: value.rotation,
  };
}

export class ResidueManager {
  private template?: ResidueTemplate;
  private readonly storageKey = `${RESIDUE_KEY}/v1/${OBR.room.id}`;

  constructor() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (raw && raw.length < 12000) this.template = readTemplate(JSON.parse(raw));
    } catch { /* Optional browser-local persistence must not prevent startup. */ }
  }

  get name(): string | undefined { return this.template?.name; }
  snapshot(): ResidueTemplate | undefined { return this.template ? structuredClone(this.template) : undefined; }

  async select(current: () => boolean): Promise<"cancelled" | "saved" | "volatile"> {
    const assets = await OBR.assets.downloadImages(false, undefined, "PROP");
    if (!current() || assets.length === 0) return "cancelled";
    const asset = assets[0]!;
    const template = readTemplate({
      version: 1, name: asset.name.trim().slice(0, 120) || "残留素材", image: asset.image,
      dpi: asset.grid.dpi, scale: asset.scale, rotation: asset.rotation,
    });
    if (!template) throw new Error("该素材的链接或尺寸不受支持，请选择一个 Props 图片或动画素材");
    this.template = template;
    return this.persist() ? "saved" : "volatile";
  }

  clear(): boolean { this.template = undefined; return this.persist(); }

  private persist(): boolean {
    try {
      // Write null instead of removing: a disabled setting remains explicit.
      localStorage.setItem(this.storageKey, JSON.stringify(this.template ?? null));
      return true;
    } catch { return false; }
  }

  /** Called only for the caster's successful terminal event, never by remote viewers. */
  async create(cast: Cast, template: ResidueTemplate, current: () => boolean): Promise<void> {
    if (!current() || !(await OBR.scene.isReady()) || !current()) return;
    const role = await OBR.player.getRole();
    if (!current()) return;
    if (role !== "GM") {
      const permissions = await OBR.room.getPermissions();
      if (!current()) return;
      if (!permissions.includes("PROP_CREATE")) throw new Error("没有创建 Props 的权限，请 GM 开启道具创建权限");
    }
    // The cast UUID is also the residual item's ID: retries cannot introduce a new copy.
    const existing = await OBR.scene.items.getItems([cast.castId]);
    if (!current() || existing.length) return;
    const metadata = await OBR.scene.getMetadata();
    if (!current() || `${OBR.room.id}:${metadata[SCENE_KEY]}` !== cast.sceneKey) return;
    const item = buildImage({ ...template.image }, {
      dpi: template.dpi,
      // Center the media at the hit point, independently of the asset's grid anchor.
      offset: { x: template.image.width / 2, y: template.image.height / 2 },
    }).id(cast.castId).name(`${template.name} · 火球残留`)
      .position({ ...cast.to }).scale({ ...template.scale }).rotation(template.rotation)
      .layer("PROP").visible(true).locked(false)
      .metadata({ [RESIDUE_KEY]: { castId: cast.castId, sceneKey: cast.sceneKey, version: 1 } }).build();
    if (!current()) return;
    // One shared item write, no RAF or timers. The user removes it using Owlbear's usual controls.
    // SDK writes cannot be aborted once sent; do not retry an ambiguous failure into a new scene.
    await OBR.scene.items.addItems([item]);
  }
}
