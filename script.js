class Component extends DCLogic {
  constructor(props) {
    super(props);
    this.state = {
      activePanel: 0,
      carouselIndex: 0,
      formData: { name: '', email: '', message: '' },
      formError: '',
      formSuccess: false,
    };
    this.carouselAutoTimer = null;
    this.carouselDrag = null;
    this.mugCanvasRef = React.createRef();
    this.glowRef = React.createRef();
    this.scrollProgress = 0; // 0..1 across the journey (4 panels)
    this.textureCache = [];
    this.NUM_PANELS = 4;

    // Each panel's mug "stop". ry is rotation OFFSET from base (front-facing).
    // Base rotation = Math.PI/2 puts handle at back, U=0.5 (canvas center) faces camera.
    this.stops = [
      { x:  0.00, y:  0.00, s: 1.00, ry: 0.0 },  // 0: center, front-facing
      { x:  0.55, y: -0.05, s: 0.92, ry: -0.35 }, // 1: right, slight turn
      { x: -0.55, y:  0.05, s: 0.92, ry:  0.35 }, // 2: left, opposite turn
      { x:  0.00, y:  0.00, s: 1.05, ry: 0.0 },  // 3: center, front-facing
    ];
  }

  componentDidMount() {
    this.initThree();
    this.initObservers();
    this.initScroll();
    this.startCarouselAutoRotate();
    window.addEventListener('resize', this.onResize);
  }

  componentWillUnmount() {
    cancelAnimationFrame(this.rafId);
    this.heroVisible = false;
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('scroll', this.onScroll);
    if (this.carouselAutoTimer) clearInterval(this.carouselAutoTimer);
    window.removeEventListener('mousemove', this.onCarouselDragMove);
    window.removeEventListener('mouseup', this.onCarouselDragEnd);
    window.removeEventListener('touchmove', this.onCarouselDragMove);
    window.removeEventListener('touchend', this.onCarouselDragEnd);
    if (this.renderer) this.renderer.dispose();
    this.textureCache.forEach(t => t && t.dispose && t.dispose());
  }

  // ---------- TEXTURES ----------
  buildTextures() {
    const designs = [
      // 0: plain ceramic (white)
      (ctx, w, h) => {
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, w, h);
      },
      // 1: "feito em casa" wordmark
      (ctx, w, h) => {
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#1a2733';
        ctx.font = '300 110px "Fraunces", serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('feito', w / 2, h / 2 - 64);
        ctx.fillText('em casa', w / 2, h / 2 + 68);
        ctx.strokeStyle = '#1E5F7E';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(w / 2 - 90, h / 2 + 6);
        ctx.lineTo(w / 2 + 90, h / 2 + 6);
        ctx.stroke();
      },
      // 2: dotted pattern
      (ctx, w, h) => {
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#1E5F7E';
        const step = 56;
        for (let y = step / 2; y < h; y += step) {
          for (let x = step / 2; x < w; x += step) {
            ctx.beginPath();
            ctx.arc(x + (Math.floor(y / step) % 2 ? step / 2 : 0), y, 7, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      },
      // 3: stripes + heart
      (ctx, w, h) => {
        const grd = ctx.createLinearGradient(0, 0, 0, h);
        grd.addColorStop(0, '#FFFFFF');
        grd.addColorStop(1, '#E8F4F8');
        ctx.fillStyle = grd;
        ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = '#B8E5F0';
        ctx.lineWidth = 14;
        for (let y = 60; y < h; y += 80) {
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
          ctx.stroke();
        }
        ctx.fillStyle = '#1E5F7E';
        const cx = w / 2, cy = h / 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy + 55);
        ctx.bezierCurveTo(cx + 110, cy - 25, cx + 66, cy - 110, cx, cy - 44);
        ctx.bezierCurveTo(cx - 66, cy - 110, cx - 110, cy - 25, cx, cy + 55);
        ctx.fill();
      },
    ];

    designs.forEach(draw => {
      const canvas = document.createElement('canvas');
      canvas.width = 1024;
      canvas.height = 512;
      const ctx = canvas.getContext('2d');
      draw(ctx, canvas.width, canvas.height);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 16;
      tex.wrapS = THREE.RepeatWrapping;
      tex.needsUpdate = true;
      this.textureCache.push(tex);
    });
  }

  // Composite texture A->B with `t` blend, written to an offscreen canvas
  buildBlendedTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 1024; canvas.height = 1024;
    this.blendCanvas = canvas;
    this.blendCtx = canvas.getContext('2d');
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.offset.x = 0.5;  // shift so canvas-center (U=0.5) maps to lathe front (+Z)
    tex.offset.y = 0.25; // <-- ADICIONE ESTA LINHA PARA AJUSTAR VERTICALMENTE
    this.blendTex = tex;
    return tex;
  }

  updateBlendedTexture(idxA, idxB, t) {
    if (!this.blendCtx) return;
    const w = this.blendCanvas.width, h = this.blendCanvas.height;
    const ctx = this.blendCtx;
    // Draw A as base
    ctx.globalAlpha = 1;
    ctx.drawImage(this.sourceCanvases[idxA], 0, 0, w, h);
    // Draw B with alpha
    ctx.globalAlpha = t;
    ctx.drawImage(this.sourceCanvases[idxB], 0, 0, w, h);
    ctx.globalAlpha = 1;
    this.blendTex.needsUpdate = true;
  }

  // Cria um envMap procedural (gradiente claro tipo estúdio) usando PMREM
  // para gerar reflexos suaves no acabamento cerâmico, sem dependência externa.
  buildCeramicEnvMap() {
    try {
      const size = 256;
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      // Gradiente vertical: teto claro -> horizonte -> chão escuro
      const g = ctx.createLinearGradient(0, 0, 0, size);
      g.addColorStop(0.00, '#ffffff');
      g.addColorStop(0.45, '#eaf3f7');
      g.addColorStop(0.55, '#cfe2ea');
      g.addColorStop(1.00, '#3a4a55');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
      // "Softbox" superior — highlight forte no topo
      const sb = ctx.createRadialGradient(size * 0.5, size * 0.18, 4, size * 0.5, size * 0.18, size * 0.45);
      sb.addColorStop(0, 'rgba(255,255,255,1)');
      sb.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = sb;
      ctx.fillRect(0, 0, size, size);
      // Janela lateral — segundo highlight
      const sb2 = ctx.createRadialGradient(size * 0.15, size * 0.4, 2, size * 0.15, size * 0.4, size * 0.35);
      sb2.addColorStop(0, 'rgba(255,255,255,0.85)');
      sb2.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = sb2;
      ctx.fillRect(0, 0, size, size);

      const tex = new THREE.CanvasTexture(canvas);
      tex.mapping = THREE.EquirectangularReflectionMapping;
      if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;

      if (THREE.PMREMGenerator) {
        const pmrem = new THREE.PMREMGenerator(this.renderer);
        pmrem.compileEquirectangularShader();
        const target = pmrem.fromEquirectangular(tex);
        tex.dispose();
        pmrem.dispose();
        return target.texture;
      }
      return tex;
    } catch (e) {
      console.warn('envMap build failed', e);
      return null;
    }
  }

  // ---------- THREE ----------
  initThree() {
    if (typeof THREE === 'undefined') {
      setTimeout(() => this.initThree(), 200);
      return;
    }
    const canvas = this.mugCanvasRef.current;
    if (!canvas) return;
    const w = window.innerWidth, h = window.innerHeight;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, w / h, 0.1, 100);
    // Distância maior — câmera afastada para dar mais "ar" ao redor da caneca
    this.cameraRadius = 10.5;
    this.cameraTargetY = 0.0;
    this.camera.position.set(0, 0.6, this.cameraRadius);
    this.camera.lookAt(0, this.cameraTargetY, 0);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    if ('outputColorSpace' in this.renderer) this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Tone mapping para realçar o brilho cerâmico
    if ('toneMapping' in this.renderer) {
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.05;
    }

    // Environment map procedural (gradiente claro) para reflexos cerâmicos
    this.scene.environment = this.buildCeramicEnvMap();

    // Lights
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const key = new THREE.DirectionalLight(0xffffff, 1.25);
    key.position.set(4, 6, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -5; key.shadow.camera.right = 5;
    key.shadow.camera.top = 5; key.shadow.camera.bottom = -5;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xB8E5F0, 0.55);
    rim.position.set(-5, 2, -3);
    this.scene.add(rim);
    const fill = new THREE.DirectionalLight(0xffffff, 0.35);
    fill.position.set(-2, 1, 4);
    this.scene.add(fill);

    // Build source canvases (raw, used for blending)
    this.sourceCanvases = [];
    const designs = this.designsList();
    designs.forEach(draw => {
      const c = document.createElement('canvas');
      c.width = 1024; c.height = 1024;
      draw(c.getContext('2d'), c.width, c.height);
      this.sourceCanvases.push(c);
    });
    // Initialize blend canvas with design 0
    this.buildBlendedTexture();
    this.updateBlendedTexture(0, 0, 0);
    // Load logo and bake it into source canvas 0 once available
    this.loadLogoIntoFirstTexture();

    // Mug group — default rotation puts handle at +X (right) and texture
    // seam (U=0) at +Z (front). We compensate by shifting the texture offset
    // so the canvas center (where we paint the logo) ends up at the front.
    this.mug = new THREE.Group();
    this.scene.add(this.mug);

    // Body
    const points = [];
    const steps = 32;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const y = -1.0 + t * 2.0;
      let r = 1.0 + Math.sin(t * Math.PI) * 0.04;
      if (t > 0.95) r = 1.0 + (1 - t) * 0.2 + 0.02;
      points.push(new THREE.Vector2(r, y));
    }
    const wallThickness = 0.06;
    for (let i = steps; i >= 0; i--) {
      const t = i / steps;
      const y = -1.0 + t * 2.0;
      let r = 1.0 + Math.sin(t * Math.PI) * 0.04 - wallThickness;
      if (t > 0.95) r = 1.0 + (1 - t) * 0.2 + 0.02 - wallThickness;
      if (t < 0.05) r = 0;
      points.push(new THREE.Vector2(Math.max(0, r), y - (t < 0.05 ? 0.0 : 0.08)));
    }
    const bodyGeo = new THREE.LatheGeometry(points, 96);

    // Material cerâmico brilhoso (porcelana esmaltada) — clearcoat + baixa rugosidade
    const PhysMat = THREE.MeshPhysicalMaterial || THREE.MeshStandardMaterial;
    this.outerMat = new PhysMat({
      color: 0xffffff,
      roughness: 0.18,
      metalness: 0.02,
      clearcoat: 1.0,
      clearcoatRoughness: 0.05,
      reflectivity: 0.55,
      envMapIntensity: 1.15,
      map: this.blendTex,
    });
    this.innerMat = new PhysMat({
      color: 0xEAF5F9,
      roughness: 0.2,
      metalness: 0.02,
      clearcoat: 0.9,
      clearcoatRoughness: 0.08,
      envMapIntensity: 1.0,
      side: THREE.DoubleSide,
    });

    const body = new THREE.Mesh(bodyGeo, this.outerMat);
    body.castShadow = true; body.receiveShadow = true;
    this.mug.add(body);

    // Inside
    const innerGeo = new THREE.CylinderGeometry(0.93, 0.93, 1.9, 64, 1, true);
    const inner = new THREE.Mesh(innerGeo, this.innerMat);
    inner.position.y = 0.05;
    this.mug.add(inner);
    const innerBottom = new THREE.Mesh(new THREE.CircleGeometry(0.93, 64), this.innerMat);
    innerBottom.rotation.x = -Math.PI / 2;
    innerBottom.position.y = -0.9;
    this.mug.add(innerBottom);

    // Handle
    const PhysMat2 = THREE.MeshPhysicalMaterial || THREE.MeshStandardMaterial;
    const handleMat = new PhysMat2({
      color: 0xffffff,
      roughness: 0.18,
      metalness: 0.02,
      clearcoat: 1.0,
      clearcoatRoughness: 0.05,
      envMapIntensity: 1.15,
    });
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.10, 24, 64, Math.PI * 1.1), handleMat);
    handle.position.set(1.05, 0.0, 0);
    handle.rotation.z = -Math.PI / 2;
    handle.castShadow = true;
    this.mug.add(handle);

    // Shadow plane
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), new THREE.ShadowMaterial({ opacity: 0.15 }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = -1.35;
    shadow.receiveShadow = true;
    this.scene.add(shadow);

    this.mug.rotation.x = 0.05;
    this.mug.position.y = -0.1;

    this.startTime = performance.now();
    this.animate();
  }

  designsList() {
    return [
      // 0: plain
      (ctx, w, h) => { ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0,0,w,h); },
      // 1: wordmark — compressed horizontally to compensate UV stretch
      (ctx, w, h) => {
        ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0,0,w,h);
        ctx.save();
        ctx.translate(w/2, h/2);
        ctx.scale(0.637, 1); // compress horizontally so text looks normal on the curved mug
        ctx.fillStyle = '#1a2733';
        ctx.font = '300 130px "Fraunces", serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('feito', 0, 82);
        ctx.fillText('em casa', 0, 212);
        ctx.strokeStyle = '#1E5F7E'; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(-100, 6); ctx.lineTo(100, 6); ctx.stroke();
        ctx.restore();
      },
      // 2: dots
      (ctx, w, h) => {
        ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0,0,w,h);
        ctx.fillStyle = '#1E5F7E';
        const step = 56;
        for (let y = step/2; y < h; y += step) {
          for (let x = step/2; x < w; x += step) {
            ctx.beginPath();
            ctx.arc(x + (Math.floor(y/step) % 2 ? step/2 : 0), y, 7, 0, Math.PI*2);
            ctx.fill();
          }
        }
      },
      // 3: stripes + heart
      (ctx, w, h) => {
        const grd = ctx.createLinearGradient(0,0,0,h);
        grd.addColorStop(0,'#FFFFFF'); grd.addColorStop(1,'#E8F4F8');
        ctx.fillStyle = grd; ctx.fillRect(0,0,w,h);
        ctx.strokeStyle = '#B8E5F0'; ctx.lineWidth = 14;
        for (let y = 60; y < h; y += 80) {
          ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke();
        }
        ctx.fillStyle = '#1E5F7E';
        const cx = w/2, cy = h/2;
        ctx.beginPath();
        ctx.moveTo(cx, cy+55);
        ctx.bezierCurveTo(cx+110, cy-25, cx+66, cy-110, cx, cy-44);
        ctx.bezierCurveTo(cx-66, cy-110, cx-110, cy-25, cx, cy+55);
        ctx.fill();
      },
    ];
  }

  onResize = () => {
    if (this.renderer && this.camera) {
      const w = window.innerWidth, h = window.innerHeight;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h, false);
    }
    // força recomputo do coverflow (spread mobile vs desktop)
    this.forceUpdate && this.forceUpdate();
  };

  // smoothstep helper
  smoothstep(t) { return t * t * (3 - 2 * t); }
  lerp(a, b, t) { return a + (b - a) * t; }

  animate = () => {
    this.rafId = requestAnimationFrame(this.animate);
    if (!this.renderer || !this.scene || !this.camera) return;
    const elapsed = (performance.now() - this.startTime) / 1000;

    // Determine current panel progress
    // scrollProgress is global 0..1 across (NUM_PANELS - 1) transitions
    const NP = this.NUM_PANELS;
    const total = (NP - 1);
    const sp = Math.max(0, Math.min(1, this.scrollProgress));
    const seg = sp * total;
    const i = Math.min(NP - 2, Math.floor(seg));
    const localT = seg - i; // 0..1 within current jump
    const eased = this.smoothstep(localT);

    const A = this.stops[i];
    const B = this.stops[i + 1];

    // Caneca fica praticamente centrada — quem se move agora é a câmera.
    // Mantemos um leve "respirar" vertical e escala suave por painel.
    this.mug.position.x = 0;
    this.mug.position.y = -0.1 + Math.sin(elapsed * 0.9) * 0.03;
    this.mug.position.z = 0;

    const scale = this.lerp(A.s, B.s, eased);
    this.mug.scale.setScalar(scale);

    // Rotação base da caneca: levemente girada para não ficar 100% frontal,
    // mas mantendo a logo visível na maior parte do percurso.
    this.mug.rotation.y = 0;
    this.mug.rotation.x = 0.05 + Math.sin(elapsed * 0.6) * 0.015;
    this.mug.rotation.z = 0;

    // -------- CÂMERA ORBITAL --------
    // Ao rolar a página a câmera dá uma volta parcial ao redor da caneca
    // e varia a altura, revelando ângulos diferentes (frente -> lado -> alça -> trás levemente).
    // Range: de -25° a +200° aprox. para mostrar bastante coisa.
    const minAngle = -Math.PI * 0.14;   // ~ -25°
    const maxAngle =  Math.PI * 1.10;   // ~ +198°
    const orbitAngle = this.lerp(minAngle, maxAngle, this.smoothstep(sp));
    // Altura da câmera oscila suavemente: começa um pouco acima, desce no meio, sobe no fim.
    const camY = 0.6 + Math.sin(sp * Math.PI) * -0.6 + Math.sin(elapsed * 0.5) * 0.04;
    // Distância respira de leve com o scroll para sensação cinematográfica.
    const camR = this.cameraRadius + Math.sin(sp * Math.PI) * 0.8;

    this.camera.position.x = Math.sin(orbitAngle) * camR;
    this.camera.position.z = Math.cos(orbitAngle) * camR;
    this.camera.position.y = camY;
    this.camera.lookAt(0, this.cameraTargetY + this.mug.position.y * 0.5, 0);

    // ---- TEXTURA travada no design 0 (logo) ----
    this.updateBlendedTexture(0, 0, 0);

    // Glow position via DOM (mantém efeito visual no fundo)
    if (this.glowRef.current) {
      const xPct = 50 + Math.sin(orbitAngle) * 22;
      const yPct = 50 - Math.sin(sp * Math.PI) * 6;
      this.glowRef.current.style.transition = 'none';
      this.glowRef.current.style.left = xPct + '%';
      this.glowRef.current.style.top = yPct + '%';
    }

    // Update active panel state for progress rail
    const activeIdx = Math.round(sp * total);
    if (activeIdx !== this.state.activePanel) {
      this.setState({ activePanel: activeIdx });
    }

    this.renderer.render(this.scene, this.camera);
  };

  // ---------- SCROLL ----------
  initScroll() {
    this.onScroll = () => {
      const journey = document.getElementById('fc-journey');
      if (!journey) return;
      const rect = journey.getBoundingClientRect();
      const totalScrollable = journey.offsetHeight - window.innerHeight;
      if (totalScrollable <= 0) return;
      const scrolled = Math.max(0, -rect.top);
      const t = Math.min(1, Math.max(0, scrolled / totalScrollable));
      this.scrollProgress = t;

      // Fade out the 3D stage once we're past the journey
      const stage = document.getElementById('fc-stage');
      if (stage) {
        const sobre = document.getElementById('sobre');
        if (sobre) {
          const sr = sobre.getBoundingClientRect();
          const fadeStart = window.innerHeight; // start fade when sobre still below
          const fadeEnd = window.innerHeight * 0.4;
          let opacity = 1;
          if (sr.top < fadeStart) {
            opacity = Math.max(0, Math.min(1, (sr.top - fadeEnd) / (fadeStart - fadeEnd)));
          }
          stage.style.opacity = opacity;
        }
      }
    };
    window.addEventListener('scroll', this.onScroll, { passive: true });
    this.onScroll();
  }

  initObservers() {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add('fc-in');
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.15 });
    setTimeout(() => {
      document.querySelectorAll('.fc-reveal').forEach((el, i) => {
        el.style.animationDelay = (i % 3) * 0.12 + 's';
        io.observe(el);
      });
    }, 100);
  }

  // ---------- FORM ----------
  onChange = (e) => {
    const { name, value } = e.target;
    this.setState(s => ({ formData: { ...s.formData, [name]: value }, formError: '', formSuccess: false }));
  };

  onSubmit = (e) => {
    e.preventDefault();
    const { name, email, message } = this.state.formData;
    if (!name.trim() || !email.trim() || !message.trim()) {
      this.setState({ formError: 'Por favor, preencha todos os campos.', formSuccess: false });
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      this.setState({ formError: 'Por favor, informe um email válido.', formSuccess: false });
      return;
    }
    this.setState({ formError: '', formSuccess: true, formData: { name: '', email: '', message: '' } });
  };

  // ---------- LOGO TEXTURE ----------
  // Lathe UV wraps full 2π circumference horizontally; height vertically.
  // canvas 1024x512 → 163 px/unit horizontal vs 256 px/unit vertical on the mug.
  // To draw a SQUARE-looking print: drawW = drawH × (163/256) ≈ drawH × 0.637.
  loadLogoIntoFirstTexture() {
    const url = (window.__resources && window.__resources.logoImg) || './assets/logo.png';
    const img = new Image();
    img.crossOrigin = 'anonymous';
    this.logoImg = img;
    img.onload = () => {
      // Update SOURCE canvas 0 (used by the journey blend)
      [this.sourceCanvases[0]].forEach((c) => {
        if (!c) return;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, c.width, c.height);
        // Square-on-mug print: height ~ 60% of canvas height, width compressed to compensate UV stretch.
        const targetH = Math.round(c.height * 0.62);
        const targetW = Math.round(targetH * 0.637);
        const lx = (c.width - targetW) / 2;
        const ly = (c.height - targetH) / 2;
        ctx.drawImage(img, lx, ly, targetW, targetH);
      });
      // Refresh blend canvas with the now-logo-stamped source 0
      const NP = this.NUM_PANELS;
      const total = (NP - 1);
      const sp = Math.max(0, Math.min(1, this.scrollProgress));
      const seg = sp * total;
      const i = Math.min(NP - 2, Math.floor(seg));
      const localT = seg - i;
      const eased = this.smoothstep(localT);
      this.updateBlendedTexture(i, i + 1, eased);
    };
    img.onerror = () => {};
    img.src = url;
  }

  // ---------- (interactive scene removed) ----------



  // ---------- CAROUSEL ----------
  startCarouselAutoRotate() {
    if (this.carouselAutoTimer) clearInterval(this.carouselAutoTimer);
    this.carouselAutoTimer = setInterval(() => {
      if (this.carouselDrag) return;
      this.shiftCarousel(1);
    }, 4200);
  }
  pauseCarouselAuto() {
    if (this.carouselAutoTimer) { clearInterval(this.carouselAutoTimer); this.carouselAutoTimer = null; }
  }
  resumeCarouselAuto() {
    if (!this.carouselAutoTimer) this.startCarouselAutoRotate();
  }
  shiftCarousel(delta) {
    const total = this.carouselSource().length;
    const next = ((this.state.carouselIndex + delta) % total + total) % total;
    this.setState({ carouselIndex: next });
  }
  goToCarousel = (idx) => {
    this.pauseCarouselAuto();
    this.setState({ carouselIndex: idx }, () => this.resumeCarouselAuto());
  };
  onCarouselNext = () => {
    this.pauseCarouselAuto();
    this.shiftCarousel(1);
    this.resumeCarouselAuto();
  };
  onCarouselPrev = () => {
    this.pauseCarouselAuto();
    this.shiftCarousel(-1);
    this.resumeCarouselAuto();
  };
  onCarouselDragStart = (e) => {
    this.pauseCarouselAuto();
    const x = e.touches ? e.touches[0].clientX : e.clientX;
    this.carouselDrag = { startX: x, deltaX: 0 };
    window.addEventListener('mousemove', this.onCarouselDragMove);
    window.addEventListener('mouseup', this.onCarouselDragEnd);
    window.addEventListener('touchmove', this.onCarouselDragMove, { passive: true });
    window.addEventListener('touchend', this.onCarouselDragEnd);
  };
  onCarouselDragMove = (e) => {
    if (!this.carouselDrag) return;
    const x = e.touches ? e.touches[0].clientX : e.clientX;
    this.carouselDrag.deltaX = x - this.carouselDrag.startX;
  };
  onCarouselDragEnd = () => {
    if (!this.carouselDrag) return;
    const dx = this.carouselDrag.deltaX;
    this.carouselDrag = null;
    window.removeEventListener('mousemove', this.onCarouselDragMove);
    window.removeEventListener('mouseup', this.onCarouselDragEnd);
    window.removeEventListener('touchmove', this.onCarouselDragMove);
    window.removeEventListener('touchend', this.onCarouselDragEnd);
    const threshold = 50;
    if (dx > threshold) this.shiftCarousel(-1);
    else if (dx < -threshold) this.shiftCarousel(1);
    this.resumeCarouselAuto();
  };
  carouselSource() {
    return [
      {
        tag: 'Caneca',
        title: 'Caneca cerâmica',
        desc: 'Sua arte vitrificada, segura para microondas. Pequenos lotes, acabamento à mão.',
        image: (window.__resources && window.__resources.carousel1) || 'https://images.unsplash.com/photo-1514228742587-6b1558fcca3d?w=800&q=80&auto=format&fit=crop',
      },
      {
        tag: 'Camiseta',
        title: 'Camiseta personalizada',
        desc: 'Algodão 100% brasileiro com estampa em DTF de longa durabilidade.',
        image: (window.__resources && window.__resources.carousel2) || 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=800&q=80&auto=format&fit=crop',
      },
      {
        tag: 'Garrafa',
        title: 'Garrafa esportiva',
        desc: 'Squeeze de corrida com bico anti-vazamento e a sua arte aplicada — leve, resistente e livre de BPA.',
        image: (window.__resources && window.__resources.carousel3) || 'https://images.unsplash.com/photo-1602143407151-7111542de6e8?w=800&q=80&auto=format&fit=crop',
      },
    ];
  }

  // ---------- RENDER VALUES ----------
  renderVals() {
    const panels = [
      {
        index: 0,
        side: 'center',
        eyebrow: 'Canecas Personalizadas',
        titleHTML: { __html: 'Sua história,<br>em cerâmica.' },
        desc: 'Cada caneca é feita à mão, com a sua arte, sua frase, seu momento. Pequenos rituais que começam todas as manhãs.',
        alignStyle: 'margin: 0 auto; text-align: center;',
        showCTA: false,
      },
      {
        index: 1,
        side: 'left',
        eyebrow: '01 — Sua marca',
        titleHTML: { __html: 'O nome.<br>A frase.<br>A história.' },
        desc: 'Trazemos seu logo, sua poesia ou aquele "bom dia, amor" que ninguém mais entende. Tipografia escolhida com você.',
        alignStyle: 'margin-right: auto;',
        showCTA: false,
      },
      {
        index: 2,
        side: 'right',
        eyebrow: '02 — Sua arte',
        titleHTML: { __html: 'Padrões,<br>ilustrações,<br>memórias.' },
        desc: 'Aquela foto da viagem, o desenho do seu filho, um padrão exclusivo. Aplicamos com técnica vitrificada, segura para microondas.',
        alignStyle: 'margin-left: auto; text-align: right;',
        showCTA: false,
      },
      {
        index: 3,
        side: 'center',
        eyebrow: '03 — Sua caneca',
        titleHTML: { __html: 'Pronta para<br>o seu café.' },
        desc: 'Em até 7 dias na sua porta. Pequenos lotes, com embalagem cuidadosa e um cartão escrito à mão.',
        alignStyle: 'margin: 0 auto; text-align: center;',
        showCTA: true,
      },
    ];

    const progressDots = [];
    for (let i = 0; i < this.NUM_PANELS; i++) {
      const active = i === this.state.activePanel;
      progressDots.push({
        num: String(i + 1).padStart(2, '0'),
        color: active ? '#1E5F7E' : '#B8E5F0',
        barColor: active ? '#1E5F7E' : '#E8F4F8',
      });
    }

    // ---- Carousel coverflow transforms ----
    const carouselSrc = this.carouselSource();
    const total = carouselSrc.length;
    const active = this.state.carouselIndex;
    const isMobile = (typeof window !== 'undefined') && window.innerWidth <= 720;
    const spreadX = isMobile ? 150 : 260;
    const tzStep  = isMobile ? 110 : 160;
    const rotStep = isMobile ? 26  : 34;
    const carouselItems = carouselSrc.map((item, i) => {
      let rel = i - active;
      if (rel > total / 2) rel -= total;
      if (rel < -total / 2) rel += total;
      const abs = Math.abs(rel);
      const x = rel * spreadX;
      const rotY = -rel * rotStep;
      const tz = -abs * tzStep;
      const scale = abs === 0 ? 1 : (abs === 1 ? 0.88 : 0.75);
      const opacity = abs <= 2 ? (abs === 0 ? 1 : (abs === 1 ? 0.88 : 0.45)) : 0;
      const z = 100 - abs;
      return {
        ...item,
        transform: `translateX(${x}px) translateZ(${tz}px) rotateY(${rotY}deg) scale(${scale})`,
        opacity,
        z,
        pointerEvents: abs <= 2 ? 'auto' : 'none',
        onClick: rel === 0 ? null : () => this.goToCarousel(i),
      };
    });

    const carouselDots = carouselSrc.map((_, i) => ({
      label: i + 1,
      bg: i === active ? '#1E5F7E' : '#E8F4F8',
      w: i === active ? '28px' : '6px',
      onClick: () => this.goToCarousel(i),
    }));

    const features = [
      {
        title: 'Feito à mão',
        desc: 'Cada peça é pintada e finalizada individualmente em nosso ateliê — pequenas imperfeições fazem parte da história.',
        iconHTML: { __html: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M7 2v11a3 3 0 0 0 3 3h0a3 3 0 0 0 3-3V2"/><path d="M7 22V12"/><path d="M17 22V8a3 3 0 0 0-3-3"/></svg>' },
      },
      {
        title: 'Arte personalizada',
        desc: 'Sua foto, sua frase, seu desenho. Trabalhamos lado a lado com você para chegar à caneca dos seus sonhos.',
        iconHTML: { __html: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><circle cx="11" cy="11" r="2"/></svg>' },
      },
      {
        title: 'Cerâmica nacional',
        desc: 'Usamos cerâmica brasileira de alta qualidade, segura para microondas e lava-louças. Para durar muitas manhãs.',
        iconHTML: { __html: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M5 8h11v10a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V8z"/><path d="M16 11h2a3 3 0 0 1 0 6h-2"/><path d="M8 2v3M11 2v3"/></svg>' },
      },
    ];

    return {
      mugCanvas: this.mugCanvasRef,
      glowRef: this.glowRef,
      panels,
      progressDots,
      features,
      carouselItems,
      carouselDots,
      onCarouselNext: this.onCarouselNext,
      onCarouselPrev: this.onCarouselPrev,
      onCarouselDragStart: this.onCarouselDragStart,
      formData: this.state.formData,
      formError: this.state.formError,
      formSuccess: this.state.formSuccess,
      onChange: this.onChange,
      onSubmit: this.onSubmit,
    };
  }
}