import * as THREE from 'three';

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

  /** Alarm state recolours the whole environment — the loudest readability cue. */
  setAlarmLighting(t) {
    const k = Math.max(0, Math.min(1, t));
    const calm = new THREE.Color(0x4a5c70);
    const alarm = new THREE.Color(0x554653);
    this.fogColor.copy(calm).lerp(alarm, k);
    this.scene.fog.color.copy(this.fogColor);
    this.scene.background.copy(this.fogColor);
    this.hemi.color.setHex(0x9fbde0).lerp(new THREE.Color(0xa98f96), k);
    this.hemi.intensity = 1.35 - 0.32 * k;
    this.sun.intensity = 2.1 - 0.75 * k;
    this.sun.color.setHex(0xffd2a1).lerp(new THREE.Color(0xff9d84), k);
    this.sky.material.uniforms.topColor.value
      .setHex(0x233c5e)
      .lerp(new THREE.Color(0x3a1d28), k);
    this.sky.material.uniforms.midColor.value
      .setHex(0x6c8199)
      .lerp(new THREE.Color(0x7d6068), k);
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
