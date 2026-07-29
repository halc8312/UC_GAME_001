import * as THREE from 'three';

// Alarm blend targets, hoisted: setAlarmLighting runs every frame and must not
// allocate five Colors per call.
const FOG_CALM = new THREE.Color(0x4a5c70);
const FOG_ALARM = new THREE.Color(0x475061);
const HEMI_CALM = new THREE.Color(0x9fbde0);
const HEMI_ALARM = new THREE.Color(0x93aac6);
const SUN_CALM = new THREE.Color(0xffd2a1);
const SUN_ALARM = new THREE.Color(0xffc194);
const SKY_TOP_CALM = new THREE.Color(0x233c5e);
const SKY_TOP_ALARM = new THREE.Color(0x1e3049);
const SKY_MID_CALM = new THREE.Color(0x6c8199);
const SKY_MID_ALARM = new THREE.Color(0x5f7186);

/**
 * Renderer + scene environment. Owns tonemapping, fog, sky, sun, and the render
 * target sizing policy. Everything visual that is not level geometry or an entity
 * lives here.
 */
export class RenderStack {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.maxPixelRatio = opts.maxPixelRatio ?? 1.5;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: opts.antialias !== false,
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.18;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setClearColor(0x0a1018, 1);
    // A frame is two render() calls — world, then the viewmodel overlay — and
    // three clears info.render at the top of each one. Left on autoReset, any
    // counter read after the frame describes the viewmodel alone: 24 calls and
    // 476 triangles, whatever the facility is doing. The frame owns the reset
    // instead, so drawCalls and triangles are the frame's totals.
    this.renderer.info.autoReset = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(78, 16 / 9, 0.06, 400);

    // Dusk sea fog: the mood anchor and the draw-distance limiter.
    this.fogColor = new THREE.Color(0x4a5c70);
    this.scene.fog = new THREE.FogExp2(this.fogColor.getHex(), 0.024);
    this.scene.background = this.fogColor.clone();

    this._disposables = [];
    this._buildSky();
    this._buildLights();
    this._buildEnvironment();
    this.resize();
  }

  /**
   * Prefilter the sky dome into an environment map.
   *
   * Without this, every `metalness > 0.3` surface renders black: a metal reflects
   * its environment and nothing else, so with no IBL there is nothing to reflect.
   * One PMREM pass at load fixes all the steel, pipes and grating at once.
   */
  _buildEnvironment() {
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      pmrem.compileEquirectangularShader();
      const envScene = new THREE.Scene();
      const skyClone = new THREE.Mesh(this.sky.geometry, this.sky.material);
      skyClone.frustumCulled = false;
      envScene.add(skyClone);
      // A dim ground bounce so downward-facing metal is not pitch black either.
      const ground = new THREE.Mesh(
        new THREE.SphereGeometry(280, 12, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0x2a2b28, side: THREE.BackSide }),
      );
      envScene.add(ground);
      const target = pmrem.fromScene(envScene, 0.04);
      this.envMap = target.texture;
      this.scene.environment = this.envMap;
      this.scene.environmentIntensity = 0.26;
      ground.geometry.dispose();
      ground.material.dispose();
      pmrem.dispose();
      this._disposables.push(target);
    } catch {
      // No env map is survivable; metals just read flatter.
      this.envMap = null;
    }
  }

  _buildSky() {
    // Vertical gradient dome, cheap and fog-matched. Rendered on the inside.
    const geo = new THREE.SphereGeometry(300, 24, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x233c5e) },
        midColor: { value: new THREE.Color(0x6c8199) },
        botColor: { value: new THREE.Color(0x6f7c8a) },
        offset: { value: 8.0 },
        exponent: { value: 0.9 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 topColor, midColor, botColor;
        uniform float offset, exponent;
        varying vec3 vWorld;
        void main() {
          float h = normalize(vWorld + vec3(0.0, offset, 0.0)).y;
          float t = pow(clamp(h, 0.0, 1.0), exponent);
          float b = pow(clamp(-h, 0.0, 1.0), 0.65);
          vec3 c = mix(midColor, topColor, t);
          c = mix(c, botColor, b * 0.85);
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1000;
    this.scene.add(this.sky);
    this._disposables.push(geo, mat);
  }

  _buildLights() {
    this.hemi = new THREE.HemisphereLight(0x9fbde0, 0x3a3630, 1.35);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xffd2a1, 2.1);
    this.sun.position.set(-38, 46, 62);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const s = this.sun.shadow.camera;
    s.near = 1;
    s.far = 190;
    s.left = -62;
    s.right = 62;
    s.top = 62;
    s.bottom = -62;
    this.sun.shadow.bias = -0.0007;
    this.sun.shadow.normalBias = 0.035;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.sun.target.position.set(4, 0, 0);

    this.ambient = new THREE.AmbientLight(0x40597c, 0.6);
    this.scene.add(this.ambient);
  }

  /**
   * Alarm state dims and slightly cools the ambient environment.
   *
   * Deliberately understated. An earlier version pushed the fog, sky, sun and
   * hemisphere hard toward red, which washed the entire second half of the game
   * in one flat colour *and* collided with the low-health signal — two different
   * states rendered as the same red screen. The alarm now reads through the local
   * strobes (which get relatively brighter as this drops the ambient) and the HUD
   * edge vignette, both of which are localised and unambiguous.
   */
  setAlarmLighting(t) {
    const k = Math.max(0, Math.min(1, t));
    this.fogColor.copy(FOG_CALM).lerp(FOG_ALARM, k);
    this.scene.fog.color.copy(this.fogColor);
    this.scene.background.copy(this.fogColor);
    this.hemi.color.copy(HEMI_CALM).lerp(HEMI_ALARM, k);
    this.hemi.intensity = 1.35 - 0.42 * k;
    this.sun.intensity = 2.1 - 0.62 * k;
    this.sun.color.copy(SUN_CALM).lerp(SUN_ALARM, k);
    this.sky.material.uniforms.topColor.value.copy(SKY_TOP_CALM).lerp(SKY_TOP_ALARM, k);
    this.sky.material.uniforms.midColor.value.copy(SKY_MID_CALM).lerp(SKY_MID_ALARM, k);
  }

  setFov(deg) {
    if (Math.abs(this.camera.fov - deg) < 0.001) return;
    this.camera.fov = deg;
    this.camera.updateProjectionMatrix();
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxPixelRatio);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    return { w, h, dpr };
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    for (const d of this._disposables) d.dispose?.();
    this._disposables.length = 0;
    this.renderer.dispose();
  }
}
