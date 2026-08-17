import * as THREE from 'three';
import { ARENA, groundHeightAt, STAGE_FOCUS } from '@/engine/world/layout';
import { EXT } from '@/engine/world/exterior';

export type CameraMode = 'cinematic' | 'walk' | 'seat' | 'orbit' | 'fly' | 'stage';

export type SeatInfo = {
  label: string;
  /** Straight-line distance to the stage, in metres. */
  distance: number;
  height: number;
};

type Shot = {
  from: [number, number, number];
  to: [number, number, number];
  look: [number, number, number];
  lookTo?: [number, number, number];
  dur: number;
  fov?: number;
  name: string;
};

/**
 * Eight hand-set camera moves. A single orbiting camera reads as a 3D model
 * viewer; cutting between framings — wide, crowd-level, on-stage, crane — is
 * what makes it read as coverage of an event.
 */
const SHOTS: Shot[] = [
  // Outside first — you arrive at a building before you're inside one.
  { name: 'Approach', from: [516, 4.6, 1], to: [430, 4.6, -1], look: [220, 22, 0], dur: 15, fov: 58 },
  { name: 'Car park', from: [402, 7, 128], to: [356, 6, 78], look: [230, 26, 0], dur: 13, fov: 60 },
  { name: 'Arrival', from: [418, 4.6, 2], to: [318, 4.6, 0], look: [220, 26, 0], dur: 14, fov: 56 },
  { name: 'Frontage', from: [300, 3.2, -84], to: [262, 3.2, -22], look: [214, 18, 0], dur: 12, fov: 62 },
  { name: 'Marquee', from: [268, 3.5, 6], to: [244, 13, 2], look: [222, 48, 0], lookTo: [222, 62, 0], dur: 10, fov: 55 },
  { name: 'Gate', from: [252, 2.1, 34], to: [230, 2.1, 13], look: [212, 4.5, 2], dur: 9, fov: 68 },
  { name: 'Plaza', from: [430, 66, -240] as [number, number, number], to: [356, 52, -160], look: [170, 30, 0], dur: 15, fov: 40 },
  { name: 'Upper deck wide', from: [152, 48, 34], to: [124, 41, 24], look: [-40, 10, 0], dur: 13, fov: 46 },
  { name: 'Floor dolly', from: [12, 1.75, -20], to: [12, 1.75, 20], look: [-40, 6, 0], dur: 12, fov: 58 },
  { name: 'Upstage', from: [-59, 7, -2], to: [-53, 5.5, 2], look: [40, 12, 0], dur: 10, fov: 62 },
  { name: 'Crane', from: [32, 2.6, 0], to: [22, 28, 0], look: [-44, 6, 0], lookTo: [-44, 16, 0], dur: 12, fov: 52 },
  { name: 'Front row', from: [-31, 2.4, -3], to: [-27, 2.4, 3], look: [-46, 16, 0], dur: 9, fov: 68 },
  { name: 'Helicopter', from: [96, 56, -76], to: [58, 47, 64], look: [0, 4, 0], lookTo: [-40, 8, 0], dur: 16, fov: 44 },
  { name: 'Side stage', from: [-38, 9, 44], to: [-28, 6.5, 27], look: [-46, 5, 0], dur: 10, fov: 55 },
  { name: 'Roof corner', from: [-96, 52, 84], to: [-62, 45, 62], look: [-44, 12, 0], dur: 13, fov: 42 },
];

const EYE_HEIGHT = 1.62;

export class CameraRig {
  camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'cinematic';
  onTeleport?: (info: SeatInfo) => void;
  onModeChange?: (mode: CameraMode) => void;
  onShot?: (name: string) => void;
  /** Fired once when the walker steps through a gate into the building. */
  onEnterVenue?: () => void;
  /** Fired per footfall so the audio layer can place a step sound. */
  onFootstep?: (running: boolean) => void;

  /** Set true while a flight is in progress, so the HUD can dim controls. */
  travelling = false;

  private dom: HTMLElement;
  private pickTargets: THREE.Object3D[] = [];
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();

  // Look state, shared by seat / stage / fly.
  private yaw = 0;
  private pitch = 0;
  private eye = new THREE.Vector3(120, 40, 24);

  // Orbit state.
  private orbAz = 0.5;
  private orbEl = 0.42;
  private orbRadius = 170;
  private orbTarget = new THREE.Vector3(-10, 8, 0);

  // Cinematic state.
  private shotIndex = 0;
  private shotT = 0;

  // Free-fly / walk input.
  private keys = new Set<string>();

  // Walking on the plaza.
  private walkTargets: THREE.Object3D[] = [];
  private groundRay = new THREE.Raycaster();
  private downVec = new THREE.Vector3(0, -1, 0);
  private walkBob = 0;
  private stepAccum = 0;
  private groundY = 0;
  /** Latched so walking back and forth through a gate doesn't re-fire. */
  private enteredVenue = false;

  // Flight tween.
  private flight = {
    active: false,
    t: 0,
    dur: 1.6,
    from: new THREE.Vector3(),
    to: new THREE.Vector3(),
    fromQ: new THREE.Quaternion(),
    toQ: new THREE.Quaternion(),
    lift: 0,
  };

  private baseFov = 52;
  private dragging = false;
  private dragMoved = 0;
  private lastX = 0;
  private lastY = 0;
  private pointerId: number | null = null;

  // Scratch.
  private _q = new THREE.Quaternion();
  private _e = new THREE.Euler(0, 0, 0, 'YXZ');
  private _v = new THREE.Vector3();
  private _v2 = new THREE.Vector3();
  private _look = new THREE.Vector3();
  private _fwd = new THREE.Vector3();
  private _right = new THREE.Vector3();
  private _shake = new THREE.Vector3();

  constructor(camera: THREE.PerspectiveCamera, dom: HTMLElement) {
    this.camera = camera;
    this.dom = dom;
    this.camera.fov = this.baseFov;
    this.camera.near = 0.1;
    this.camera.far = 2600;
    this.camera.updateProjectionMatrix();
    this.attach();
  }

  setPickTargets(targets: THREE.Object3D[]) {
    this.pickTargets = targets;
  }

  /** Surfaces the walk controller stands on. */
  setWalkTargets(targets: THREE.Object3D[]) {
    this.walkTargets = targets;
  }

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    this.dragging = true;
    this.dragMoved = 0;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.pointerId = e.pointerId;
    this.dom.setPointerCapture?.(e.pointerId);
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.dragMoved += Math.abs(dx) + Math.abs(dy);

    if (this.mode === 'orbit') {
      this.orbAz -= dx * 0.004;
      this.orbEl = THREE.MathUtils.clamp(this.orbEl - dy * 0.003, 0.03, 1.35);
    } else {
      // Drag-to-look. Deliberately not pointer-lock: this has to stay usable
      // on a trackpad, and a page that swallows the cursor is hostile.
      this.yaw -= dx * 0.0032;
      this.pitch = THREE.MathUtils.clamp(this.pitch - dy * 0.0028, -1.15, 1.15);
      this.flight.active = false; // taking manual control cancels a flight
      this.travelling = false;
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.pointerId !== null) {
      this.dom.releasePointerCapture?.(this.pointerId);
      this.pointerId = null;
    }
    // A click, not a drag: take it as "put me there".
    if (this.dragMoved < 7) this.tryTeleport(e.clientX, e.clientY);
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (this.mode === 'orbit') {
      this.orbRadius = THREE.MathUtils.clamp(this.orbRadius * (1 + e.deltaY * 0.0012), 40, 480);
    } else {
      // Zoom by focal length, like a real long lens on a camera platform.
      this.baseFov = THREE.MathUtils.clamp(this.baseFov + e.deltaY * 0.02, 22, 82);
    }
  };

  /** True while the user is typing, so movement keys don't hijack a text field. */
  private static isTyping(e: KeyboardEvent): boolean {
    const el = e.target as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  private onKeyDown = (e: KeyboardEvent) => {
    // Without this, typing a URL into the set list walks you down the street:
    // every 'w', 'a', 's' and 'd' in the text was also a movement key.
    if (CameraRig.isTyping(e)) return;
    this.keys.add(e.code);
  };
  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  private attach() {
    this.dom.addEventListener('pointerdown', this.onPointerDown);
    this.dom.addEventListener('pointermove', this.onPointerMove);
    this.dom.addEventListener('pointerup', this.onPointerUp);
    this.dom.addEventListener('pointercancel', this.onPointerUp);
    this.dom.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  dispose() {
    this.dom.removeEventListener('pointerdown', this.onPointerDown);
    this.dom.removeEventListener('pointermove', this.onPointerMove);
    this.dom.removeEventListener('pointerup', this.onPointerUp);
    this.dom.removeEventListener('pointercancel', this.onPointerUp);
    this.dom.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }

  // ---------------------------------------------------------------------------
  // Teleport
  // ---------------------------------------------------------------------------

  private tryTeleport(clientX: number, clientY: number) {
    if (!this.pickTargets.length) return;
    const rect = this.dom.getBoundingClientRect();
    this.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, this.camera);
    // Clicking should work on the street and plaza too, not just the bowl.
    const targets = this.mode === 'walk' ? [...this.walkTargets, ...this.pickTargets] : this.pickTargets;
    const hits = this.raycaster.intersectObjects(targets, false);
    if (!hits.length) return;

    const point = hits[0].point;
    const r = Math.hypot(point.x / ARENA.ellipse.a, point.z / ARENA.ellipse.b);

    // Inside the bowl a click means "seat me there". Outside, it means "walk
    // me over there" — staying on foot rather than snapping into a seat.
    if (r < EXT.podium.rIn) {
      this.flyToSeat(point);
    } else if (this.mode === 'walk') {
      this.eye.set(point.x, point.y + EYE_HEIGHT, point.z);
      this.groundY = point.y;
    } else {
      this.flyToSeat(point);
    }
  }

  /** Move the viewer to a point in the bowl and hand them the look controls. */
  flyToSeat(point: THREE.Vector3) {
    // Describe the seat before the eye offset is applied, so the reported
    // height is the seat's, not the viewer's eyeline.
    const info = this.describeSeat(point);
    const dest = this._v2.copy(point);
    dest.y += EYE_HEIGHT;

    // Face the stage from wherever we land.
    this._look.copy(STAGE_FOCUS).sub(dest).normalize();
    const pitch = Math.asin(THREE.MathUtils.clamp(this._look.y, -1, 1));
    const yaw = Math.atan2(-this._look.x, -this._look.z);

    this.startFlight(dest, pitch, yaw);
    this.mode = 'seat';
    this.onModeChange?.('seat');
    this.onTeleport?.(info);
  }

  private startFlight(dest: THREE.Vector3, pitch: number, yaw: number) {
    const f = this.flight;
    f.from.copy(this.camera.position);
    f.to.copy(dest);
    f.fromQ.copy(this.camera.quaternion);
    this._e.set(pitch, yaw, 0);
    f.toQ.setFromEuler(this._e);
    f.t = 0;
    const dist = f.from.distanceTo(f.to);
    f.dur = THREE.MathUtils.clamp(0.35 + dist * 0.006, 0.5, 1.5);
    // Arc over the venue rather than clipping through the bowl on the way.
    f.lift = THREE.MathUtils.clamp(dist * 0.16, 0, 26);
    f.active = true;
    this.travelling = true;

    this.eye.copy(dest);
    this.pitch = pitch;
    this.yaw = yaw;
  }

  /**
   * Step out of the tunnel into the bowl. This is the moment the venue is
   * supposed to open up in front of you, so the viewer arrives at the head of
   * a lower-tier gangway with the stage already in frame.
   */
  emergeInBowl() {
    // Straight into a seat. Walking the concourse and hunting for a row is the
    // boring part of going to a gig; the point is to be sat down with the
    // stage in front of you.
    const tier = ARENA.tiers[0];
    const row = 9;
    const r = tier.r0 + row * tier.tread;
    const theta = 0.22;
    this.enteredVenue = true;
    this.flyToSeat(
      new THREE.Vector3(
        r * ARENA.ellipse.a * Math.cos(theta),
        tier.y0 + row * tier.rise,
        r * ARENA.ellipse.b * Math.sin(theta),
      ),
    );
  }

  /** Put the walker back on the approach street, outside the gates. */
  returnToStreet() {
    this.mode = 'walk';
    this.enteredVenue = false;
    this.eye.set(498, EYE_HEIGHT, 0.5);
    this.groundY = 0;
    this.faceTowards(this._v.set(EXT.podium.rOut * ARENA.ellipse.a, 20, 0));
    this.onModeChange?.('walk');
  }

  /** Point the viewer's yaw/pitch at a world position from wherever `eye` is. */
  private faceTowards(target: THREE.Vector3) {
    this._look.copy(target).sub(this.eye).normalize();
    this.pitch = Math.asin(THREE.MathUtils.clamp(this._look.y, -1, 1));
    this.yaw = Math.atan2(-this._look.x, -this._look.z);
  }

  /** Human-readable seat, derived from where in the bowl the point landed. */
  describeSeat(point: THREE.Vector3): SeatInfo {
    const { a, b } = ARENA.ellipse;
    const r = Math.hypot(point.x / a, point.z / b);
    const theta = Math.atan2(point.z / b, point.x / a);
    const sector = Math.floor((((theta + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2)) * 24) + 1;

    let label = 'Floor · General admission';
    for (let ti = 0; ti < ARENA.tiers.length; ti++) {
      const t = ARENA.tiers[ti];
      const rEnd = t.r0 + t.rows * t.tread;
      if (r >= t.r0 - 1 && r <= rEnd + 1) {
        const row = Math.min(t.rows, Math.max(1, Math.floor((r - t.r0) / t.tread) + 1));
        label = `Sec ${(ti + 1) * 100 + sector} · Row ${row}`;
        break;
      }
    }

    return {
      label,
      distance: Math.round(point.distanceTo(STAGE_FOCUS)),
      height: Math.round(point.y * 10) / 10,
    };
  }

  // ---------------------------------------------------------------------------
  // Modes
  // ---------------------------------------------------------------------------

  setMode(mode: CameraMode) {
    if (mode === this.mode) return;
    const prev = this.mode;
    this.mode = mode;

    if (mode === 'orbit') {
      // Enter orbit from wherever we are, so the switch never jump-cuts.
      this._v.copy(this.camera.position).sub(this.orbTarget);
      this.orbRadius = THREE.MathUtils.clamp(this._v.length(), 60, 420);
      this.orbAz = Math.atan2(this._v.z, this._v.x);
      this.orbEl = Math.asin(THREE.MathUtils.clamp(this._v.y / this.orbRadius, -0.99, 0.99));
      this.flight.active = false;
    } else if (mode === 'cinematic') {
      this.shotT = 0;
      this.flight.active = false;
      this.onShot?.(SHOTS[this.shotIndex].name);
    } else if (mode === 'stage') {
      // Performer's view: on the thrust, facing the crowd.
      this._v.set(ARENA.stage.thrustTo + 2, ARENA.stage.deckY + EYE_HEIGHT, 0);
      this.startFlight(this._v, -0.02, Math.atan2(-1, 0));
    } else if (mode === 'seat' && prev !== 'seat') {
      // No specific seat picked yet — drop into a real one, nine rows up in the
      // lower bowl and slightly off-centre. Best seat in the house.
      const tier = ARENA.tiers[0];
      const row = 8;
      const r = tier.r0 + row * tier.tread;
      const theta = 0.38;
      // A fresh vector, not scratch: flyToSeat reads the point it is given.
      this.flyToSeat(
        new THREE.Vector3(
          r * ARENA.ellipse.a * Math.cos(theta),
          tier.y0 + row * tier.rise,
          r * ARENA.ellipse.b * Math.sin(theta),
        ),
      );
      return;
    } else if (mode === 'fly') {
      this.flight.active = false;
      this.eye.copy(this.camera.position);
    } else if (mode === 'walk') {
      this.flight.active = false;
      // Drop in on the plaza approach, facing the entrance, unless we're
      // already outside — in which case keep the viewer where they stand.
      const r = Math.hypot(this.camera.position.x / ARENA.ellipse.a, this.camera.position.z / ARENA.ellipse.b);
      if (r < EXT.podium.rOut || this.camera.position.y > 14) {
        // Spawn at the far end of the approach street, facing the building.
        this.eye.set(498, EYE_HEIGHT, 0.5);
        const gate = EXT.gates[2]; // first opening left of centre
        this.faceTowards(
          this._v.set(
            EXT.podium.rOut * ARENA.ellipse.a * Math.cos(gate),
            6,
            EXT.podium.rOut * ARENA.ellipse.b * Math.sin(gate),
          ),
        );
      } else {
        this.eye.copy(this.camera.position);
        // Adopt the camera's current facing. Cinematic shots drive the camera
        // with lookAt and never touch yaw/pitch, so without this the walker
        // sets off in whatever direction yaw happened to be left at — which
        // is why walking "at" the stadium missed it entirely.
        this._look.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
        this.pitch = Math.asin(THREE.MathUtils.clamp(this._look.y, -1, 1));
        this.yaw = Math.atan2(-this._look.x, -this._look.z);
      }
      this.groundY = 0;
    }
    if (mode !== 'walk') this.enteredVenue = false;
    this.onModeChange?.(mode);
  }

  nextShot() {
    this.shotIndex = (this.shotIndex + 1) % SHOTS.length;
    this.shotT = 0;
    this.onShot?.(SHOTS[this.shotIndex].name);
  }

  // ---------------------------------------------------------------------------
  // Frame update
  // ---------------------------------------------------------------------------

  update(dt: number, shake: number) {
    const cam = this.camera;

    if (this.flight.active) {
      this.updateFlight(dt);
    } else {
      switch (this.mode) {
        case 'cinematic':
          this.updateCinematic(dt);
          break;
        case 'orbit':
          this.updateOrbit(dt);
          break;
        case 'fly':
          this.updateFly(dt);
          break;
        case 'walk':
          this.updateWalk(dt);
          break;
        case 'seat':
        case 'stage':
          this.updateLook(dt);
          break;
      }
    }

    // Sub-bass rumble. Small, but it's the difference between watching a show
    // and being at one.
    if (shake > 0.001) {
      const s = shake * 0.16;
      this._shake.set(
        (Math.random() - 0.5) * s,
        (Math.random() - 0.5) * s,
        (Math.random() - 0.5) * s * 0.6,
      );
      cam.position.add(this._shake);
      cam.rotateZ((Math.random() - 0.5) * shake * 0.004);
    }

    const fovTarget = this.baseFov + shake * 1.6;
    if (Math.abs(cam.fov - fovTarget) > 0.01) {
      cam.fov += (fovTarget - cam.fov) * Math.min(1, dt * 6);
      cam.updateProjectionMatrix();
    }
  }

  private updateFlight(dt: number) {
    const f = this.flight;
    f.t += dt;
    const raw = THREE.MathUtils.clamp(f.t / f.dur, 0, 1);
    // Ease in-out cubic: a camera platform accelerates and settles.
    const k = raw < 0.5 ? 4 * raw ** 3 : 1 - (-2 * raw + 2) ** 3 / 2;

    this.camera.position.lerpVectors(f.from, f.to, k);
    this.camera.position.y += Math.sin(k * Math.PI) * f.lift;
    this.camera.quaternion.slerpQuaternions(f.fromQ, f.toQ, k);

    if (raw >= 1) {
      f.active = false;
      this.travelling = false;
      this.eye.copy(f.to);
    }
  }

  private updateLook(_dt: number) {
    this.camera.position.copy(this.eye);
    this._e.set(this.pitch, this.yaw, 0);
    this.camera.quaternion.setFromEuler(this._e);
  }

  private updateFly(dt: number) {
    const speed = (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 48 : 16) * dt;
    this._e.set(this.pitch, this.yaw, 0);
    this._q.setFromEuler(this._e);
    this._fwd.set(0, 0, -1).applyQuaternion(this._q);
    this._right.set(1, 0, 0).applyQuaternion(this._q);

    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) this.eye.addScaledVector(this._fwd, speed);
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) this.eye.addScaledVector(this._fwd, -speed);
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) this.eye.addScaledVector(this._right, -speed);
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) this.eye.addScaledVector(this._right, speed);
    if (this.keys.has('KeyQ')) this.eye.y -= speed;
    if (this.keys.has('KeyE')) this.eye.y += speed;

    this.eye.y = Math.max(0.5, this.eye.y);
    this.camera.position.copy(this.eye);
    this.camera.quaternion.copy(this._q);
  }

  /**
   * Ground-level walking on the plaza.
   *
   * Movement is yaw-only — looking up must not launch you into the sky — and
   * the eye height is resolved by dropping a ray onto the plaza each frame, so
   * kerbs and the podium step are followed for free. The building is treated
   * as a cylinder you can't enter except through a gate opening.
   */
  private updateWalk(dt: number) {
    const running = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    // Brisk walk / run. The approach is ~250m; at a realistic 1.4 m/s that is
    // three minutes of holding W, which is not an experience.
    const speed = (running ? 16 : 7) * dt;

    // Heading from yaw alone.
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    this._fwd.set(-sin, 0, -cos);
    this._right.set(cos, 0, -sin);

    let moved = 0;
    const step = (dir: THREE.Vector3, amount: number) => {
      this.eye.addScaledVector(dir, amount);
      moved += Math.abs(amount);
    };
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) step(this._fwd, speed);
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) step(this._fwd, -speed);
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) step(this._right, -speed);
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) step(this._right, speed);

    // --- keep out of the building, except through a gate ---
    const rx = this.eye.x / ARENA.ellipse.a;
    const rz = this.eye.z / ARENA.ellipse.b;
    const r = Math.hypot(rx, rz);
    const theta = Math.atan2(rz, rx);
    const wall = EXT.podium.rOut - 1.2;
    if (r < wall) {
      const throughGate = EXT.gates.some((g) => Math.abs(theta - g) < EXT.gateHalf - 0.008);

      // Walking into a gate is what takes you inside. Rather than model a full
      // concourse, entering the tunnel mouth hands off to the bowl — the same
      // trick most games use for a doorway you're meant to pass through.
      // Forgiving: anywhere across the entrance frontage counts as going in,
      // not just the exact gate apertures. Requiring pixel-accurate alignment
      // with a 15m opening from 300m away is a puzzle, not an entrance.
      const atFrontage = Math.abs(theta) < 0.26;
      if ((throughGate || atFrontage) && r < EXT.podium.rOut - 1 && !this.enteredVenue) {
        this.enteredVenue = true;
        this.onEnterVenue?.();
        return;
      }

      const limit = throughGate ? EXT.podium.rIn + 1.5 : wall;
      if (r < limit) {
        const k = limit / Math.max(1e-4, r);
        this.eye.x = rx * k * ARENA.ellipse.a;
        this.eye.z = rz * k * ARENA.ellipse.b;
      }
    }

    // --- stand on the ground ---
    this.groundY = groundHeightAt(this.eye.x, this.eye.z);
    const targetY = this.groundY + EYE_HEIGHT;
    this.eye.y += (targetY - this.eye.y) * Math.min(1, dt * 12);

    // Head bob, small enough to feel rather than notice.
    this.walkBob += moved * (running ? 1.5 : 1.1);
    const bob = Math.sin(this.walkBob * 1.9) * (running ? 0.055 : 0.03);

    // A footfall every stride's worth of ground covered, so the rate follows
    // the actual speed rather than a fixed timer.
    if (moved > 0) {
      this.stepAccum += moved;
      const stride = running ? 1.9 : 1.35;
      if (this.stepAccum >= stride) {
        this.stepAccum = 0;
        this.onFootstep?.(running);
      }
    } else {
      // Standing still: prime the accumulator so the next stride lands promptly.
      this.stepAccum = 1.0;
    }

    this.camera.position.set(this.eye.x, this.eye.y + bob, this.eye.z);
    this._e.set(this.pitch, this.yaw, 0);
    this.camera.quaternion.setFromEuler(this._e);
  }

  private updateOrbit(dt: number) {
    if (!this.dragging) this.orbAz += dt * 0.028; // slow drift when idle
    const r = this.orbRadius;
    const y = Math.sin(this.orbEl) * r;
    const h = Math.cos(this.orbEl) * r;
    this._v.set(
      this.orbTarget.x + Math.cos(this.orbAz) * h,
      this.orbTarget.y + y,
      this.orbTarget.z + Math.sin(this.orbAz) * h,
    );
    this.camera.position.lerp(this._v, Math.min(1, dt * 5));
    this.camera.lookAt(this.orbTarget);
    this.eye.copy(this.camera.position);
  }

  private updateCinematic(dt: number) {
    const shot = SHOTS[this.shotIndex];
    this.shotT += dt;
    const k = THREE.MathUtils.clamp(this.shotT / shot.dur, 0, 1);
    // Ease-out only: shots should start moving immediately and settle.
    const e = 1 - Math.pow(1 - k, 2.2);

    this._v.fromArray(shot.from);
    this._v2.fromArray(shot.to);
    this.camera.position.lerpVectors(this._v, this._v2, e);

    this._look.fromArray(shot.look);
    if (shot.lookTo) this._look.lerp(this._v2.fromArray(shot.lookTo), e);
    this.camera.lookAt(this._look);

    const targetFov = shot.fov ?? 52;
    this.baseFov += (targetFov - this.baseFov) * Math.min(1, dt * 1.5);

    if (k >= 1) this.nextShot();
    this.eye.copy(this.camera.position);
  }

  get currentShotName() {
    return SHOTS[this.shotIndex].name;
  }
}
