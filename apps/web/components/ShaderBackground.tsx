'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';

/**
 * Instrument readout — a calm, distinctive, site-wide WebGL background.
 *
 * Bunsen is a measurement tool: run an agent, score it, read the result. This
 * renders that as a quiet oscilloscope / sensor display — a faint graph-paper
 * grid, a soft warm signal traced across the lower third, and a slow scanline
 * sweep that flares the grid and signal as it passes (a phosphor refresh). The
 * pointer is a probe: it lights up the grid cells and signal it hovers near.
 * The whole field fades toward flat black as you scroll so it never competes
 * with the content below the hero.
 *
 * One full-screen fragment shader. Zero dependencies. Honors
 * `prefers-reduced-motion` (one static frame, no animation) and degrades to
 * nothing if WebGL (or the derivatives extension) is unavailable — the page
 * keeps its solid `--bg`.
 */

const DPR_CAP = 2;
const MAX_DIM = 3000;

const VERT = `
attribute vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const FRAG = `
#extension GL_OES_standard_derivatives : enable
precision highp float;

uniform vec2 uResolution;
uniform float uAspect;       // width / height
uniform float uTime;
uniform vec2 uMouse;         // pointer, normalized [0,1], y-up
uniform float uMouseAmt;     // 0..1 how present the pointer is
uniform float uGridFade;     // grid brightness — fades gently, stays a texture
uniform float uSignalFade;   // signal brightness — a hero accent, recedes faster

// Palette — matches app/globals.css :root tokens.
const vec3 BG      = vec3(0.039, 0.039, 0.059); // #0a0a0f
const vec3 GRIDCOL = vec3(0.52, 0.42, 0.34);    // dim warm grey graticule
const vec3 ORANGE  = vec3(0.976, 0.451, 0.086); // #f97316 --accent
const vec3 AMBER   = vec3(0.961, 0.620, 0.043); // #f59e0b --amber
const vec3 GOLD    = vec3(0.984, 0.749, 0.141); // #fbbf24 --gold
const vec3 PROBE   = vec3(1.0, 0.72, 0.38);     // warm probe glow

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// Antialiased grid: ~1px lines at any resolution via screen-space derivatives.
// Returns 1 on a line, 0 between. 'cells' = number of cells per unit height.
float gridMask(vec2 sp, float cells) {
  vec2 g = sp * cells;
  vec2 gw = fwidth(g);
  vec2 gr = abs(fract(g - 0.5) - 0.5) / max(gw, 1e-5);
  return 1.0 - min(min(gr.x, gr.y), 1.0);
}

// A lively instrument waveform: layered harmonics under a slow activity
// envelope, so the trace has calm stretches and busier bursts.
float waveform(float x, float t, float seed) {
  float w = sin(x * 3.5 + t * 0.55 + seed) * 0.55;
  w += sin(x * 8.0 - t * 0.40 + seed * 1.7) * 0.26;
  w += sin(x * 16.0 + t * 0.80 + seed * 2.3) * 0.10;
  float env = 0.6 + 0.4 * sin(x * 1.1 - t * 0.22 + seed * 0.7);
  return w * env;
}

// One signal channel: a glowing trace whose peaks run hotter (amber → gold →
// white), which the sweep beam writes brightest, leaving a phosphor tail.
vec3 channel(vec2 sp, float baseline, float amp, float seed, float t, float sweepX) {
  float w = waveform(sp.x, t, seed);
  float d = abs(sp.y - (baseline + w * amp));
  float glow = exp(-pow(d / 0.0055, 2.0)) + exp(-pow(d / 0.021, 2.0)) * 0.35;

  // Beam writes the trace: bright at the sweep, with a decaying tail behind it.
  float beam = exp(-pow((sp.x - sweepX) / 0.018, 2.0));
  float phos = exp(-max(sweepX - sp.x, 0.0) * 3.5);
  glow *= 1.0 + beam * 2.5 + phos * 0.6;

  float hot = clamp(abs(w), 0.0, 1.0);
  vec3 c = mix(AMBER, GOLD, hot);
  c = mix(c, vec3(1.0, 0.92, 0.72), smoothstep(0.8, 1.2, abs(w)) * 0.6);
  return c * glow;
}

void main() {
  // Aspect-correct coordinates: x in [0, aspect], y in [0, 1] (GL y-up).
  vec2 sp = gl_FragCoord.xy / uResolution.y;
  float t = uTime;
  vec2 mid = vec2(uAspect * 0.5, 0.5);
  float gf = uGridFade;
  float sf = uSignalFade;

  // Pointer probe.
  vec2 mp = vec2(uMouse.x * uAspect, uMouse.y);
  float dM = length(sp - mp);
  float probe = exp(-dM * dM / (0.105 * 0.105)) * uMouseAmt;

  // Graticule: minor cells with brighter major lines every fourth.
  float minor = gridMask(sp, 16.0);
  float major = gridMask(sp, 4.0);
  float gridB = minor * 0.045 + major * 0.085;

  // Each channel has its own beam — different speeds and start points — so the
  // bright write-points drift in and out of phase across the traces.
  float beam1 = fract(t * 0.049) * uAspect;
  float beam2 = fract(t * 0.036 + 0.10) * uAspect;

  // Grid flares wherever a beam crosses it (a band per beam).
  float sw = exp(-pow((sp.x - beam1) / 0.085, 2.0)) + exp(-pow((sp.x - beam2) / 0.085, 2.0));
  sw = min(sw, 1.0);

  vec3 col = BG;

  // Grid persists as a texture down the page; flares as a beam crosses it.
  col += GRIDCOL * gridB * (1.0 + sw * 1.3) * gf;

  // Signal channels in the lower third — lively, beam-written, hot-tipped.
  col += channel(sp, 0.19, 0.060, 0.0, t, beam1) * 0.55 * sf;
  col += channel(sp, 0.40, 0.040, 1.7, t, beam2) * 0.42 * sf;
  col += ORANGE * sw * 0.018 * sf;              // faint sweep wash

  // Probe lights up the readout it hovers near.
  col += PROBE * probe * 0.16 * gf;
  col += GRIDCOL * (minor + major) * probe * 0.6 * gf;

  // Soft vignette to settle the edges.
  vec2 cc = sp - mid;
  col = mix(BG, col, clamp(1.0 - 0.22 * dot(cc, cc), 0.0, 1.0));

  // Dither to kill banding on the dark gradients.
  col += (hash(gl_FragCoord.xy + fract(uTime)) - 0.5) * 0.010;

  gl_FragColor = vec4(col, 1.0);
}
`;

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    // Surface compile errors during development; fail silently in prod.
    if (process.env.NODE_ENV !== 'production') {
      console.error('ShaderBackground:', gl.getShaderInfoLog(sh));
    }
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

export function ShaderBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pathname = usePathname();
  // Per-route brightness ceiling. The hero can carry the full effect; reading
  // surfaces like /docs get a gentler wash so it never competes with body text.
  const ceilingRef = useRef(1);
  // Set by the render effect (reduced-motion only) so a route change can repaint
  // the single static frame at the new ceiling without restarting WebGL.
  const redrawRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    ceilingRef.current = pathname?.startsWith('/docs') ? 0.5 : 1;
    redrawRef.current?.();
  }, [pathname]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl =
      canvas.getContext('webgl', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: 'low-power',
      }) || (canvas.getContext('experimental-webgl') as WebGLRenderingContext | null);
    if (!gl) return; // No WebGL — page keeps its solid --bg.

    // Crisp grid lines need screen-space derivatives (core in WebGL2, an
    // extension in WebGL1). If absent, the shader won't compile and we bail.
    gl.getExtension('OES_standard_derivatives');

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return;

    const prog = gl.createProgram();
    if (!prog) return;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    gl.useProgram(prog);

    // Full-screen triangle (covers clip space; cheaper than a quad).
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const uResolution = gl.getUniformLocation(prog, 'uResolution');
    const uAspect = gl.getUniformLocation(prog, 'uAspect');
    const uTime = gl.getUniformLocation(prog, 'uTime');
    const uMouse = gl.getUniformLocation(prog, 'uMouse');
    const uMouseAmt = gl.getUniformLocation(prog, 'uMouseAmt');
    const uGridFade = gl.getUniformLocation(prog, 'uGridFade');
    const uSignalFade = gl.getUniformLocation(prog, 'uSignalFade');

    let bufW = 1;
    let bufH = 1;

    const resize = () => {
      const cssW = window.innerWidth;
      const cssH = window.innerHeight;
      let scale = Math.min(DPR_CAP, window.devicePixelRatio || 1);
      const maxDim = Math.max(cssW, cssH) * scale;
      if (maxDim > MAX_DIM) scale *= MAX_DIM / maxDim;
      bufW = Math.max(1, Math.round(cssW * scale));
      bufH = Math.max(1, Math.round(cssH * scale));
      canvas.width = bufW;
      canvas.height = bufH;
      gl.viewport(0, 0, bufW, bufH);
      gl.uniform2f(uResolution, bufW, bufH);
      gl.uniform1f(uAspect, bufW / bufH);
    };
    resize();

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Pointer + scroll state, all kept in resize-proof normalized space.
    const target = { x: 0.5, y: 0.5 }; // y already flipped to GL orientation
    const eased = { x: 0.5, y: 0.5 };
    let mouseAmt = 0;
    let gridF = 1;
    let sigF = 1;
    let lastMove = -10000;

    const onPointerMove = (e: PointerEvent) => {
      target.x = e.clientX / window.innerWidth;
      target.y = 1 - e.clientY / window.innerHeight;
      lastMove = performance.now();
    };
    const onPointerLeave = () => {
      lastMove = -10000;
    };

    const computeFades = () => {
      const vh = window.innerHeight || 1;
      const fade = Math.min(1, Math.max(0, 1 - window.scrollY / (vh * 1.3)));
      const ceil = ceilingRef.current;
      // Grid stays present as a background texture all the way down; the signal
      // is a hero accent that recedes below the fold. The per-route ceiling
      // tones both down on reading surfaces.
      return { grid: (0.55 + 0.45 * fade) * ceil, signal: (0.12 + 0.88 * fade) * ceil };
    };
    {
      const f = computeFades();
      gridF = f.grid;
      sigF = f.signal;
    }

    let raf = 0;
    const start = performance.now();

    const draw = (nowMs: number) => {
      const time = (nowMs - start) / 1000;

      // Ease pointer follow + presence.
      eased.x += (target.x - eased.x) * 0.06;
      eased.y += (target.y - eased.y) * 0.06;
      const amtTarget = nowMs - lastMove < 1800 ? 1 : 0;
      mouseAmt += (amtTarget - mouseAmt) * 0.05;

      // Ease scroll-driven fades (grid + signal independently).
      const f = computeFades();
      gridF += (f.grid - gridF) * 0.08;
      sigF += (f.signal - sigF) * 0.08;

      gl.uniform1f(uTime, time);
      gl.uniform2f(uMouse, eased.x, eased.y);
      gl.uniform1f(uMouseAmt, mouseAmt);
      gl.uniform1f(uGridFade, gridF);
      gl.uniform1f(uSignalFade, sigF);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      raf = requestAnimationFrame(draw);
    };

    const drawStatic = () => {
      const f = computeFades();
      gl.uniform1f(uTime, 6.0);
      gl.uniform2f(uMouse, 0.5, 0.5);
      gl.uniform1f(uMouseAmt, 0);
      gl.uniform1f(uGridFade, f.grid);
      gl.uniform1f(uSignalFade, f.signal);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const onResize = () => {
      resize();
      if (reduceMotion) drawStatic();
    };

    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        raf = 0;
      } else if (!reduceMotion && !raf) {
        raf = requestAnimationFrame(draw);
      }
    };

    const onContextLost = (e: Event) => {
      e.preventDefault();
      cancelAnimationFrame(raf);
      raf = 0;
    };

    window.addEventListener('resize', onResize);
    canvas.addEventListener('webglcontextlost', onContextLost);

    if (reduceMotion) {
      redrawRef.current = drawStatic;
      drawStatic();
      // Re-fade on scroll only (no animation loop).
      const onScroll = () => drawStatic();
      window.addEventListener('scroll', onScroll, { passive: true });
      return () => {
        redrawRef.current = null;
        window.removeEventListener('resize', onResize);
        window.removeEventListener('scroll', onScroll);
        canvas.removeEventListener('webglcontextlost', onContextLost);
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      };
    }

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerleave', onPointerLeave, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerleave', onPointerLeave);
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, []);

  return <canvas ref={canvasRef} className="shader-bg" aria-hidden="true" />;
}
