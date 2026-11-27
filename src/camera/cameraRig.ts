import {
  Euler,
  MathUtils,
  PerspectiveCamera,
  Vector3,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export type CameraMode = "orbit" | "follow" | "free";

const MOVE_CODES = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "KeyQ",
  "KeyE",
  "Space",
  "ControlLeft",
  "ControlRight",
  "ShiftLeft",
  "ShiftRight",
]);

const MODE_KEYS: Record<string, CameraMode> = {
  Digit1: "orbit",
  Digit2: "follow",
  Digit3: "free",
};

const _forward = new Vector3();
const _right = new Vector3();
const _move = new Vector3();
const _desired = new Vector3();
const _vel = new Vector3();
const _anchor = new Vector3();
const _savedPos = new Vector3();
const _savedTarget = new Vector3();
const _euler = new Euler(0, 0, 0, "YXZ");

const MIN_FOLLOW = 6;
const MAX_FOLLOW = 120;
const MAX_RADIUS = 450;

export interface CameraRigOptions {
  camera: PerspectiveCamera;
  controls: OrbitControls;
  canvas: HTMLCanvasElement;
  getFollowAnchor: (out: Vector3) => Vector3;
}

/**
 * Orbit keeps the existing OrbitControls target.
 * Follow chases one anchor. Free flight is camera-relative WASD plus drag-look.
 */
export class CameraRig {
  mode: CameraMode = "orbit";
  followDistance = 22;
  flySpeed = 28;

  private readonly camera: PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly canvas: HTMLCanvasElement;
  private readonly getFollowAnchor: (out: Vector3) => Vector3;
  onChange: ((mode: CameraMode) => void) | null = null;

  private readonly keys = new Set<string>();
  private readonly chaseOffset = new Vector3(16, 10, 16);
  private readonly prevAnchor = new Vector3();

  private followReady = false;
  private needsOrbitSync = false;
  private yaw = 0;
  private pitch = 0.35;
  private pointerId: number | null = null;
  private lastX = 0;
  private lastY = 0;
  private lookMoved = 0;

  constructor(options: CameraRigOptions) {
    this.camera = options.camera;
    this.controls = options.controls;
    this.canvas = options.canvas;
    this.getFollowAnchor = options.getFollowAnchor;

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.canvas.addEventListener("contextmenu", (event) => {
      if (this.mode === "free") event.preventDefault();
    });
  }

  setMode(mode: CameraMode): void {
    if (mode === this.mode) return;
    this.releasePointer();
    this.mode = mode;
    if (mode === "orbit") {
      this.controls.enabled = true;
      this.needsOrbitSync = true;
    } else {
      this.controls.enabled = false;
      if (mode === "follow") this.followReady = false;
      if (mode === "free") this.captureFreeAngles();
    }
    this.onChange?.(mode);
  }

  /**
   * True when a free-flight press was a click (not a look drag).
   * Call from pointerup. Returns false when this rig did not own the gesture.
   */
  endPointer(event: PointerEvent): boolean {
    if (this.pointerId !== event.pointerId) return false;
    const click = this.lookMoved < 5;
    this.releasePointer();
    return this.mode === "free" && click;
  }

  beginPointer(event: PointerEvent): void {
    if (this.mode !== "free" || event.button !== 0) return;
    this.pointerId = event.pointerId;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    this.lookMoved = 0;
    this.canvas.setPointerCapture(event.pointerId);
  }

  movePointer(event: PointerEvent): void {
    if (this.pointerId !== event.pointerId || this.mode !== "free") return;
    const dx = event.clientX - this.lastX;
    const dy = event.clientY - this.lastY;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    this.lookMoved += Math.abs(dx) + Math.abs(dy);
    this.yaw -= dx * 0.003;
    this.pitch = MathUtils.clamp(this.pitch - dy * 0.003, -1.52, 1.52);
  }

  update(dt: number, applyOrbitTarget: () => void): void {
    if (this.mode === "orbit") {
      this.controls.enabled = true;
      applyOrbitTarget();
      if (this.needsOrbitSync) {
        this.syncOrbitFromCamera();
        this.needsOrbitSync = false;
      } else {
        this.controls.update();
      }
      return;
    }

    this.controls.enabled = false;
    if (this.mode === "follow") this.updateFollow(dt);
    else this.updateFree(dt);
  }

  statusText(): string {
    if (this.mode === "orbit") return "카메라: 궤도";
    if (this.mode === "follow") {
      return `카메라: 추적 ${this.followDistance.toFixed(0)}`;
    }
    return `카메라: 자유 비행 ${this.flySpeed.toFixed(0)}`;
  }

  private updateFollow(dt: number): void {
    const anchor = this.getFollowAnchor(_anchor);
    if (!this.followReady) {
      this.engageFollow(anchor);
      this.followReady = true;
    }

    _vel.subVectors(anchor, this.prevAnchor);
    this.prevAnchor.copy(anchor);
    if (_vel.lengthSq() > 1e-8) {
      _vel.normalize().multiplyScalar(-this.followDistance);
      _desired.copy(_vel);
      _desired.y += this.followDistance * 0.45;
      const len = _desired.length();
      if (len > 1e-6) _desired.multiplyScalar(this.followDistance / len);
      this.chaseOffset.lerp(_desired, 1 - Math.exp(-1.4 * dt));
    } else {
      const len = this.chaseOffset.length();
      if (len > 1e-6) this.chaseOffset.multiplyScalar(this.followDistance / len);
    }

    _desired.copy(anchor).add(this.chaseOffset);
    this.camera.position.lerp(_desired, 1 - Math.exp(-4 * dt));
    this.camera.lookAt(anchor);
  }

  private updateFree(dt: number): void {
    this.camera.rotation.order = "YXZ";
    this.camera.rotation.set(this.pitch, this.yaw, 0);

    const boost =
      this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") ? 3 : 1;
    _forward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    _right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    _move.set(0, 0, 0);
    if (this.keys.has("KeyW")) _move.add(_forward);
    if (this.keys.has("KeyS")) _move.sub(_forward);
    if (this.keys.has("KeyD")) _move.add(_right);
    if (this.keys.has("KeyA")) _move.sub(_right);
    if (this.keys.has("Space") || this.keys.has("KeyE")) _move.y += 1;
    if (
      this.keys.has("ControlLeft") ||
      this.keys.has("ControlRight") ||
      this.keys.has("KeyQ")
    ) {
      _move.y -= 1;
    }
    if (_move.lengthSq() > 0) {
      _move.normalize().multiplyScalar(this.flySpeed * boost * dt);
      this.camera.position.add(_move);
    }

    const radius = this.camera.position.length();
    if (radius > MAX_RADIUS) {
      this.camera.position.multiplyScalar(MAX_RADIUS / radius);
    }
  }

  private engageFollow(anchor: Vector3): void {
    this.chaseOffset.copy(this.camera.position).sub(anchor);
    let len = this.chaseOffset.length();
    if (len < MIN_FOLLOW || len > 160) {
      if (len < 1e-4) this.chaseOffset.set(0.55, 0.4, 0.7);
      len = this.chaseOffset.length();
      const dist = MathUtils.clamp(len, 18, 48);
      this.chaseOffset.multiplyScalar(dist / len);
      this.followDistance = this.chaseOffset.length();
    } else {
      this.followDistance = len;
    }
    this.prevAnchor.copy(anchor);
  }

  private captureFreeAngles(): void {
    _euler.setFromQuaternion(this.camera.quaternion, "YXZ");
    this.yaw = _euler.y;
    this.pitch = MathUtils.clamp(_euler.x, -1.52, 1.52);
  }

  /** Drop leftover orbit damping, then lock the current view onto the target. */
  private syncOrbitFromCamera(): void {
    _savedPos.copy(this.camera.position);
    _savedTarget.copy(this.controls.target);
    const damping = this.controls.enableDamping;
    this.controls.enableDamping = false;
    this.controls.update();
    this.camera.position.copy(_savedPos);
    this.controls.target.copy(_savedTarget);
    this.controls.update();
    this.controls.enableDamping = damping;
  }

  private releasePointer(): void {
    if (
      this.pointerId !== null &&
      this.canvas.hasPointerCapture(this.pointerId)
    ) {
      this.canvas.releasePointerCapture(this.pointerId);
    }
    this.pointerId = null;
    this.lookMoved = 0;
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    ) {
      return;
    }

    if (this.mode === "free" && MOVE_CODES.has(event.code)) {
      event.preventDefault();
      this.keys.add(event.code);
      return;
    }

    if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
    const next = MODE_KEYS[event.code];
    if (next) this.setMode(next);
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private onBlur = (): void => {
    this.keys.clear();
    this.releasePointer();
  };

  private onWheel = (event: WheelEvent): void => {
    if (this.mode === "orbit") return;
    event.preventDefault();
    const zoomIn = event.deltaY < 0;
    if (this.mode === "follow") {
      const factor = zoomIn ? 0.9 : 1.1;
      this.followDistance = MathUtils.clamp(
        this.followDistance * factor,
        MIN_FOLLOW,
        MAX_FOLLOW,
      );
      return;
    }
    const factor = zoomIn ? 0.87 : 1.15;
    this.flySpeed = MathUtils.clamp(this.flySpeed * factor, 8, 160);
  };
}
